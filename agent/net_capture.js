/**
 * NSURLSession 网络请求捕获（只读，不修改流量）。
 *
 * 默认只 hook request 创建路径，不包装 completionHandler（更稳）。
 * captureResponse=true 时才包装 Block，部分 App/iOS 版本可能不稳。
 *
 * 覆盖：
 *   - dataTaskWithRequest: / dataTaskWithRequest:completionHandler:
 *   - dataTaskWithURL: / dataTaskWithURL:completionHandler:
 *   - uploadTaskWithRequest:fromData:completionHandler:（可选）
 */
import ObjC from 'frida-objc-bridge';

const MAX_ENTRIES = 300;
const entries = [];
let enabled = false;
let seq = 0;
let opts = {
    maxBody: 4096,
    captureResponse: false, // safer default
    urlFilter: '',
};
let hooksInstalled = false;
const hooked = [];

function safeStr(v) {
    try {
        if (v === null || v === undefined) return '';
        if (typeof v === 'string') return v;
        return v.toString();
    } catch (_e) {
        return '';
    }
}

function truncate(s, n) {
    if (!s) return s;
    const str = String(s);
    if (str.length <= n) return str;
    return str.slice(0, n) + '…(+' + (str.length - n) + ')';
}

function bytesToPreview(byteArray, totalLen, max) {
    try {
        const u8 = new Uint8Array(byteArray);
        let s = '';
        for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
        let binary = false;
        for (let i = 0; i < Math.min(s.length, 64); i++) {
            const c = s.charCodeAt(i);
            if (c < 9 || (c > 13 && c < 32)) {
                binary = true;
                break;
            }
        }
        if (binary) {
            const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
            let out = '';
            for (let i = 0; i < u8.length; i += 3) {
                const a = u8[i];
                const b = i + 1 < u8.length ? u8[i + 1] : 0;
                const c = i + 2 < u8.length ? u8[i + 2] : 0;
                out += chars[a >> 2];
                out += chars[((a & 3) << 4) | (b >> 4)];
                out += i + 1 < u8.length ? chars[((b & 15) << 2) | (c >> 6)] : '=';
                out += i + 2 < u8.length ? chars[c & 63] : '=';
            }
            return { encoding: 'base64', length: totalLen, preview: truncate(out, max) };
        }
        return { encoding: 'utf8', length: totalLen, preview: truncate(s, max) };
    } catch (_e) {
        return { encoding: 'raw', length: totalLen };
    }
}

function headersFrom(req) {
    const out = {};
    try {
        const all = req.allHTTPHeaderFields();
        if (!all || all.handle.isNull()) return out;
        const keys = all.allKeys();
        const count = Number(keys.count());
        for (let i = 0; i < Math.min(count, 80); i++) {
            const keyObj = keys.objectAtIndex_(i);
            out[safeStr(keyObj)] = truncate(safeStr(all.objectForKey_(keyObj)), 800);
        }
    } catch (_e) { /* ignore */ }
    return out;
}

function bodyFromData(data) {
    try {
        if (!data || data.handle.isNull()) return null;
        const len = Number(data.length());
        if (len <= 0) return null;
        const max = opts.maxBody || 4096;
        const n = Math.min(len, max);
        const buf = data.bytes().readByteArray(n);
        return bytesToPreview(buf, len, max);
    } catch (_e) {
        return null;
    }
}

function bodyFromReq(req) {
    try {
        return bodyFromData(req.HTTPBody());
    } catch (_e) {
        return null;
    }
}

function responseMeta(response) {
    const meta = {};
    if (!response || response.isNull()) return meta;
    try {
        const r = new ObjC.Object(response);
        try { meta.status = Number(r.statusCode()); } catch (_e) { /* */ }
        try { meta.mimeType = safeStr(r.MIMEType()); } catch (_e) { /* */ }
        try {
            const rh = r.allHeaderFields && r.allHeaderFields();
            if (rh && !rh.handle.isNull()) {
                const h = {};
                const keys = rh.allKeys();
                for (let i = 0; i < Math.min(Number(keys.count()), 80); i++) {
                    const keyObj = keys.objectAtIndex_(i);
                    h[safeStr(keyObj)] = truncate(safeStr(rh.objectForKey_(keyObj)), 800);
                }
                meta.responseHeaders = h;
            }
        } catch (_e) { /* */ }
    } catch (_e) { /* */ }
    return meta;
}

