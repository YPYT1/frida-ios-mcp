/**
 * 回桌面原语：将当前 App 置于后台，iOS 自动切回 SpringBoard（桌面）。
 *
 * 实现方式：在主线程调用 UIApplication.sharedApplication().suspend()
 * 让当前前台 App 进入后台状态，系统会自动显示桌面。
 *
 * 适用于任意已注入 agent 的 App，不需要注入 SpringBoard。
 * 如果 suspend 方法不存在，fallback 到 _deactivateForEventsOnly。
 *
 * 注意：本操作会让当前 App 失去前台焦点，后续如需继续操作该 App
 * 需要重新激活（例如通过通知中心或再次点击 App 图标）。
 */
import ObjC from 'frida-objc-bridge';

export function pressHome() {
    return new Promise(function (resolve, reject) {
        ObjC.schedule(ObjC.mainQueue, function () {
            try {
                var UIApp = ObjC.classes.UIApplication.sharedApplication();
                var methodUsed = null;

                // 尝试 1: suspend()（公开但已弃用，仍然有效）
                if (typeof UIApp.suspend === 'function') {
                    UIApp.suspend();
                    methodUsed = 'suspend';
                }
                // 尝试 2: _suspend()（私有方法）
                else if (typeof UIApp['_suspend'] !== 'undefined') {
                    UIApp['_suspend']();
                    methodUsed = '_suspend';
                }
                // 尝试 3: _deactivateForEventsOnly（iOS 内部用于处理来电/闹钟等）
                else if (typeof UIApp._deactivateForEventsOnly === 'function') {
                    UIApp._deactivateForEventsOnly();
                    methodUsed = '_deactivateForEventsOnly';
                }
                else {
                    reject(new Error('No suspend/deactivate method available on UIApplication'));
                    return;
                }

                resolve({
                    ok: true,
                    method: methodUsed,
                    note: 'App moved to background; SpringBoard should become visible',
                });
            } catch (e) {
                reject(new Error('pressHome failed: ' + (e.message || String(e))));
            }
        });
    });
}
