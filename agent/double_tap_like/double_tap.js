/**
 * 双击点赞：两次 Began→Ended 连发，两次之间间隔 gapMs（默认 140ms），整体 < 300ms。
 * 位置允许相对屏幕中心有小幅偏移，模拟真人用拇指点屏。
 */
import ObjC from 'frida-objc-bridge';
import { getKeyWindow } from '../shared_js/api.js';
import { runTouchSequence } from '../shared_js/touch_injector.js';

function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/**
 * @param {number|null} x 屏幕 x；传 null 表示屏幕中心稍偏
 * @param {number|null} y
 * @param {number} gapMs 两次点击之间的间隔，默认 140
 */
export function doubleTap(x, y, gapMs) {
    const gap = (typeof gapMs === 'number' && gapMs > 0) ? gapMs : 140;
    return new Promise(function (resolve, reject) {
        ObjC.schedule(ObjC.mainQueue, function () {
            try {
                const window = getKeyWindow();
                if (window === null) { reject(new Error('No UIWindow available')); return; }
                const b = window.bounds();
                const w = b[1][0], h = b[1][1];
                // 中心 ± 5% 随机偏移
                const cx = (typeof x === 'number') ? x : w / 2 + (Math.random() - 0.5) * w * 0.1;
                const cy = (typeof y === 'number') ? y : h / 2 + (Math.random() - 0.5) * h * 0.1;

                const onePoint = function () {
                    return runTouchSequence(window, [[cx, cy], [cx, cy], [cx, cy]]);
                };

                onePoint()
                    .then(function () { return wait(gap); })
                    .then(onePoint)
                    .then(function () {
                        resolve({ ok: true, center: [cx, cy], gapMs: gap });
                    })
                    .catch(reject);
            } catch (e) {
                reject(new Error(e.message || String(e)));
            }
        });
    });
}