function pushEntry(entry) {
    if (!enabled) return;
    if (opts.urlFilter) {
        try {
            const re = new RegExp(opts.urlFilter, 'i');
            if (!re.test(entry.url || '')) return;
        } catch (_e) { /* ignore */ }
    }
    // de-dupe burst of identical url within 80ms
    const last = entries[entries.length - 1];
    if (
        last &&
        last.phase === entry.phase &&
        last.url === entry.url &&
        last.method === entry.method &&
        Date.now() - last.ts < 80
    ) {
        return;
    }
    entry.id = ++seq;
    entry.ts = Date.now();
    entries.push(entry);
    while (entries.length > MAX_ENTRIES) entries.shift();
    try {
        send({
            type: 'net',
            entry: {
                id: entry.id,
                phase: entry.phase,
                method: entry.method,
                url: entry.url,
                status: entry.status,
            },
        });
    } catch (_e) { /* */ }
}

function captureFromRequest(req, api) {
    try {
        const url = safeStr(req.URL() && req.URL().absoluteString());
        const method = safeStr(req.HTTPMethod() || 'GET');
        const headers = headersFrom(req);
        const body = bodyFromReq(req);
        const base = { method, url, headers, body, api };
        pushEntry({ phase: 'request', method, url, headers, body, api });
        return base;
    } catch (_e) {
        return { method: '?', url: '', headers: {}, body: null, api };
    }
}

function wrapCompletion(origBlockPtr, base) {
    if (!opts.captureResponse || !origBlockPtr || origBlockPtr.isNull()) {
        return origBlockPtr;
    }
    try {
        const orig = new ObjC.Block(origBlockPtr);
        const origImpl = orig.implementation;
        const block = new ObjC.Block({
            retType: 'void',
            argTypes: ['object', 'object', 'object'],
            implementation(data, response, error) {
                try {
                    const entry = {
                        phase: 'response',
                        method: base.method,
                        url: base.url,
                        requestHeaders: base.headers,
                        requestBody: base.body,
                        api: base.api,
                    };
                    Object.assign(entry, responseMeta(response));
                    if (data && !data.isNull()) {
                        entry.responseBody = bodyFromData(new ObjC.Object(data));
                    }
                    if (error && !error.isNull()) {
                        try {
                            entry.error = safeStr(new ObjC.Object(error).localizedDescription());
                        } catch (_e) {
                            entry.error = 'error';
                        }
                    }
                    pushEntry(entry);
                } catch (_e) { /* never break network */ }
                try {
                    return origImpl(data, response, error);
                } catch (_e2) {
                    return;
                }
            },
        });
        return block;
    } catch (_e) {
        return origBlockPtr;
    }
}

function tryHook(name, selector, onEnter) {
    try {
        const NSURLSession = ObjC.classes.NSURLSession;
        const method = NSURLSession[selector];
        if (!method || !method.implementation) {
            return false;
        }
        Interceptor.attach(method.implementation, { onEnter });
        hooked.push(name);
        return true;
    } catch (_e) {
        return false;
    }
}

