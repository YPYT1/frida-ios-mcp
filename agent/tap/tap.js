/**
 * 单点：在 (x, y) 位置派发一次 Began→Ended 的触摸（3 帧内完成）。
 */
import ObjC from 'frida-objc-bridge';
import { getKeyWindow } from '../shared_js/api.js';
import { runTouchSequence } from '../shared_js/touch_injector.js';

export function tap(x, y) {
    return new Promise(function (resolve, reject) {
        ObjC.schedule(ObjC.mainQueue, function () {
            try {
                const window = getKeyWindow();
                if (window === null) {
                    reject(new Error('No UIWindow available'));
                    return;
                }
                // 3 个采样点 + 1 个哨兵 ⇒ Began, Stationary, Stationary, Ended
                const pts = [[x, y], [x, y], [x, y]];
                runTouchSequence(window, pts).then(resolve, reject);
            } catch (e) {
                reject(new Error(e.message || String(e)));
            }
        });
    });
}
