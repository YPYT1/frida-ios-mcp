/**
 * ObjC 视图树遍历与查询：替代"截图比对"的"爬虫式"定位方案。
 *
 * 提供：
 *   - dumpTree(opts)            : 把 keyWindow 整棵可见视图树序列化为 JSON
 *   - findView(query)           : 按 className / labelContains / placeholder / identifier 首个匹配
 *   - findViews(query)          : 全部匹配
 *   - dumpModalView()           : 检测中间弹窗，返回容器 + 可点按钮列表
 *   - dumpLoginGate()           : 检测登录/注册拦截窗（按窗口类名或文案匹配）
 *   - firstResponderInfo()      : 当前焦点输入控件信息
 */
import ObjC from 'frida-objc-bridge';
import { getApi, getKeyWindow } from './api.js';

// =========================================================
// 工具
// =========================================================
function safeStr(objcStr) {
    try {
        if (objcStr === null || objcStr === undefined) return null;
        if (typeof objcStr === 'string') return objcStr;
        if (objcStr.handle && objcStr.handle.isNull()) return null;
        return objcStr.toString();
    } catch (_e) {
        return null;
    }
}

function rectToArray(rect) {
    if (!rect) return null;
    return [rect[0][0], rect[0][1], rect[1][0], rect[1][1]];
}

function viewClassName(view) {
    try { return view.$className || view.class().description().toString(); }
    catch (_e) { return 'UIView'; }
}

function isInteractive(view) {
    try {
        const cls = view.class();
        const name = cls.description().toString();
        if (/UIControl|Button|TextField|TextView|Switch|Slider|Segmented|TabBarButton/i.test(name)) return true;
        if (view.isUserInteractionEnabled && view.isUserInteractionEnabled()) {
            const lbl = safeStr(view.accessibilityLabel && view.accessibilityLabel());
            if (lbl && lbl.length > 0) return true;
        }
    } catch (_e) { /* ignore */ }
    return false;
}

function isVisible(view) {
    try {
        if (view.isHidden && view.isHidden()) return false;
        const a = view.alpha && view.alpha();
        if (a !== undefined && a !== null && a < 0.01) return false;
    } catch (_e) { /* ignore */ }
    return true;
}

function convertFrameToWindow(view, window) {
    try {
        const bounds = view.bounds();
        const rect = view['- convertRect:toView:'].call(view, bounds, window);
        return rectToArray(rect);
    } catch (_e) {
        return rectToArray(view.frame());
    }
}

function nodeInfo(view, window, depth) {
    const frame = convertFrameToWindow(view, window);
    let label = null, identifier = null, text = null, placeholder = null;
    try { label = safeStr(view.accessibilityLabel && view.accessibilityLabel()); } catch (_e) {}
    try { identifier = safeStr(view.accessibilityIdentifier && view.accessibilityIdentifier()); } catch (_e) {}
    try { text = safeStr(view.text && view.text()); } catch (_e) {}
    try { placeholder = safeStr(view.placeholder && view.placeholder()); } catch (_e) {}
    const out = {
        depth,
        className: viewClassName(view),
        frame,
        interactive: isInteractive(view),
    };
    if (label) out.label = label;
    if (identifier) out.identifier = identifier;
    if (text) out.text = text;
    if (placeholder) out.placeholder = placeholder;
    if (frame) out.center = [frame[0] + frame[2] / 2, frame[1] + frame[3] / 2];
    return out;
}

/**
 * 深度优先遍历。回调返回 true 停止遍历。
 */
function walk(view, window, depth, cb, opts) {
    if (!isVisible(view) && !opts.includeHidden) return false;
    if (cb(view, depth)) return true;
    let subs;
    try { subs = view.subviews(); } catch (_e) { return false; }
    if (!subs) return false;
    const count = subs.count();
    for (let i = 0; i < count; i++) {
        const sub = subs.objectAtIndex_(i);
        if (walk(sub, window, depth + 1, cb, opts)) return true;
    }
    return false;
}

