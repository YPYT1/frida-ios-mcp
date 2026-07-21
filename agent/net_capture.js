/**
 * In-process HTTP capture (read-only).
 *
 * Layers:
 *   - nsurl: NSURLSession task creation (+ optional completionHandler wrap)
 *   - ttnet: TikTok TTHttpTaskChromium after request filters ( Cronet path )
 *
 * captureMode: "nsurl" | "ttnet" | "all" (default all)
 * captureResponse: NSURLSession completion wrap only (TTNet response hooks are unstable).
 *
 * TTNet captures headers AFTER runRequestFiltersAndStart (includes x-Tt-Token etc.).
 * Native Cronet-only headers not mirrored to TTHttpRequest may still be missing.
 */
import ObjC from 'frida-objc-bridge';

const MAX_ENTRIES = 500;
const entries = [];
let enabled = false;
let seq = 0;
let opts = {
    maxBody: 4096,
    captureResponse: false,
    urlFilter: '',
    captureMode: 'all',
};
let hooksInstalled = false;
const hooked = [];
let ttnetHooksInstalled = false;
let nsurlHooksInstalled = false;

const SIGN_HEADER_RE =
    /gorgon|argus|ladon|khronos|helios|medusa|metasec|x-ss-stub|x-ss-req-ticket|x-tt-token|x-tt-dt|x-tt-multi|x-bd-kmsv|mstoken|x-vc-bdturing|x-ttnet-request|tt-request-time/i;

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

function headersFromDict(all) {
    const out = {};
    try {
        if (!all || all.handle.isNull()) return out;
        const keys = all.allKeys();
        const count = Number(keys.count());
        for (let i = 0; i < Math.min(count, 100); i++) {
            const keyObj = keys.objectAtIndex_(i);
            out[safeStr(keyObj)] = truncate(safeStr(all.objectForKey_(keyObj)), 1200);
        }
    } catch (_e) { /* ignore */ }
    return out;
}

function headersFromReq(req) {
    try {
        return headersFromDict(req.allHTTPHeaderFields());
    } catch (_e) {
        return {};
    }
}

function headersFromResp(resp) {
    try {
        if (resp.allHeaderFields) return headersFromDict(resp.allHeaderFields());
        if (resp.allHTTPHeaderFields) return headersFromDict(resp.allHTTPHeaderFields());
    } catch (_e) { /* */ }
    return {};
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

function extractSignHeaders(headers) {
    if (!headers) return undefined;
    const sign = {};
    const keys = Object.keys(headers);
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (SIGN_HEADER_RE.test(k)) sign[k] = headers[k];
    }
    return Object.keys(sign).length ? sign : undefined;
}

function parseQueryParams(url) {
    try {
        const q = {};
        const i = url.indexOf('?');
        if (i < 0) return undefined;
        const qs = url.slice(i + 1);
        const parts = qs.split('&');
        for (let p = 0; p < Math.min(parts.length, 80); p++) {
            const part = parts[p];
            if (!part) continue;
            const eq = part.indexOf('=');
            const k = decodeURIComponent(eq >= 0 ? part.slice(0, eq) : part);
            const v = decodeURIComponent(eq >= 0 ? part.slice(eq + 1) : '');
            q[k] = truncate(v, 400);
        }
        return Object.keys(q).length ? q : undefined;
    } catch (_e) {
        return undefined;
    }
}

function responseMeta(response) {
    const meta = {};
    if (!response || response.isNull()) return meta;
    try {
        const r = new ObjC.Object(response);
        try { meta.status = Number(r.statusCode()); } catch (_e) { /* */ }
        try { meta.mimeType = safeStr(r.MIMEType()); } catch (_e) { /* */ }
        try { meta.responseHeaders = headersFromResp(r); } catch (_e) { /* */ }
    } catch (_e) { /* */ }
    return meta;
}

function modeIncludes(layer) {
    const m = String(opts.captureMode || 'all').toLowerCase();
    if (m === 'all') return true;
    return m === layer;
}

function pushEntry(entry) {
    if (!enabled) return;
    if (opts.urlFilter) {
        try {
            const re = new RegExp(opts.urlFilter, 'i');
            if (!re.test(entry.url || '')) return;
        } catch (_e) { /* ignore */ }
    }
    const last = entries[entries.length - 1];
    if (
        last &&
        last.phase === entry.phase &&
        last.stack === entry.stack &&
        last.url === entry.url &&
        last.method === entry.method &&
        Date.now() - last.ts < 80
    ) {
        return;
    }
    entry.id = ++seq;
    entry.ts = Date.now();
    if (entry.headers && !entry.signHeaders) {
        entry.signHeaders = extractSignHeaders(entry.headers);
    }
    if (entry.requestHeaders && !entry.signHeaders) {
        entry.signHeaders = extractSignHeaders(entry.requestHeaders);
    }
    if (entry.url && !entry.query) {
        entry.query = parseQueryParams(entry.url);
    }
    entries.push(entry);
    while (entries.length > MAX_ENTRIES) entries.shift();
    try {
        send({
            type: 'net',
            entry: {
                id: entry.id,
                phase: entry.phase,
                stack: entry.stack,
                method: entry.method,
                url: entry.url,
                status: entry.status,
                hasSign: !!entry.signHeaders,
            },
        });
    } catch (_e) { /* */ }
}

