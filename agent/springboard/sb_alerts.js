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

/** True if action view is still on-screen (chooseSync keeps dying mid-dismiss views). */
function actionViewIsLive(v) {
    try {
        if (!v || v.handle.isNull()) return false;
        if (typeof v.window === 'function') {
            const w = v.window();
            if (!w || w.handle.isNull()) return false;
        }
        if (typeof v.isHidden === 'function' && v.isHidden()) return false;
        if (typeof v.alpha === 'function' && Number(v.alpha()) === 0) return false;
        return true;
    } catch (_e) {
        return false;
    }
}

function collectActionViews() {
    const out = [];
    const Cls = ObjC.classes._UIInterfaceActionCustomViewRepresentationView;
    if (!Cls) return out;
    try {
        const arr = ObjC.chooseSync(Cls);
        for (let i = 0; i < arr.length; i++) {
            const v = arr[i];
            if (!actionViewIsLive(v)) continue;
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

function remainingSnapshot() {
    const alerts = collectAlertObjects();
    const actions = collectActionViews();
    return {
        alertCount: alerts.length,
        actionViewCount: actions.length,
        hasAlert: alerts.length > 0 || actions.length > 0,
        alerts,
        actionViews: actions,
    };
}

const LIST_NOTE =
    'alerts=SBUserNotificationAlert instances; actionViews=tappable buttons (test alerts often ONLY actionViews). ' +
    'Visible if hasAlert (actionViewCount>0 || alertCount>0) — do NOT judge by alertCount alone. ' +
    'Location: prefer deny/cancel via sb_alert_dismiss or sb_alert_tap. Stacked: sb_alert_dismiss({all:true}).';

export function sbAlertList() {
    return new Promise(function (resolve) {
        ObjC.schedule(ObjC.mainQueue, function () {
            try {
                const rem = remainingSnapshot();
                let keyWindow = null;
                try {
                    const app = ObjC.classes.UIApplication.sharedApplication();
                    const w = app.keyWindow();
                    if (w && !w.handle.isNull()) keyWindow = String(w.$className || '');
                } catch (_e) { /* */ }
                resolve({
                    ok: true,
                    keyWindow,
                    alertCount: rem.alertCount,
                    actionViewCount: rem.actionViewCount,
                    hasAlert: rem.hasAlert,
                    alerts: rem.alerts,
                    actionViews: rem.actionViews,
                    note: LIST_NOTE,
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

/**
 * Trigger a synthetic system alert via SBAlertItemTestRecipe (iOS 16 jailbreak path).
 * force=false (default): skip if an alert/actionView is already visible (prevent stacking).
 */
export function sbAlertTrigger(force) {
    const allowStack = !!force;
    return new Promise(function (resolve) {
        ObjC.schedule(ObjC.mainQueue, function () {
            try {
                const alerts = collectAlertObjects();
                const actions = collectActionViews();
                if (!allowStack && (alerts.length > 0 || actions.length > 0)) {
                    resolve({
                        ok: true,
                        skipped: true,
                        reason: 'alert_already_present',
                        alertCount: alerts.length,
                        actionViewCount: actions.length,
                        alerts: alerts,
                        actionViews: actions,
                        hint: 'sb_alert_tap(title) or sb_alert_dismiss first; pass force:true only if you need another layer',
                    });
                    return;
                }

                const Recipe = ObjC.classes.SBAlertItemTestRecipe;
                if (!Recipe) {
                    resolve({
                        ok: false,
                        error: 'SBAlertItemTestRecipe not found (unsupported iOS / not SpringBoard)',
                    });
                    return;
                }
                let recipe = null;
                try {
                    recipe = Recipe.alloc().init();
                } catch (_e) {
                    try {
                        recipe = Recipe.new();
                    } catch (_e2) {
                        resolve({ ok: false, error: 'failed to alloc SBAlertItemTestRecipe' });
                        return;
                    }
                }
                if (!recipe || recipe.handle.isNull()) {
                    resolve({ ok: false, error: 'recipe null' });
                    return;
                }
                // Verified path on iOS 16: handleVolumeIncrease creates a dismissable test alert
                if (typeof recipe.handleVolumeIncrease === 'function') {
                    recipe.handleVolumeIncrease();
                } else if (typeof recipe['- handleVolumeIncrease'] !== 'undefined') {
                    recipe.handleVolumeIncrease();
                } else {
                    resolve({
                        ok: false,
                        error: 'handleVolumeIncrease missing on SBAlertItemTestRecipe',
                    });
                    return;
                }
                resolve({
                    ok: true,
                    skipped: false,
                    method: 'SBAlertItemTestRecipe.handleVolumeIncrease',
                    titleHint: 'Dismiss / test alert (varies by iOS)',
                    hint: 'Next: sb_alert_list → sb_alert_tap("Dismiss") or matching button title',
                });
            } catch (e) {
                resolve({ ok: false, error: String(e.message || e) });
            }
        });
    });
}

/**
 * One dismiss attempt (must run on main queue). policy: 'deny' | 'default' | 'first'
 * @returns {{ ok: boolean, via?: string, error?: string, matchedTitle?: string }}
 */
function dismissOnceSync(pol) {
    const alerts = collectAlertObjects();
    const actions = collectActionViews();

    // Prefer matching interface action titles
    if (pol === 'deny' && alerts.length > 0) {
        let denyTitle = null;
        const AlertCls = ObjC.classes.SBUserNotificationAlert;
        const objs = AlertCls ? ObjC.chooseSync(AlertCls) : [];
        if (objs.length > 0) denyTitle = pickDenyTitle(objs[0]);
        if (denyTitle) {
            const r = invokeActionByTitle(denyTitle);
            if (r.ok) return Object.assign({ via: 'deny-title' }, r);
        }
    }

    // Fall back: first action view (test alerts often only have actionViews)
    if (actions.length > 0 && actions[0].title) {
        const r = invokeActionByTitle(actions[0].title);
        if (r.ok) return Object.assign({ via: 'first-action' }, r);
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
                    return { ok: true, via: 'dismiss' };
                }
            } catch (_e) { /* */ }
            try {
                if (typeof a.deactivate === 'function') {
                    a.deactivate();
                    return { ok: true, via: 'deactivate' };
                }
            } catch (_e) { /* */ }
            try {
                if (typeof a.cancel === 'function') {
                    a.cancel();
                    return { ok: true, via: 'cancel' };
                }
            } catch (_e) { /* */ }
        }
    }

    return {
        ok: false,
        error: 'no alert/action to dismiss',
        via: 'none',
    };
}

function remainingBrief(rem) {
    const brief = {
        alertCount: rem.alertCount,
        actionViewCount: rem.actionViewCount,
    };
    if (rem.hasAlert && rem.actionViews && rem.actionViews.length) {
        brief.actionViews = rem.actionViews;
    }
    return brief;
}

/** UI settle after dismiss before re-list (actionViews lag mid-animation). */
const DISMISS_SETTLE_MS = 350;
/** Extra poll if still "present" after first settle (stale chooseSync). */
const DISMISS_RECHECK_MS = 200;

function remainingScore(rem) {
    return (rem.alertCount || 0) + (rem.actionViewCount || 0);
}

/**
 * Dismiss system alert.
 * @param {string|{policy?:string,all?:boolean,maxRounds?:number}} opts
 *   - policy: 'deny'|'default'|'first' (default deny)
 *   - all: if true, loop until clear or maxRounds (default false = one layer)
 *   - maxRounds: only with all (default 5)
 */
export function sbAlertDismiss(opts) {
    let pol = 'deny';
    let all = false;
    let maxRounds = 5;
    if (typeof opts === 'string' || opts == null) {
        pol = opts || 'deny';
    } else if (typeof opts === 'object') {
        pol = opts.policy || 'deny';
        all = !!opts.all;
        if (opts.maxRounds != null) {
            const n = Number(opts.maxRounds);
            maxRounds = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 5;
        }
    }

    // Single layer (default): dismiss → settle → re-list so cleared is not a false negative
    if (!all) {
        return new Promise(function (resolve) {
            ObjC.schedule(ObjC.mainQueue, function () {
                try {
                    const before = remainingSnapshot();
                    if (!before.hasAlert) {
                        resolve({
                            ok: true,
                            policy: pol,
                            all: false,
                            rounds: 0,
                            cleared: true,
                            needsRetry: false,
                            remaining: { alertCount: 0, actionViewCount: 0 },
                            via: 'none',
                            hint: 'no alert present',
                        });
                        return;
                    }
                    const r = dismissOnceSync(pol);
                    // actionViews often still list the same handle until animation settles
                    function finishSingle(rem) {
                        const cleared = !rem.hasAlert;
                        resolve({
                            ok: !!r.ok || cleared,
                            policy: pol,
                            all: false,
                            rounds: 1,
                            cleared,
                            needsRetry: !cleared && !!r.ok,
                            remaining: remainingBrief(rem),
                            via: r.via || (r.ok ? 'unknown' : 'none'),
                            matchedTitle: r.matchedTitle,
                            error: r.error,
                            settleMs: DISMISS_SETTLE_MS,
                            hint: cleared
                                ? 'cleared (post-settle); next: app screen_snapshot'
                                : 'still present after settle — use sb_alert_dismiss({all:true}) for stacks; do not parallel tap+dismiss',
                        });
                    }
                    setTimeout(function () {
                        ObjC.schedule(ObjC.mainQueue, function () {
                            try {
                                const rem = remainingSnapshot();
                                // One recheck if dismiss seemed to work but list still shows views
                                if (rem.hasAlert && r.ok) {
                                    setTimeout(function () {
                                        ObjC.schedule(ObjC.mainQueue, function () {
                                            try {
                                                finishSingle(remainingSnapshot());
                                            } catch (e3) {
                                                resolve({
                                                    ok: false,
                                                    all: false,
                                                    policy: pol,
                                                    error: String(e3.message || e3),
                                                });
                                            }
                                        });
                                    }, DISMISS_RECHECK_MS);
                                    return;
                                }
                                finishSingle(rem);
                            } catch (e2) {
                                resolve({
                                    ok: false,
                                    all: false,
                                    policy: pol,
                                    error: String(e2.message || e2),
                                });
                            }
                        });
                    }, DISMISS_SETTLE_MS);
                } catch (e) {
                    resolve({ ok: false, all: false, policy: pol, error: String(e.message || e) });
                }
            });
        });
    }

    // all:true — settle between attempts; count a round only when remaining score drops
    return new Promise(function (resolve) {
        let rounds = 0;
        let stallAttempts = 0;
        const vias = [];

        function finish(payload) {
            resolve(payload);
        }

        function tick() {
            ObjC.schedule(ObjC.mainQueue, function () {
                try {
                    const rem = remainingSnapshot();
                    if (!rem.hasAlert) {
                        finish({
                            ok: true,
                            all: true,
                            policy: pol,
                            rounds,
                            cleared: true,
                            needsRetry: false,
                            remaining: { alertCount: 0, actionViewCount: 0 },
                            vias,
                            settleMs: DISMISS_SETTLE_MS,
                            hint: 'all clear; next: app screen_snapshot',
                        });
                        return;
                    }
                    if (rounds >= maxRounds) {
                        finish({
                            ok: true,
                            all: true,
                            policy: pol,
                            rounds,
                            cleared: false,
                            needsRetry: true,
                            remaining: remainingBrief(rem),
                            vias,
                            settleMs: DISMISS_SETTLE_MS,
                            hint:
                                'maxRounds reached with remaining — needsRetry: call sb_alert_dismiss({all:true}) again or sb_alert_tap(title)',
                        });
                        return;
                    }
                    // Mid-animation stale handles: score may not drop every tap
                    if (stallAttempts >= maxRounds * 2) {
                        finish({
                            ok: true,
                            all: true,
                            policy: pol,
                            rounds,
                            cleared: false,
                            needsRetry: true,
                            remaining: remainingBrief(rem),
                            vias,
                            settleMs: DISMISS_SETTLE_MS,
                            hint:
                                'stalled (remaining not dropping) — needsRetry: re-list then sb_alert_dismiss({all:true})',
                        });
                        return;
                    }

                    const scoreBefore = remainingScore(rem);
                    const r = dismissOnceSync(pol);
                    if (r.via) vias.push(r.via);

                    setTimeout(function () {
                        ObjC.schedule(ObjC.mainQueue, function () {
                            try {
                                const after = remainingSnapshot();
                                const scoreAfter = remainingScore(after);
                                if (scoreAfter < scoreBefore) {
                                    rounds++;
                                    stallAttempts = 0;
                                } else {
                                    stallAttempts++;
                                }
                                tick();
                            } catch (e2) {
                                finish({
                                    ok: false,
                                    all: true,
                                    policy: pol,
                                    rounds,
                                    cleared: false,
                                    needsRetry: true,
                                    error: String(e2.message || e2),
                                    vias,
                                });
                            }
                        });
                    }, DISMISS_SETTLE_MS);
                } catch (e) {
                    finish({
                        ok: false,
                        all: true,
                        policy: pol,
                        rounds,
                        cleared: false,
                        needsRetry: true,
                        error: String(e.message || e),
                        vias,
                    });
                }
            });
        }

        tick();
    });
}
