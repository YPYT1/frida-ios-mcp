/**
 * SpringBoard 系统弹窗探测与点击（注入到 SpringBoard 进程）。
 *
 * 策略（iOS 16 验证路径）：
 *   1) SBUserNotificationAlert 实例：读 header/message/按钮标题
 *   2) _UIInterfaceActionCustomViewRepresentationView：按 action.title 匹配后 invokeInterfaceAction
 *   3) 位置相关弹窗默认走拒绝/取消（不点「設定」）
 */
import ObjC from 'frida-objc-bridge';

function safeStr(v) {
    try {
        if (v === null || v === undefined) return '';
        if (typeof v === 'string') return v;
        return v.toString();
    } catch (_e) {
        return '';
    }
}

function isLocationRelated(header, message) {
    const blob = (header + ' ' + message).toLowerCase();
    return (
        blob.includes('位置') ||
        blob.includes('location') ||
        blob.includes('位置情報') ||
        blob.includes('locationd') ||
        blob.includes('地图') ||
        blob.includes('地圖')
    );
}

function pickDenyTitle(alert) {
    // Prefer default/cancel/deny titles over Settings/Allow
    const titles = [];
    try {
        if (alert.defaultButtonTitle) titles.push({ role: 'default', title: safeStr(alert.defaultButtonTitle()) });
    } catch (_e) { /* */ }
    try {
        if (alert.alternateButtonTitle) titles.push({ role: 'alternate', title: safeStr(alert.alternateButtonTitle()) });
    } catch (_e) { /* */ }
    try {
        if (alert.otherButtonTitle) titles.push({ role: 'other', title: safeStr(alert.otherButtonTitle()) });
    } catch (_e) { /* */ }

    const denyLike = /キャンセル|取消|不允許|不允许|許可しない|不允许|Don't Allow|Don.?t Allow|Cancel|拒絕|拒绝|关闭|關閉|閉じる/i;
    const settingsLike = /設定|设置|Settings|允許|允许|OK|許可|Allow|While Using/i;

    for (const t of titles) {
        if (t.title && denyLike.test(t.title) && !settingsLike.test(t.title)) return t.title;
    }
    // Japanese TikTok style: alternate often 許可しない
    for (const t of titles) {
        if (t.title && /許可しない|不允許|Don't Allow/i.test(t.title)) return t.title;
    }
    // Prefer default over alternate when unsure (often Cancel)
    if (titles[0] && titles[0].title) return titles[0].title;
    return null;
}

function collectAlertObjects() {
    const out = [];
    const AlertCls = ObjC.classes.SBUserNotificationAlert;
    if (!AlertCls) return out;
    try {
        // chooseSync may throw if class not present
        const arr = ObjC.chooseSync(AlertCls);
        for (let i = 0; i < arr.length; i++) {
            const a = arr[i];
            let header = '', message = '';
            try { header = safeStr(a.alertHeader && a.alertHeader()); } catch (_e) { /* */ }
            try { message = safeStr(a.alertMessage && a.alertMessage()); } catch (_e) { /* */ }
            const buttons = [];
            try {
                const d = safeStr(a.defaultButtonTitle && a.defaultButtonTitle());
                if (d) buttons.push({ role: 'default', title: d });
            } catch (_e) { /* */ }
            try {
                const alt = safeStr(a.alternateButtonTitle && a.alternateButtonTitle());
                if (alt) buttons.push({ role: 'alternate', title: alt });
            } catch (_e) { /* */ }
            try {
                const o = safeStr(a.otherButtonTitle && a.otherButtonTitle());
                if (o) buttons.push({ role: 'other', title: o });
            } catch (_e) { /* */ }
            out.push({
                index: out.length,
                className: String(a.$className || 'SBUserNotificationAlert'),
                header,
                message,
                buttons,
                locationRelated: isLocationRelated(header, message),
                handle: a.handle.toString(),
            });
        }
    } catch (_e) { /* */ }
    return out;
}

function collectActionViews() {
    const out = [];
    const Cls = ObjC.classes._UIInterfaceActionCustomViewRepresentationView;
    if (!Cls) return out;
    try {
        const arr = ObjC.chooseSync(Cls);
        for (let i = 0; i < arr.length; i++) {
            const v = arr[i];
            let title = '';
            try {
                const action = v.action && v.action();
                if (action && !action.handle.isNull()) title = safeStr(action.title && action.title());
            } catch (_e) { /* */ }
            out.push({
                index: out.length,
                title,
                className: String(v.$className || ''),
                handle: v.handle.toString(),
            });
        }
    } catch (_e) { /* */ }
    return out;
}

export function sbAlertList() {
    return new Promise(function (resolve) {
        ObjC.schedule(ObjC.mainQueue, function () {
            try {
                const alerts = collectAlertObjects();
                const actions = collectActionViews();
                let keyWindow = null;
                try {
                    const app = ObjC.classes.UIApplication.sharedApplication();
                    const w = app.keyWindow();
                    if (w && !w.handle.isNull()) keyWindow = String(w.$className || '');
                } catch (_e) { /* */ }
                resolve({
                    ok: true,
                    keyWindow,
                    alertCount: alerts.length,
                    actionViewCount: actions.length,
                    alerts,
                    actionViews: actions,
                    note:
                        'Location-related alerts should use deny/cancel. Prefer sb_alert_tap title match or sb_alert_dismiss.',
                });
            } catch (e) {
                resolve({ ok: false, error: String(e.message || e) });
            }
        });
    });
}

function invokeActionByTitle(title) {
    const want = String(title || '');
    if (!want) return { ok: false, error: 'title required' };
    const Cls = ObjC.classes._UIInterfaceActionCustomViewRepresentationView;
    if (!Cls) return { ok: false, error: '_UIInterfaceActionCustomViewRepresentationView missing' };
    const arr = ObjC.chooseSync(Cls);
    for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        let t = '';
        try {
            const action = v.action && v.action();
            if (action && !action.handle.isNull()) t = safeStr(action.title && action.title());
        } catch (_e) { /* */ }
        if (t === want || t.includes(want) || want.includes(t)) {
            try {
                v.invokeInterfaceAction();
                return { ok: true, method: 'invokeInterfaceAction', matchedTitle: t };
            } catch (e) {
                return { ok: false, error: 'invoke failed: ' + (e.message || e), matchedTitle: t };
            }
        }
    }
    return {
        ok: false,
        error: 'no action view title matched',
        wanted: want,
        available: arr.map(function (v, idx) {
            try {
                return safeStr(v.action().title());
            } catch (_e) {
                return '(idx ' + idx + ')';
            }
        }),
    };
}

