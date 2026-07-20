import { getKeyWindow } from './shared_js/api.js';
import ObjC from 'frida-objc-bridge';

export function collectTexts() {
    const result = [];
    const seen = new Set();
    try {
        const win = getKeyWindow();
        if (!win) return result;
        function tryAdd(t) {
            if (!t || t === 'null' || t.length === 0 || t.length > 2000) return;
            if (seen.has(t)) return;
            seen.add(t);
            const codes = [];
            for (let i = 0; i < t.length; i++) codes.push(t.charCodeAt(i));
            result.push(codes);
        }
        function walk(view) {
            try {
                try { tryAdd(view.text().toString()); } catch(_e) {}
                try {
                    const at = view.attributedText();
                    if (at && !at.handle.isNull()) tryAdd(at.string().toString());
                } catch(_e) {}
            } catch (_e) {}
            try {
                const subs = view.subviews();
                for (let i = 0; i < Number(subs.count()); i++) walk(subs.objectAtIndex_(i));
            } catch (_e) {}
        }
        walk(win);
    } catch (e) {}
    return result;
}

export function collectTextsWithFrames() {
    const result = [];
    const seen = new Set();
    try {
        const win = getKeyWindow();
        if (!win) return result;
        function getFrame(view) {
            try {
                // Convert into keyWindow coordinates (null can yield wrong offsets on some pages)
                const f = view.convertRect_toView_(view.bounds(), win);
                const x = f[0][0], y = f[0][1], w = f[1][0], h = f[1][1];
                if (w <= 0 || h <= 0) return null;
                return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
            } catch(_e) {
                try {
                    const f = view.convertRect_toView_(view.bounds(), null);
                    const x = f[0][0], y = f[0][1], w = f[1][0], h = f[1][1];
                    if (w <= 0 || h <= 0) return null;
                    return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
                } catch(_e2) { return null; }
            }
        }
        function tryAdd(t, frame) {
            if (!t || t === 'null' || t.length === 0 || t.length > 2000) return;
            const key = t + (frame ? `|${frame.cx}|${frame.cy}` : '');
            if (seen.has(key)) return;
            seen.add(key);
            const codes = [];
            for (let i = 0; i < t.length; i++) codes.push(t.charCodeAt(i));
            result.push({ codes, frame });
        }
        function walk(view) {
            const frame = getFrame(view);
            try {
                try { tryAdd(view.text().toString(), frame); } catch(_e) {}
                try {
                    const at = view.attributedText();
                    if (at && !at.handle.isNull()) tryAdd(at.string().toString(), frame);
                } catch(_e) {}
            } catch (_e) {}
            try {
                const subs = view.subviews();
                for (let i = 0; i < Number(subs.count()); i++) walk(subs.objectAtIndex_(i));
            } catch (_e) {}
        }
        walk(win);
    } catch (e) {}
    return result;
}

export function findButtons() {
    const result = [];
    try {
        const win = getKeyWindow();
        if (!win) return result;
        function walk(view) {
            try {
                const cls = String(view.$className || '');
                if (cls.includes('Button') || cls.includes('button')) {
                    const f = view.convertRect_toView_(view.bounds(), null);
                    const x = f[0][0], y = f[0][1], w = f[1][0], h = f[1][1];
                    if (w > 0 && h > 0) {
                        let label = '';
                        try { label = view.titleLabel().text().toString(); } catch(_e) {}
                        if (!label || label === 'null') try { label = view.currentTitle().toString(); } catch(_e) {}
                        if (!label || label === 'null') label = '';
                        const codes = [];
                        for (let i = 0; i < label.length; i++) codes.push(label.charCodeAt(i));
                        result.push({ cls, cx: x + w / 2, cy: y + h / 2, w, h, codes });
                    }
                }
            } catch(_e) {}
            try {
                const subs = view.subviews();
                for (let i = 0; i < Number(subs.count()); i++) walk(subs.objectAtIndex_(i));
            } catch(_e) {}
        }
        walk(win);
    } catch(e) {}
    return result;
}

