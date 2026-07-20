/**
 * 文字输入原语（拟人逐字 + 多策略 fallback）：
 *   - inputText(text, perCharDelayMs)
 *   - firstResponderInfo()
 *
 * 4 级 fallback（每字符都在主线程里做一次判定），按这个顺序先后尝试：
 *   1) 外层 `-insertText:`               : UITextField / UITextView / UIKeyInput 协议
 *   2) 外层 `-replaceRange:withText:`    : UITextInput 协议（富文本控件）
 *   3) 内层 `UITextField/UITextView insertText:` : 递归搜索子视图
 *        典型例子 TikTok 的 AWESearchBar / UISearchBar 自己不吃 insertText，
 *        但它包着的 UISearchBarTextField / UITextField 吃
 *   4) 内层 `setText:` + 通知            : 以上都失败时兜底直接赋值
 *
 * 每字符都单独 `ObjC.schedule(ObjC.mainQueue, ...)`，避免跨线程调 UIKit 断言。
 */
import ObjC from 'frida-objc-bridge';
import { firstResponderInfo as _fri, getFirstResponderView } from '../shared_js/view_tree.js';

function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function randomDelay(base, jitter) {
    return base + Math.floor(Math.random() * jitter);
}

export function firstResponderInfo() {
    return _fri();
}

/**
 * 在一棵子树里递归寻找可以做 insertText 的 UITextField / UITextView。
 *
 * 注意必须在主线程调用（本函数由调用方保证）。
 */
function findInnerEditable(view, depthLeft) {
    if (!view || view.handle.isNull()) return null;
    if (depthLeft < 0) return null;

    let cls = '';
    try { cls = String(view.$className); } catch (_e) { cls = ''; }

    // 优先匹配标准输入控件
    const isStdField = (
        cls === 'UITextField' || cls === 'UITextView' ||
        cls === 'UISearchBarTextField' || cls === 'UISearchTextField'
    );
    const isLikelyField = isStdField || /TextField|TextView|SearchTextField/i.test(cls);

    if (isLikelyField) {
        // 通常只有真正的输入框有 selectedTextRange / markedTextRange
        try {
            if (typeof view.insertText_ === 'function' ||
                typeof view['- insertText:'] !== 'undefined') {
                return view;
            }
        } catch (_e) { /* ignore */ }
    }

    try {
        const subviews = view.subviews();
        if (!subviews || subviews.handle.isNull()) return null;
        const count = subviews.count();
        for (let i = 0; i < count; i++) {
            const sv = subviews.objectAtIndex_(i);
            const found = findInnerEditable(sv, depthLeft - 1);
            if (found !== null) return found;
        }
    } catch (_e) { /* ignore traversal errors */ }
    return null;
}

/**
 * 主线程内构造一次 insert，返回 { ok, methodUsed, error }。
 * methodUsed: 'insertText' | 'replaceRange' | 'innerInsertText' | 'innerSetText'
 * target: null 表示复用 fr（外层）；否则是 inner view。
 */
function doInsert(fr, ch, prevMethod, innerCache) {
    // 已经锁定方法，直接用
    if (prevMethod === 'insertText') {
        fr.insertText_(ch);
        return { ok: true, methodUsed: 'insertText' };
    }
    if (prevMethod === 'replaceRange') {
        let range = null;
        try { range = fr.selectedTextRange(); } catch (_e) { /* ignore */ }
        if (!range || range.handle.isNull()) {
            const end = fr.endOfDocument();
            range = fr.textRangeFromPosition_toPosition_(end, end);
        }
        fr.replaceRange_withText_(range, ch);
        return { ok: true, methodUsed: 'replaceRange' };
    }
    if (prevMethod === 'innerInsertText') {
        const inner = innerCache.view;
        inner.insertText_(ch);
        return { ok: true, methodUsed: 'innerInsertText' };
    }
    if (prevMethod === 'innerSetText') {
        const inner = innerCache.view;
        const cur = inner.text();
        const curStr = (cur && !cur.handle.isNull()) ? String(cur) : '';
        inner.setText_(curStr + ch);
        // 通知 UIControl target-action（大多数搜索框依赖这个才触发 textDidChange）
        try {
            inner.sendActionsForControlEvents_(0x00010000); // UIControlEventEditingChanged
        } catch (_e) { /* 非 UIControl 子类忽略 */ }
        try {
            const NSNotificationCenter = ObjC.classes.NSNotificationCenter;
            NSNotificationCenter.defaultCenter()
                .postNotificationName_object_('UITextFieldTextDidChangeNotification', inner);
        } catch (_e) { /* ignore */ }
        return { ok: true, methodUsed: 'innerSetText' };
    }

    // --- 第一字：依次试 4 条路径 ---
    const errors = {};
    // path 1: 外层 insertText
    try {
        fr.insertText_(ch);
        return { ok: true, methodUsed: 'insertText' };
    } catch (e1) { errors.insertText = e1.message || String(e1); }

    // path 2: 外层 replaceRange
    try {
        let range = null;
        try { range = fr.selectedTextRange(); } catch (_e) { /* ignore */ }
        if (!range || range.handle.isNull()) {
            const end = fr.endOfDocument();
            range = fr.textRangeFromPosition_toPosition_(end, end);
        }
        fr.replaceRange_withText_(range, ch);
        return { ok: true, methodUsed: 'replaceRange' };
    } catch (e2) { errors.replaceRange = e2.message || String(e2); }

    // path 3: 递归找子视图里的 UITextField / UITextView 调 insertText
    try {
        const inner = findInnerEditable(fr, 6);
        if (inner !== null) {
            // 先让内层获焦 —— 很多 UISearchBar 的实现里，外层 becomeFirstResponder 后
            // inner field 已经是真正的 firstResponder，这里再 becomeFirstResponder 也安全
            try { inner.becomeFirstResponder(); } catch (_e) { /* ignore */ }
            inner.insertText_(ch);
            innerCache.view = inner;
            innerCache.className = String(inner.$className);
            return { ok: true, methodUsed: 'innerInsertText' };
        } else {
            errors.innerInsertText = 'no inner editable subview found';
        }
    } catch (e3) { errors.innerInsertText = e3.message || String(e3); }

    // path 4: 内层 setText 兜底（可能无法做逐字动画但能把文字写进去）
    try {
        const inner = innerCache.view || findInnerEditable(fr, 6);
        if (inner !== null) {
            try { inner.becomeFirstResponder(); } catch (_e) { /* ignore */ }
            const cur = inner.text();
            const curStr = (cur && !cur.handle.isNull()) ? String(cur) : '';
            inner.setText_(curStr + ch);
            try { inner.sendActionsForControlEvents_(0x00010000); } catch (_e) { /* ignore */ }
            try {
                const NSNotificationCenter = ObjC.classes.NSNotificationCenter;
                NSNotificationCenter.defaultCenter()
                    .postNotificationName_object_('UITextFieldTextDidChangeNotification', inner);
            } catch (_e) { /* ignore */ }
            innerCache.view = inner;
            innerCache.className = String(inner.$className);
            return { ok: true, methodUsed: 'innerSetText' };
        } else {
            errors.innerSetText = 'no inner editable subview for setText';
        }
    } catch (e4) { errors.innerSetText = e4.message || String(e4); }

    return {
        ok: false,
        error: 'all 4 strategies failed: ' + JSON.stringify(errors),
    };
}

