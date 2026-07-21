/**
 * 触摸注入器：将一串路径点通过 CADisplayLink 在主线程逐帧派发为真实 UITouch + IOHIDEvent 事件。
 *
 * 用法：
 *   const injector = createInjector().alloc().init();
 *   const priv = ObjC.getBoundData(injector);
 *   priv.window  = targetWindow;
 *   priv.pending = [[x0,y0], [x1,y1], ...];      // 中间过程点
 *   priv.pending.push(CGPointZero);              // 追加一个"哨兵点"触发 Ended（复用 previous）
 *   priv.onComplete = () => { injector.release(); };
 */
import ObjC from 'frida-objc-bridge';
import { getApi } from './api.js';
import {
    UITouchPhaseBegan, UITouchPhaseMoved,
    UITouchPhaseStationary, UITouchPhaseEnded,
    UITOUCH_FLAG_IS_FIRST_TOUCH_FOR_VIEW, UITOUCH_FLAG_IS_TAP,
    kIOHIDDigitizerEventRange, kIOHIDDigitizerEventTouch, kIOHIDDigitizerEventPosition,
} from './constants.js';

function setTouchFlag(touch, flag, on) {
    const flags = touch.$ivars['_touchFlags'];
    const nf = [...flags];
    if (on) nf[0] |= flag; else nf[0] &= ~flag;
    touch.$ivars['_touchFlags'] = nf;
}

let _InjectorClass = null;

/**
 * 返回（并懒创建）注入器 ObjC 类。
 */
export function createInjector() {
    if (_InjectorClass !== null) return _InjectorClass;

    _InjectorClass = ObjC.registerClass({
        name: 'IFCTouchInjector_' + Date.now(),
        methods: {
            '- init': function () {
                const self = this.super.init();
                const api = getApi();
                if (self !== null) {
                    const dl = api.CADisplayLink.displayLinkWithTarget_selector_(
                        self, ObjC.selector('dispatchTouch:'));
                    ObjC.bind(self, {
                        displayLink: dl,
                        window:      null,
                        touch:       null,
                        pending:     [],
                        previous:    null,
                        // After spawn+resume, UIKit may not expose _touchesEvent for a few frames.
                        nullEventRetries: 0,
                        onComplete:  function () {},
                        onError:     function () {},
                    });
                    dl.addToRunLoop_forMode_(
                        api.NSRunLoop.mainRunLoop(),
                        api.NSRunLoopCommonModes);
                    dl.setPaused_(false);
                }
                return self;
            },
            '- dealloc': function () {
                ObjC.unbind(this.self);
                this.super.dealloc();
            },
            '- dispatchTouch:': {
                retType: 'void', argTypes: ['object'],
                implementation: function (_sender) {
                    const priv = this.data;
                    try {

                        if (priv.pending.length === 0) {
                            if (priv.displayLink !== null) {
                                priv.displayLink.invalidate();
                                priv.displayLink = null;
                            }
                            priv.onComplete();
                            return;
                        }

                        const api = getApi();
                        let touch, phase;
                        let point = priv.pending.shift();
                        const isLast = priv.pending.length === 0;

                        if (priv.touch === null) {
                            // === 第一帧：构造 UITouch，相位 Began ===
                            touch = api.UITouch.alloc().init();
                            priv.touch = touch;
                            touch.setTapCount_(1);
                            setTouchFlag(touch, UITOUCH_FLAG_IS_TAP, true);
                            phase = UITouchPhaseBegan;
                            touch.setPhase_(phase);
                            touch.setWindow_(priv.window);
                            touch['- _setLocationInWindow:resetPrevious:']
                                .call(touch, point, true);
                            touch.setView_(priv.window.hitTest_withEvent_(point, NULL));
                            setTouchFlag(touch, UITOUCH_FLAG_IS_FIRST_TOUCH_FOR_VIEW, true);
                        } else {
                            // === 后续帧：更新位置，相位 Moved/Stationary，最后一帧 Ended ===
                            touch = priv.touch;
                            if (isLast) {
                                touch['- _setLocationInWindow:resetPrevious:']
                                    .call(touch, priv.previous, false);
                                phase = UITouchPhaseEnded;
                                point = priv.previous;
                            } else {
                                touch['- _setLocationInWindow:resetPrevious:']
                                    .call(touch, point, false);
                                phase = api.CGPointEqualToPoint(point, priv.previous)
                                    ? UITouchPhaseStationary
                                    : UITouchPhaseMoved;
                            }
                            touch.setPhase_(phase);
                        }

                        const app   = api.UIApplication.sharedApplication();
                        const event = app['- _touchesEvent'].call(app);
                        if (event === null || event.handle.isNull()) {
                            // Soft retry on next CADisplayLink frame (attach-permanent-null still fails after budget).
                            priv.nullEventRetries = (priv.nullEventRetries || 0) + 1;
                            if (priv.nullEventRetries > 45) {
                                throw new Error('UIApplication._touchesEvent returned null');
                            }
                            priv.pending.unshift(point);
                            if (phase === UITouchPhaseBegan && priv.touch !== null) {
                                try { priv.touch.release(); } catch (_) {}
                                priv.touch = null;
                            }
                            return;
                        }
                        priv.nullEventRetries = 0;
                        event['- _clearTouches'].call(event);

                        const abs = api.mach_absolute_time();
                        const timestamp = [
                            abs.shr(32).toNumber(),
                            abs.and(0xffffffff).toNumber(),
                        ];

                        touch.setTimestamp_(api.CFGetSystemUptime());

                        const eventMask = (phase === UITouchPhaseMoved)
                            ? kIOHIDDigitizerEventPosition
                            : (kIOHIDDigitizerEventRange | kIOHIDDigitizerEventTouch);
                        const rangeAndTouch = (phase !== UITouchPhaseEnded) ? 1 : 0;

                        const hidEvent = api.IOHIDEventCreateDigitizerFingerEvent(
                            api.kCFAllocatorDefault,
                            timestamp,
                            0, 2,
                            eventMask,
                            point[0], point[1],
                            0, 0, 0,
                            rangeAndTouch, rangeAndTouch,
                            0);

                        if ('- _setHidEvent:' in touch) {
                            touch['- _setHidEvent:'].call(touch, hidEvent);
                        }
                        event['- _setHIDEvent:'].call(event, hidEvent);
                        event['- _addTouch:forDelayedDelivery:'].call(event, touch, false);

                        const pool = api.NSAutoreleasePool.alloc().init();
                        try {
                            app.sendEvent_(event);
                        } finally {
                            pool.release();
                            api.CFRelease(hidEvent);
                            priv.previous = point;
                            if (isLast) {
                                touch.release();
                                priv.touch = null;
                            }
                        }
                    } catch (e) {
                        try {
                            if (priv.displayLink !== null) {
                                priv.displayLink.invalidate();
                                priv.displayLink = null;
                            }
                            if (priv.touch !== null) {
                                priv.touch.release();
                                priv.touch = null;
                            }
                            priv.pending = [];
                        } catch (_) {}
                        priv.onError(e);
                    }
                },
            },
        },
    });
    return _InjectorClass;
}