function captureFromRequest(req, api, stack) {
    try {
        const url = safeStr(req.URL() && req.URL().absoluteString());
        const method = safeStr(req.HTTPMethod() || 'GET');
        const headers = headersFromReq(req);
        const body = bodyFromReq(req);
        const base = { method, url, headers, body, api, stack };
        pushEntry({ phase: 'request', method, url, headers, body, api, stack });
        return base;
    } catch (_e) {
        return { method: '?', url: '', headers: {}, body: null, api, stack };
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
                        stack: 'nsurl',
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

function tryHookNsurl(name, selector, onEnter) {
    try {
        const NSURLSession = ObjC.classes.NSURLSession;
        const method = NSURLSession[selector];
        if (!method || !method.implementation) return false;
        Interceptor.attach(method.implementation, { onEnter });
        hooked.push('nsurl:' + name);
        return true;
    } catch (_e) {
        return false;
    }
}

function installNsurlHooks() {
    if (nsurlHooksInstalled) return { ok: true, already: true };
    if (!ObjC.available) return { ok: false, error: 'ObjC not available' };
    if (!ObjC.classes.NSURLSession) return { ok: false, error: 'NSURLSession missing' };

    tryHookNsurl('dataTaskWithRequest:completionHandler:', '- dataTaskWithRequest:completionHandler:', function (args) {
        if (!enabled || !modeIncludes('nsurl')) return;
        try {
            const req = new ObjC.Object(args[2]);
            const base = captureFromRequest(req, 'dataTaskWithRequest:completionHandler:', 'nsurl');
            if (opts.captureResponse) args[3] = wrapCompletion(args[3], base);
        } catch (_e) { /* */ }
    });

    tryHookNsurl('dataTaskWithRequest:', '- dataTaskWithRequest:', function (args) {
        if (!enabled || !modeIncludes('nsurl')) return;
        try {
            const req = new ObjC.Object(args[2]);
            captureFromRequest(req, 'dataTaskWithRequest:', 'nsurl');
        } catch (_e) { /* */ }
    });

    tryHookNsurl('dataTaskWithURL:completionHandler:', '- dataTaskWithURL:completionHandler:', function (args) {
        if (!enabled || !modeIncludes('nsurl')) return;
        try {
            const urlObj = new ObjC.Object(args[2]);
            const url = safeStr(urlObj.absoluteString && urlObj.absoluteString());
            const base = { method: 'GET', url, headers: {}, body: null, api: 'dataTaskWithURL:completionHandler:', stack: 'nsurl' };
            pushEntry({ phase: 'request', ...base });
            if (opts.captureResponse) args[3] = wrapCompletion(args[3], base);
        } catch (_e) { /* */ }
    });

    tryHookNsurl('dataTaskWithURL:', '- dataTaskWithURL:', function (args) {
        if (!enabled || !modeIncludes('nsurl')) return;
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
                stack: 'nsurl',
            });
        } catch (_e) { /* */ }
    });

    tryHookNsurl(
        'uploadTaskWithRequest:fromData:completionHandler:',
        '- uploadTaskWithRequest:fromData:completionHandler:',
        function (args) {
            if (!enabled || !modeIncludes('nsurl')) return;
            try {
                const req = new ObjC.Object(args[2]);
                const base = captureFromRequest(req, 'uploadTaskWithRequest:fromData:completionHandler:', 'nsurl');
                try {
                    if (!base.body && args[3] && !args[3].isNull()) {
                        base.body = bodyFromData(new ObjC.Object(args[3]));
                    }
                } catch (_e) { /* */ }
                if (opts.captureResponse) args[4] = wrapCompletion(args[4], base);
            } catch (_e) { /* */ }
        },
    );

    nsurlHooksInstalled = true;
    return { ok: true, already: false };
}

function tryHookTtnet(cls, name, selector, callbacks) {
    try {
        const method = cls[selector];
        if (!method || !method.implementation) return false;
        Interceptor.attach(method.implementation, callbacks);
        hooked.push('ttnet:' + name);
        return true;
    } catch (_e) {
        return false;
    }
}