function installHooks() {
    if (hooksInstalled) return { ok: true, already: true, hooked: hooked.slice() };
    if (!ObjC.available) return { ok: false, error: 'ObjC not available' };
    if (!ObjC.classes.NSURLSession) return { ok: false, error: 'NSURLSession missing' };

    // Prefer request-path hooks only (stable). Avoid Task.resume reentrancy.
    tryHook('dataTaskWithRequest:completionHandler:', '- dataTaskWithRequest:completionHandler:', function (args) {
        if (!enabled) return;
        try {
            const req = new ObjC.Object(args[2]);
            const base = captureFromRequest(req, 'dataTaskWithRequest:completionHandler:');
            if (opts.captureResponse) {
                args[3] = wrapCompletion(args[3], base);
            }
        } catch (_e) { /* */ }
    });

    tryHook('dataTaskWithRequest:', '- dataTaskWithRequest:', function (args) {
        if (!enabled) return;
        try {
            const req = new ObjC.Object(args[2]);
            captureFromRequest(req, 'dataTaskWithRequest:');
        } catch (_e) { /* */ }
    });

    tryHook('dataTaskWithURL:completionHandler:', '- dataTaskWithURL:completionHandler:', function (args) {
        if (!enabled) return;
        try {
            const urlObj = new ObjC.Object(args[2]);
            const url = safeStr(urlObj.absoluteString && urlObj.absoluteString());
            const base = {
                method: 'GET',
                url,
                headers: {},
                body: null,
                api: 'dataTaskWithURL:completionHandler:',
            };
            pushEntry({ phase: 'request', ...base });
            if (opts.captureResponse) {
                args[3] = wrapCompletion(args[3], base);
            }
        } catch (_e) { /* */ }
    });

    tryHook('dataTaskWithURL:', '- dataTaskWithURL:', function (args) {
        if (!enabled) return;
        try {
            const urlObj = new ObjC.Object(args[2]);
            const url = safeStr(urlObj.absoluteString && urlObj.absoluteString());
            pushEntry({
                phase: 'request',
                method: 'GET',
                url,
                headers: {},
                body: null,
                api: 'dataTaskWithURL:',
            });
        } catch (_e) { /* */ }
    });

    tryHook(
        'uploadTaskWithRequest:fromData:completionHandler:',
        '- uploadTaskWithRequest:fromData:completionHandler:',
        function (args) {
            if (!enabled) return;
            try {
                const req = new ObjC.Object(args[2]);
                const base = captureFromRequest(req, 'uploadTaskWithRequest:fromData:completionHandler:');
                try {
                    if (!base.body && args[3] && !args[3].isNull()) {
                        base.body = bodyFromData(new ObjC.Object(args[3]));
                    }
                } catch (_e) { /* */ }
                if (opts.captureResponse) {
                    args[4] = wrapCompletion(args[4], base);
                }
            } catch (_e) { /* */ }
        },
    );

    if (hooked.length === 0) {
        return { ok: false, error: 'No NSURLSession methods hooked' };
    }

    hooksInstalled = true;
    return { ok: true, already: false, hooked: hooked.slice() };
}

export function netEnable(options) {
    // Each enable rebuilds opts from defaults then applies provided fields.
    // Prevents stale urlFilter when caller only changes maxBody.
    const next = {
        maxBody: 4096,
        captureResponse: false,
        urlFilter: '',
    };
    if (options && typeof options === 'object') {
        if (options.maxBody != null) {
            next.maxBody = Math.max(256, Number(options.maxBody) || 4096);
        }
        if (options.captureResponse != null) {
            next.captureResponse = !!options.captureResponse;
        }
        // urlFilter: any provided value (including "") replaces; omit → default ""
        if (Object.prototype.hasOwnProperty.call(options, 'urlFilter')) {
            next.urlFilter = String(options.urlFilter == null ? '' : options.urlFilter);
        }
    }
    opts = next;
    const r = installHooks();
    if (!r.ok) return r;
    enabled = true;
    return {
        ok: true,
        enabled: true,
        hooksInstalled: true,
        hooked: r.hooked || hooked.slice(),
        opts: Object.assign({}, opts),
        note:
            'In-process NSURLSession only. Each net_enable resets opts (urlFilter defaults to empty). ' +
            'Pass urlFilter each time you need filtering. captureResponse default false.',
    };
}

export function netDisable() {
    enabled = false;
    return { ok: true, enabled: false, retainedEntries: entries.length };
}

export function netClear() {
    entries.length = 0;
    seq = 0;
    return { ok: true, cleared: true };
}

export function netStatus() {
    return {
        enabled,
        hooksInstalled,
        count: entries.length,
        opts: Object.assign({}, opts),
        hooked: hooked.slice(),
        maxEntries: MAX_ENTRIES,
    };
}

export function netDump(options) {
    const limit = Math.min(MAX_ENTRIES, Math.max(1, Number((options && options.limit) || 50)));
    const query = options && options.query ? String(options.query).toLowerCase() : '';
    let list = entries.slice();
    if (query) {
        list = list.filter((e) => {
            const blob = [e.url, e.method, e.api, e.phase, e.error, String(e.status || '')]
                .join(' ')
                .toLowerCase();
            return blob.includes(query);
        });
    }
    const slice = list.slice(-limit);
    return {
        count: list.length,
        returned: slice.length,
        enabled,
        opts: Object.assign({}, opts),
        entries: slice,
    };
}