/**
 * 把一串路径点派发为一次完整的触摸过程（Began→Moved...→Ended）。
 * @param {ObjC.Object} window 目标 UIWindow
 * @param {Array<[number, number]>} points 窗口坐标路径点
 * @returns {Promise<{ok:boolean, steps:number}>}
 */
export function runTouchSequence(window, points) {
    return new Promise(function (resolve, reject) {
        try {
            const api = getApi();
            const Injector = createInjector();
            const injector = Injector.alloc().init();
            const priv = ObjC.getBoundData(injector);
            let settled = false;
            let timer = null;
            const finish = function (value) {
                if (settled) return;
                settled = true;
                if (timer !== null) clearTimeout(timer);
                injector.release();
                resolve(value);
            };
            const fail = function (e) {
                if (settled) return;
                settled = true;
                if (timer !== null) clearTimeout(timer);
                try {
                    if (priv.displayLink !== null) {
                        priv.displayLink.invalidate();
                        priv.displayLink = null;
                    }
                    if (priv.touch !== null) {
                        priv.touch.release();
                        priv.touch = null;
                    }
                    priv.pending = [];
                } catch (_) {}
                injector.release();
                reject(new Error(e.message || String(e)));
            };
            priv.window = window;
            for (const p of points) priv.pending.push(p);
            // 末尾追加一个哨兵，触发 Ended（注入器会复用 previous 作为真实最终位置）
            priv.pending.push(api.CGPointZero);
            priv.onComplete = function () {
                finish({ ok: true, steps: points.length });
            };
            priv.onError = fail;
            timer = setTimeout(function () {
                fail(new Error('touch sequence timeout'));
            }, Math.max(3000, points.length * 120));
        } catch (e) {
            reject(new Error(e.message || String(e)));
        }
    });
}
