/**
 * TikTok OTP 输入。
 *
 * TikTok OTP 控件分三层：
 *   TMVerificationCodeInputView (firstResponder)
 *     └ TUXPinField (pinField) → 6 个 TUXLabel 可视格子
 *         └ UITextField (隐藏输入代理, textContentType=one-time-code)
 *
 * 只写隐藏 UITextField 不会同步可视格子，必须同时更新 TUXLabel 并触发 didCompleteAll。
 */

import ObjC from 'frida-objc-bridge';

function _keyWindow() {
    const app = ObjC.classes.UIApplication.sharedApplication();
    if (!app || app.handle.isNull()) return null;
    const w = app.keyWindow();
    return (!w || w.handle.isNull()) ? null : w;
}

function _findFirstResponder(root) {
    const queue = [root];
    let seen = 0;
    while (queue.length && seen < 800) {
        const v = queue.shift(); seen++;
        try { if (v.isFirstResponder && v.isFirstResponder()) return v; } catch (_) {}
        try {
            const subs = v.subviews();
            if (!subs) continue;
            const n = Math.min(subs.count(), 100);
            for (let i = 0; i < n; i++) queue.push(subs.objectAtIndex_(i));
        } catch (_) {}
    }
    return null;
}

function _findInnerTextField(view, depth) {
    if (!view || view.handle.isNull() || depth < 0) return null;
    const cls = String(view.$className || '');
    if (cls === 'UITextField' || /TextField/i.test(cls)) {
        try { if (typeof view.insertText_ === 'function') return view; } catch (_) {}
    }
    try {
        const subs = view.subviews();
        if (!subs) return null;
        const n = Math.min(subs.count(), 100);
        for (let i = 0; i < n; i++) {
            const found = _findInnerTextField(subs.objectAtIndex_(i), depth - 1);
            if (found) return found;
        }
    } catch (_) {}
    return null;
}

function _forceLayout(view, depth) {
    if (!view || view.handle.isNull() || depth < 0) return;
    try { view.setNeedsLayout(); } catch (_) {}
    try { view.layoutIfNeeded(); } catch (_) {}
    try { view.setNeedsDisplay(); } catch (_) {}
    try {
        const subs = view.subviews();
        if (!subs) return;
        const n = Math.min(subs.count(), 100);
        for (let i = 0; i < n; i++) _forceLayout(subs.objectAtIndex_(i), depth - 1);
    } catch (_) {}
}

function _notifyTextChanged(owner, inner) {
    try { inner.sendActionsForControlEvents_(0x00010000); } catch (_) {}
    try {
        ObjC.classes.NSNotificationCenter.defaultCenter()
            .postNotificationName_object_('UITextFieldTextDidChangeNotification', inner);
    } catch (_) {}
    try { owner.textFieldDidChange_(inner); } catch (_) {}
}

export function setOtpCode(code, source) {
    return new Promise(function (resolve, reject) {
        ObjC.schedule(ObjC.mainQueue, function () {
            try {
                const window = _keyWindow();
                if (!window) { reject(new Error('no key window')); return; }
                const first = _findFirstResponder(window);
                if (!first) { reject(new Error('no first responder')); return; }

                let pin = null;
                try { pin = first.pinField ? first.pinField() : null; } catch (_) {}
                if (!pin || pin.handle.isNull()) { reject(new Error('no pinField on firstResponder')); return; }

                const inner = _findInnerTextField(first, 8);
                const value = ObjC.classes.NSString.stringWithString_(String(code));
                const events = [];

                try { pin['- setWithValue:source:'](value, source || 0); events.push('pin.setWithValue'); } catch (e) { events.push('pin.setWithValue:err:' + e.message); }
                try { pin.setValue_(value); events.push('pin.setValue'); } catch (e) { events.push('pin.setValue:err:' + e.message); }

                if (inner && !inner.handle.isNull()) {
                    try { inner.setText_(value); events.push('inner.setText'); } catch (e) { events.push('inner.setText:err:' + e.message); }
                    _notifyTextChanged(first, inner);
                    events.push('inner.notifyTextChanged');
                }

                // 逐格写 TUXLabel，强制可视层同步
                const chars = Array.from(String(code));
                (function setLabels(view, depth) {
                    if (!view || view.handle.isNull() || depth < 0) return;
                    const cls = String(view.$className || '');
                    if (/TUXLabel/i.test(cls)) {
                        const idx = events.filter(e => e.startsWith('label.setText')).length;
                        if (idx < chars.length) {
                            try {
                                view.setText_(ObjC.classes.NSString.stringWithString_(chars[idx]));
                                try { view.setNeedsDisplay(); } catch (_) {}
                                events.push('label.setText:' + chars[idx]);
                            } catch (_) {}
                        }
                        return;
                    }
                    try {
                        const subs = view.subviews();
                        if (!subs) return;
                        const n = Math.min(subs.count(), 50);
                        for (let i = 0; i < n; i++) setLabels(subs.objectAtIndex_(i), depth - 1);
                    } catch (_) {}
                })(pin, 6);

                _forceLayout(pin, 5);
                _forceLayout(first, 5);

                try { first['- didCompleteAllEditionWithPinField:value:'](pin, value); events.push('owner.didCompleteAll'); } catch (e) { events.push('owner.didCompleteAll:err:' + e.message); }
                try { first.textFieldDidChange_(inner); events.push('owner.textFieldDidChange'); } catch (e) { events.push('owner.textFieldDidChange:err:' + e.message); }

                resolve({ ok: true, events });
            } catch (e) {
                reject(new Error(e.message || String(e)));
            }
        });
    });
}