// =========================================================
// 查询
// =========================================================
function matches(view, q) {
    if (q.className) {
        const cn = viewClassName(view);
        if (q.classNameExact) {
            if (cn !== q.className) return false;
        } else {
            if (!cn.toLowerCase().includes(q.className.toLowerCase())) return false;
        }
    }
    if (q.identifier) {
        try {
            const id = safeStr(view.accessibilityIdentifier && view.accessibilityIdentifier());
            if (id !== q.identifier) return false;
        } catch (_e) { return false; }
    }
    if (q.identifierContains) {
        try {
            const id = safeStr(view.accessibilityIdentifier && view.accessibilityIdentifier());
            if (!id) return false;
            if (!id.toLowerCase().includes(q.identifierContains.toLowerCase())) return false;
        } catch (_e) { return false; }
    }
    if (q.labelContains) {
        try {
            const lbl = safeStr(view.accessibilityLabel && view.accessibilityLabel());
            if (!lbl) return false;
            if (!lbl.toLowerCase().includes(q.labelContains.toLowerCase())) return false;
        } catch (_e) { return false; }
    }
    if (q.labelEquals) {
        try {
            const lbl = safeStr(view.accessibilityLabel && view.accessibilityLabel());
            if (!lbl || lbl.toLowerCase() !== q.labelEquals.toLowerCase()) return false;
        } catch (_e) { return false; }
    }
    if (q.placeholderContains) {
        try {
            const ph = safeStr(view.placeholder && view.placeholder());
            if (!ph) return false;
            if (!ph.toLowerCase().includes(q.placeholderContains.toLowerCase())) return false;
        } catch (_e) { return false; }
    }
    if (q.interactiveOnly && !isInteractive(view)) return false;
    return true;
}

export function windowFrame() {
    const window = getKeyWindow();
    if (window === null) return null;
    return nodeInfo(window, window, 0);
}

export function findView(query) {
    const window = getKeyWindow();
    if (window === null) return null;
    let hit = null;
    walk(window, window, 0, function (view, depth) {
        if (matches(view, query)) {
            hit = nodeInfo(view, window, depth);
            return true;
        }
        return false;
    }, { includeHidden: false });
    return hit;
}

export function findViews(query) {
    const window = getKeyWindow();
    if (window === null) return [];
    const out = [];
    walk(window, window, 0, function (view, depth) {
        if (matches(view, query)) out.push(nodeInfo(view, window, depth));
        return false;
    }, { includeHidden: false });
    return out;
}

export function dumpTree(opts) {
    opts = opts || {};
    const window = getKeyWindow();
    if (window === null) return { error: 'no key window' };
    const root = nodeInfo(window, window, 0);
    root.children = [];

    function visit(view, parent, depth) {
        if (!isVisible(view) && !opts.includeHidden) return;
        const info = nodeInfo(view, window, depth);
        info.children = [];
        parent.children.push(info);
        let subs;
        try { subs = view.subviews(); } catch (_e) { return; }
        if (!subs) return;
        const n = subs.count();
        for (let i = 0; i < n; i++) visit(subs.objectAtIndex_(i), info, depth + 1);
    }
    let subs;
    try { subs = window.subviews(); } catch (_e) { subs = null; }
    if (subs) {
        const n = subs.count();
        for (let i = 0; i < n; i++) visit(subs.objectAtIndex_(i), root, 1);
    }

    if (opts.interactiveOnly) {
        const prune = (node) => {
            node.children = node.children.filter(prune);
            return node.interactive || node.children.length > 0;
        };
        prune(root);
    }
    return root;
}

// =========================================================
// 弹窗检测
// =========================================================
const MODAL_CLASS_PATTERNS = [
    /AlertController/i,
    /UIAlert/i,
    /Modal/i,
    /Sheet/i,
    /Popup/i,
    /Dialog/i,
    /PresentationController/i,
];

function looksLikeModal(view) {
    const name = viewClassName(view);
    for (const re of MODAL_CLASS_PATTERNS) if (re.test(name)) return true;
    return false;
}