function installTtnetHooks() {
    if (ttnetHooksInstalled) return { ok: true, already: true, present: true };
    if (!ObjC.available) return { ok: false, error: 'ObjC not available' };

    const C = ObjC.classes.TTHttpTaskChromium;
    const R = ObjC.classes.TTHttpRequest;
    if (!C) {
        return { ok: true, present: false, note: 'TTHttpTaskChromium not in this process' };
    }

    // Capture AFTER request filters — signed / token headers are usually present here.
    // Do not also hook resume (would double-count the same request).
    tryHookTtnet(C, 'runRequestFiltersAndStart', '- runRequestFiltersAndStart', {
        onEnter(args) {
            this._self = new ObjC.Object(args[0]);
        },
        onLeave(_retval) {
            if (!enabled || !modeIncludes('ttnet')) return;
            try {
                const req = this._self.request();
                if (!req || req.handle.isNull()) return;
                captureFromRequest(req, 'TTHttpTaskChromium.runRequestFiltersAndStart', 'ttnet');
            } catch (_e) { /* */ }
        },
    });

    if (R) {
        const headerSels = [
            '- awenf_setValue:forHTTPHeaderField:',
            '- tspk_util_setValue:forHTTPHeaderField:',
        ];
        for (let i = 0; i < headerSels.length; i++) {
            const sel = headerSels[i];
            tryHookTtnet(R, sel, sel, {
                onEnter(args) {
                    if (!enabled || !modeIncludes('ttnet')) return;
                    try {
                        const value = safeStr(new ObjC.Object(args[2]));
                        const field = safeStr(new ObjC.Object(args[3]));
                        if (!SIGN_HEADER_RE.test(field)) return;
                        pushEntry({
                            phase: 'sign_header',
                            stack: 'ttnet',
                            api: 'TTHttpRequest' + sel,
                            method: 'SET',
                            url: '',
                            field,
                            value: truncate(value, 1200),
                            headers: { [field]: truncate(value, 1200) },
                            signHeaders: { [field]: truncate(value, 1200) },
                        });
                    } catch (_e) { /* */ }
                },
            });
        }
    }

    ttnetHooksInstalled = true;
    return { ok: true, present: true, already: false };
}

function installHooks() {
    if (hooksInstalled) {
        return {
            ok: true,
            already: true,
            hooked: hooked.slice(),
            nsurl: nsurlHooksInstalled,
            ttnet: ttnetHooksInstalled,
        };
    }
    const ns = installNsurlHooks();
    const tt = installTtnetHooks();
    if (!ns.ok && !tt.ok) {
        return { ok: false, error: (ns.error || '') + ' ' + (tt.error || '') };
    }
    if (hooked.length === 0 && !tt.present) {
        return { ok: false, error: 'No network hooks installed' };
    }
    hooksInstalled = true;
    return {
        ok: true,
        already: false,
        hooked: hooked.slice(),
        nsurl: ns,
        ttnet: tt,
    };
}

function normalizeMode(v) {
    const m = String(v == null ? 'all' : v).toLowerCase();
    if (m === 'nsurl' || m === 'ttnet' || m === 'all') return m;
    return 'all';
}

export function netEnable(options) {
    const next = {
        maxBody: 4096,
        captureResponse: false,
        urlFilter: '',
        captureMode: 'all',
    };
    if (options && typeof options === 'object') {
        if (options.maxBody != null) {
            next.maxBody = Math.max(256, Number(options.maxBody) || 4096);
        }
        if (options.captureResponse != null) {
            next.captureResponse = !!options.captureResponse;
        }
        if (Object.prototype.hasOwnProperty.call(options, 'urlFilter')) {
            next.urlFilter = String(options.urlFilter == null ? '' : options.urlFilter);
        }
        if (Object.prototype.hasOwnProperty.call(options, 'captureMode')) {
            next.captureMode = normalizeMode(options.captureMode);
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
        layers: {
            nsurl: nsurlHooksInstalled,
            ttnet: ttnetHooksInstalled,
            ttnetPresent: !!(ObjC.classes && ObjC.classes.TTHttpTaskChromium),
        },
        note:
            'captureMode=nsurl|ttnet|all. TTNet = TikTok Cronet (TTHttpTaskChromium) after filters. ' +
            'captureResponse only wraps NSURLSession (TTNet response hooks unstable). ' +
            'Use net_dump({redact:false, dedupe:false}) for reverse-engineering.',
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
        layers: {
            nsurl: nsurlHooksInstalled,
            ttnet: ttnetHooksInstalled,
            ttnetPresent: !!(ObjC.classes && ObjC.classes.TTHttpTaskChromium),
        },
    };
}

export function netDump(options) {
    const limit = Math.min(MAX_ENTRIES, Math.max(1, Number((options && options.limit) || 50)));
    const query = options && options.query ? String(options.query).toLowerCase() : '';
    let list = entries.slice();
    if (query) {
        list = list.filter((e) => {
            const blob = [
                e.url,
                e.method,
                e.api,
                e.phase,
                e.stack,
                e.field,
                e.error,
                String(e.status || ''),
                e.signHeaders ? JSON.stringify(e.signHeaders) : '',
            ]
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