export function sbAlertTap(title) {
    return new Promise(function (resolve) {
        ObjC.schedule(ObjC.mainQueue, function () {
            try {
                resolve(invokeActionByTitle(title));
            } catch (e) {
                resolve({ ok: false, error: String(e.message || e) });
            }
        });
    });
}

export function sbAlertDismiss(policy) {
    // policy: 'deny' | 'default' | 'first'
    const pol = policy || 'deny';
    return new Promise(function (resolve) {
        ObjC.schedule(ObjC.mainQueue, function () {
            try {
                const alerts = collectAlertObjects();
                const actions = collectActionViews();

                // Prefer matching interface action titles
                if (pol === 'deny' && alerts.length > 0) {
                    const a = alerts[0];
                    let denyTitle = null;
                    if (a.locationRelated || true) {
                        // Always prefer deny-like when policy=deny
                        const AlertCls = ObjC.classes.SBUserNotificationAlert;
                        const objs = AlertCls ? ObjC.chooseSync(AlertCls) : [];
                        if (objs.length > 0) denyTitle = pickDenyTitle(objs[0]);
                    }
                    if (denyTitle) {
                        const r = invokeActionByTitle(denyTitle);
                        if (r.ok) {
                            resolve(Object.assign({ policy: pol, via: 'deny-title' }, r));
                            return;
                        }
                    }
                }

                // Fall back: first action view
                if (actions.length > 0 && actions[0].title) {
                    const r = invokeActionByTitle(actions[0].title);
                    if (r.ok) {
                        resolve(Object.assign({ policy: pol, via: 'first-action' }, r));
                        return;
                    }
                }

                // Fall back: dismiss/deactivate/cancel on alert object
                const AlertCls = ObjC.classes.SBUserNotificationAlert;
                if (AlertCls) {
                    const objs = ObjC.chooseSync(AlertCls);
                    if (objs.length > 0) {
                        const a = objs[0];
                        try {
                            if (typeof a.dismiss === 'function') {
                                a.dismiss();
                                resolve({ ok: true, policy: pol, via: 'dismiss' });
                                return;
                            }
                        } catch (_e) { /* */ }
                        try {
                            if (typeof a.deactivate === 'function') {
                                a.deactivate();
                                resolve({ ok: true, policy: pol, via: 'deactivate' });
                                return;
                            }
                        } catch (_e) { /* */ }
                        try {
                            if (typeof a.cancel === 'function') {
                                a.cancel();
                                resolve({ ok: true, policy: pol, via: 'cancel' });
                                return;
                            }
                        } catch (_e) { /* */ }
                    }
                }

                resolve({
                    ok: false,
                    error: 'no alert/action to dismiss',
                    alertCount: alerts.length,
                    actionViewCount: actions.length,
                });
            } catch (e) {
                resolve({ ok: false, error: String(e.message || e) });
            }
        });
    });
}