/**
 * 检测 keyWindow 顶层是否存在中间弹窗容器，若存在则枚举其中可点按钮。
 * 规则：
 *   - 命中常见 modal 类名；或
 *   - presentedViewController 链末端的 view（iOS 标准模态）
 * @returns {null | { container: NodeInfo, buttons: NodeInfo[], texts: string[] }}
 */
export function dumpModalView() {
    const window = getKeyWindow();
    if (window === null) return null;

    let candidate = null;

    // 先找 presentedViewController 的 view（iOS 标准模态）
    try {
        const app = getApi().UIApplication.sharedApplication();
        const rootVC = app.keyWindow() ? app.keyWindow().rootViewController() : null;
        let vc = rootVC;
        while (vc && vc.presentedViewController && !vc.presentedViewController().handle.isNull()) {
            vc = vc.presentedViewController();
        }
        if (vc && vc !== rootVC && vc.view) {
            const v = vc.view();
            if (v && !v.handle.isNull() && isVisible(v)) candidate = v;
        }
    } catch (_e) { /* ignore */ }

    // 再按类名匹配
    if (candidate === null) {
        walk(window, window, 0, function (view, _depth) {
            if (looksLikeModal(view)) {
                candidate = view;
                return true;
            }
            return false;
        }, { includeHidden: false });
    }

    // 注意：不再使用"直属子视图覆盖率 >= 50% + 含多个 UIControl"的启发式，
    // 在 TikTok feed 上它会把主视频视图误识别成 modal（子视图带很多 UIControl）。
    // 真正的 modal 几乎都能被 presentedViewController 链 或 MODAL_CLASS_PATTERNS 命中。

    if (candidate === null) return null;

    const buttons = [];
    const texts = [];
    walk(candidate, window, 0, function (view, depth) {
        if (isInteractive(view)) {
            buttons.push(nodeInfo(view, window, depth));
        } else {
            try {
                const lbl = safeStr(view.accessibilityLabel && view.accessibilityLabel());
                const txt = safeStr(view.text && view.text());
                if (lbl && lbl.length > 2 && !texts.includes(lbl)) texts.push(lbl);
                else if (txt && txt.length > 2 && !texts.includes(txt)) texts.push(txt);
            } catch (_e) { /* ignore */ }
        }
        return false;
    }, { includeHidden: false });

    return {
        container: nodeInfo(candidate, window, 0),
        buttons,
        texts,
    };
}

// =========================================================
// 登录拦截页（AWELoginWindow / SignUp / Onboarding 等）
// =========================================================
const LOGIN_GATE_WINDOW_PATTERNS = [
    /Login/i, /SignUp/i, /SignIn/i, /Onboarding/i, /Registration/i,
];
// 登录页的文案关键词（任一命中即视为登录页）
const LOGIN_TEXT_KEYWORDS = [
    // zh
    "注册 TikTok", "登录 TikTok", "已有账号", "立即登录", "使用手机号码", "请登录",
    // en
    "sign up for tiktok", "log in to tiktok", "sign up", "already have an account",
    "use phone", "use email", "log in",
    // ja
    "tiktokに登録", "tiktokにログイン", "既にアカウント",
];

function textLooksLikeLogin(text) {
    if (!text) return false;
    const lo = text.toLowerCase();
    for (const k of LOGIN_TEXT_KEYWORDS) {
        if (lo.indexOf(k.toLowerCase()) >= 0) return true;
    }
    return false;
}

/**
 * 检测是否有登录/注册拦截窗（类名或文案匹配）。
 * 命中后返回 { container, closeButton, buttons, texts }，未命中返回 null。
 *
 * 注意：尽管文案关键词目前偏 TikTok，函数本身是通用的——只扫 `UIApplication.windows`
 * 的类名与文案，任何 App 都可以通过这个 RPC 提供自己的"登录窗检测"能力。
 */