/**
 * 逐字符把 text 插入到当前聚焦的控件。
 *
 * @returns {Promise<{ok:boolean, chars:number, method:string, className:string}>}
 */
export function inputText(text, perCharDelayMs) {
    const base = (typeof perCharDelayMs === 'number' && perCharDelayMs >= 0) ? perCharDelayMs : 90;
    const jitter = Math.max(30, Math.floor(base));
    return new Promise(function (resolve, reject) {
        let fr = null;
        let className = '';
        let startRequested = false;

        try {
            ObjC.schedule(ObjC.mainQueue, function () {
                try {
                    fr = getFirstResponderView();
                    if (fr !== null) className = String(fr.$className);
                } catch (_e) { /* handled below */ }
                startRequested = true;
            });
        } catch (e) {
            reject(new Error('schedule failed: ' + (e.message || e)));
            return;
        }

        const waitForFr = function () {
            if (!startRequested) {
                setTimeout(waitForFr, 10);
                return;
            }
            if (fr === null) {
                reject(new Error('no first responder; tap the input field first'));
                return;
            }
            startTyping();
        };

        const chars = Array.from(text);
        let i = 0;
        let methodUsed = null;
        const innerCache = { view: null, className: '' };

        const insertOneOnMain = function (ch, cb) {
            ObjC.schedule(ObjC.mainQueue, function () {
                try {
                    const r = doInsert(fr, ch, methodUsed, innerCache);
                    if (r.ok) {
                        if (methodUsed === null) methodUsed = r.methodUsed;
                        cb(null);
                    } else {
                        cb(new Error(r.error));
                    }
                } catch (e) {
                    cb(new Error(e.message || String(e)));
                }
            });
        };

        const step = function () {
            if (i >= chars.length) {
                resolve({
                    ok: true,
                    chars: chars.length,
                    method: methodUsed || 'insertText',
                    className: className,
                    innerClassName: innerCache.className || null,
                });
                return;
            }
            const idx = i++;
            const ch = chars[idx];
            insertOneOnMain(ch, function (err) {
                if (err) {
                    reject(new Error(
                        'insert failed at char index ' + idx +
                        ' (ch=' + JSON.stringify(ch) + ') on ' + className +
                        ' : ' + (err.message || err)
                    ));
                    return;
                }
                wait(randomDelay(base, jitter)).then(step);
            });
        };

        const startTyping = function () { step(); };

        waitForFr();
    });
}

/**
 * 清空当前聚焦输入框的全部文字（通过 setText_('')）。
 * @returns {{ ok: boolean, error?: string }}
 */
export function clearText() {
    return new Promise(function (resolve) {
        ObjC.schedule(ObjC.mainQueue, function () {
            try {
                const fr = getFirstResponderView();
                if (!fr) { resolve({ ok: false, error: 'no firstResponder' }); return; }
                if (typeof fr.setText_ === 'function') {
                    fr.setText_('');
                    resolve({ ok: true });
                    return;
                }
                // 递归找内层 setText_
                const sv = fr.subviews ? fr.subviews() : null;
                if (sv) {
                    for (let i = 0; i < sv.count(); i++) {
                        const v = sv.objectAtIndex_(i);
                        if (typeof v.setText_ === 'function') {
                            v.setText_('');
                            resolve({ ok: true });
                            return;
                        }
                    }
                }
                resolve({ ok: false, error: 'setText_ not found' });
            } catch (e) {
                resolve({ ok: false, error: String(e) });
            }
        });
    });
}