export function dumpAllViewStates() {
    const result = [];
    try {
        const win = getKeyWindow();
        if (!win) return result;
        function getFrame(view) {
            try {
                const f = view.convertRect_toView_(view.bounds(), null);
                const x = f[0][0], y = f[0][1], w = f[1][0], h = f[1][1];
                if (w <= 0 || h <= 0) return null;
                return { x, y, w, h };
            } catch(_e) { return null; }
        }
        function getText(view) {
            try { const t = view.text(); if (t && !t.handle.isNull()) return t.toString(); } catch(_e) {}
            try { const at = view.attributedText(); if (at && !at.handle.isNull()) return at.string().toString(); } catch(_e) {}
            return '';
        }
        function safeVal(fn) {
            try { const v = fn(); return (v !== null && v !== undefined) ? v : null; } catch(_e) { return null; }
        }
        function walk(view, depth) {
            if (!view || view.handle.isNull() || depth > 30) return;
            try {
                const cls = String(view.$className || '');
                const frame = getFrame(view);
                // 只收集有 frame 的 view
                if (frame) {
                    const text = getText(view);
                    const isOn = safeVal(() => view.isOn());
                    const isSelected = safeVal(() => view.isSelected());
                    const isEnabled = safeVal(() => view.isEnabled());
                    const isHidden = safeVal(() => view.isHidden());
                    const isHighlighted = safeVal(() => view.isHighlighted());
                    const alpha = safeVal(() => view.alpha());
                    // 尝试读取自定义属性
                    let customOn = null;
                    try { customOn = view.valueForKey_('on'); if (customOn !== null && customOn !== undefined) customOn = Boolean(customOn); else customOn = null; } catch(_e) {}
                    let customEnabled = null;
                    try { const v = view.valueForKey_('enabled'); if (v !== null && v !== undefined) customEnabled = Boolean(v); else customEnabled = null; } catch(_e) {}
                    // currentImage 描述（UIButton 用图片表示开关状态）
                    let imageDesc = null;
                    try { const img = view.currentImage && view.currentImage(); if (img && !img.handle.isNull()) imageDesc = String(img.description()).substring(0, 80); } catch(_e) {}
                    // backgroundColor 描述
                    let bgColor = null;
                    try { const c = view.backgroundColor(); if (c && !c.handle.isNull()) bgColor = String(c.description()).substring(0, 60); } catch(_e) {}
                    // tintColor 描述
                    let tintColor = null;
                    try { const c = view.tintColor(); if (c && !c.handle.isNull()) tintColor = String(c.description()).substring(0, 60); } catch(_e) {}
                    // 子视图数量
                    let subviewCount = 0;
                    try { subviewCount = Number(view.subviews().count()); } catch(_e) {}
                    const codes = [];
                    if (text) {
                        for (let i = 0; i < text.length; i++) codes.push(text.charCodeAt(i));
                    }
                    // 收集所有有文本、或可交互、或有状态属性、或 Switch/Button 相关的 view
                    const isInteractive = view.userInteractionEnabled && view.userInteractionEnabled();
                    const hasState = isOn !== null || isSelected !== null || isHighlighted !== null || customOn !== null;
                    if (text || hasState || isInteractive || /Switch|Toggle|Control|Button|Cell|ImageView/i.test(cls)) {
                        result.push({
                            codes,
                            frame,
                            className: cls,
                            isOn: isOn,
                            isSelected: isSelected,
                            isEnabled: isEnabled,
                            isHidden: isHidden,
                            isHighlighted: isHighlighted,
                            alpha: alpha,
                            customOn: customOn,
                            customEnabled: customEnabled,
                            imageDesc: imageDesc,
                            bgColor: bgColor,
                            tintColor: tintColor,
                            subviewCount: subviewCount,
                            depth: depth,
                        });
                    }
                }
            } catch(_e) {}
            try {
                const subs = view.subviews();
                for (let i = 0; i < Number(subs.count()); i++) walk(subs.objectAtIndex_(i), depth + 1);
            } catch(_e) {}
        }
        walk(win, 0);
    } catch(e) {}
    return result;
}

export function setTextAtPoint(cx, cy, newText) {
    return new Promise(function(resolve) {
        ObjC.schedule(ObjC.mainQueue, function() {
            const result = { ok: false, cls: '', error: '' };
            try {
                const win = getKeyWindow();
                if (!win) { result.error = 'no window'; resolve(result); return; }
                let best = null, bestDist = 9999;
                function walk(view) {
                    try {
                        const f = view.convertRect_toView_(view.bounds(), null);
                        const vx = f[0][0] + f[1][0] / 2;
                        const vy = f[0][1] + f[1][1] / 2;
                        const dist = Math.abs(vx - cx) + Math.abs(vy - cy);
                        if (dist < bestDist) {
                            try { if (view.isEditable && view.isEditable()) { best = view; bestDist = dist; } } catch(_e) {}
                            try { if (view.isEnabled && view.isEnabled() && view.text) { best = view; bestDist = dist; } } catch(_e) {}
                        }
                    } catch(_e) {}
                    try {
                        const subs = view.subviews();
                        for (let i = 0; i < Number(subs.count()); i++) walk(subs.objectAtIndex_(i));
                    } catch(_e) {}
                }
                walk(win);
                if (!best) { result.error = 'no editable view found'; resolve(result); return; }
                result.cls = String(best.$className || '');
                best.setText_(newText);
                result.ok = true;
                try { best.sendActionsForControlEvents_(0x00010000); } catch(_e) {}
                try {
                    ObjC.classes.NSNotificationCenter.defaultCenter()
                        .postNotificationName_object_(ObjC.classes.NSString.stringWithString_('UITextFieldTextDidChangeNotification'), best);
                } catch(_e) {}
                try {
                    ObjC.classes.NSNotificationCenter.defaultCenter()
                        .postNotificationName_object_(ObjC.classes.NSString.stringWithString_('UITextViewTextDidChangeNotification'), best);
                } catch(_e) {}
            } catch(e) { result.error = String(e); }
            resolve(result);
        });
    });
}
