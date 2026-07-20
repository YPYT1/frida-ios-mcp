/**
 * 四向滑动 + 任意路径滑动（贝塞尔曲线，符合人体动作）。
 */
import ObjC from 'frida-objc-bridge';
import { getKeyWindow } from '../shared_js/api.js';
import { runTouchSequence } from '../shared_js/touch_injector.js';
import { bezierPath } from '../shared_js/bezier.js';

function resolveEndpoints(direction, w, h) {
    switch (direction) {
        case 'up':    return [w / 2,     h * 0.75, w / 2,     h * 0.05];
        case 'down':  return [w / 2,     h * 0.22, w / 2,     h * 0.78];
        case 'left':  return [w * 0.78,  h / 2,    w * 0.22,  h / 2];
        case 'right': return [w * 0.22,  h / 2,    w * 0.78,  h / 2];
        default: throw new Error('Unknown direction: ' + direction);
    }
}

export function swipe(direction, duration) {
    return new Promise(function (resolve, reject) {
        ObjC.schedule(ObjC.mainQueue, function () {
            try {
                const window = getKeyWindow();
                if (window === null) { reject(new Error('No UIWindow available')); return; }
                const b = window.bounds();
                const w = b[1][0], h = b[1][1];
                const [x0, y0, x1, y1] = resolveEndpoints(direction, w, h);
                const steps = Math.max(20, Math.floor((duration || 0.6) * 60));
                const path = bezierPath(x0, y0, x1, y1, steps);
                send({ type: 'swipe', direction, duration, window: [w, h], steps });
                runTouchSequence(window, path).then(resolve, reject);
            } catch (e) {
                reject(new Error(e.message || String(e)));
            }
        });
    });
}

/**
 * 任意起止点的贝塞尔滑动，供上层组装特殊滑动（如评论区下拉关闭）。
 * @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1
 * @param {number} duration
 */
export function swipePath(x0, y0, x1, y1, duration) {
    return new Promise(function (resolve, reject) {
        ObjC.schedule(ObjC.mainQueue, function () {
            try {
                const window = getKeyWindow();
                if (window === null) { reject(new Error('No UIWindow available')); return; }
                const steps = Math.max(20, Math.floor((duration || 0.6) * 60));
                const path = bezierPath(x0, y0, x1, y1, steps);
                runTouchSequence(window, path).then(resolve, reject);
            } catch (e) {
                reject(new Error(e.message || String(e)));
            }
        });
    });
}