export function dumpLoginGate() {
    const api = getApi();
    const app = api.UIApplication.sharedApplication();
    const wins = app.windows();
    if (!wins) return null;
    const count = wins.count();

    let gate = null;
    // 1) 扫描所有 window，看哪个类名命中
    for (let i = 0; i < count; i++) {
        const w = wins.objectAtIndex_(i);
        if (!w || w.handle.isNull()) continue;
        if (!isVisible(w)) continue;
        const name = viewClassName(w);
        for (const re of LOGIN_GATE_WINDOW_PATTERNS) {
            if (re.test(name)) { gate = w; break; }
        }
        if (gate) break;
    }

    // 2) 若类名没命中，扫描所有 window 的子树文案
    if (gate === null) {
        for (let i = 0; i < count; i++) {
            const w = wins.objectAtIndex_(i);
            if (!w || w.handle.isNull()) continue;
            if (!isVisible(w)) continue;
            let hit = false;
            walk(w, w, 0, function (v) {
                let t = null;
                try { t = safeStr(v.text && v.text()); } catch (_e) {}
                if (!t) try { t = safeStr(v.accessibilityLabel && v.accessibilityLabel()); } catch (_e) {}
                if (textLooksLikeLogin(t)) { hit = true; return true; }
                return false;
            }, { includeHidden: false });
            if (hit) { gate = w; break; }
        }
    }

    if (gate === null) return null;

    const buttons = [];
    const texts = [];
    walk(gate, gate, 0, function (view, depth) {
        if (isInteractive(view)) {
            buttons.push(nodeInfo(view, gate, depth));
        } else {
            try {
                const lbl = safeStr(view.accessibilityLabel && view.accessibilityLabel());
                const txt = safeStr(view.text && view.text());
                if (lbl && lbl.length > 1 && !texts.includes(lbl)) texts.push(lbl);
                else if (txt && txt.length > 1 && !texts.includes(txt)) texts.push(txt);
            } catch (_e) {}
        }
        return false;
    }, { includeHidden: false });

    // 识别关闭按钮：accessibilityLabel / text 命中"关闭/Close/X/×"
    const closeKeywords = ["关闭", "close", "x", "×", "閉じる", "취소", "cancel"];
    let closeButton = null;
    for (const b of buttons) {
        const lbl = (b.label || b.text || "").toLowerCase();
        for (const k of closeKeywords) {
            if (lbl === k || (lbl.length <= 3 && lbl.indexOf(k) >= 0)) {
                closeButton = b; break;
            }
        }
        if (closeButton) break;
    }
    // 退而求其次：找右上角最小的 UIButton（常见关闭样式）
    if (closeButton === null) {
        let best = null;
        for (const b of buttons) {
            if (!b.frame) continue;
            const [x, y, w, h] = b.frame;
            if (x > 300 && y < 100 && w < 60 && h < 60) {
                if (!best || (w * h) < (best.frame[2] * best.frame[3])) best = b;
            }
        }
        closeButton = best;
    }

    return {
        container: nodeInfo(gate, gate, 0),
        buttons,
        texts,
        closeButton,
    };
}

// =========================================================
// 焦点输入框
// =========================================================
export function firstResponderInfo() {
    const window = getKeyWindow();
    if (window === null) return null;
    let fr = null;
    walk(window, window, 0, function (view, _depth) {
        try {
            if (view.isFirstResponder && view.isFirstResponder()) {
                fr = view;
                return true;
            }
        } catch (_e) { /* ignore */ }
        return false;
    }, { includeHidden: false });
    if (fr === null) return null;
    const info = nodeInfo(fr, window, -1);
    info.canInsertText = ('- insertText:' in fr);
    return info;
}

/**
 * 返回当前 firstResponder 的 ObjC 对象引用（供 text_input 使用）。
 * 非 RPC；内部工具。
 */
export function getFirstResponderView() {
    const window = getKeyWindow();
    if (window === null) return null;
    let fr = null;
    walk(window, window, 0, function (view) {
        try {
            if (view.isFirstResponder && view.isFirstResponder()) {
                fr = view;
                return true;
            }
        } catch (_e) { /* ignore */ }
        return false;
    }, { includeHidden: false });
    return fr;
}
