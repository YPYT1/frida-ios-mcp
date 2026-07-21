/**
 * In-process TTNet JSON request (App MetaSec signs automatically).
 *
 * Prefer:
 *   -[TTNetworkManager requestForJSONWithResponse:params:method:needCommonParams:callback:]
 * Fallback:
 *   -[TTNetworkManager requestForJSONWithURL:params:method:needCommonParams:callback:]
 */
import ObjC from 'frida-objc-bridge';

function safeStr(v) {
  try {
    if (v == null) return '';
    return String(v);
  } catch (_e) {
    return '';
  }
}

function truncate(s, n) {
  const str = String(s == null ? '' : s);
  if (str.length <= n) return str;
  return str.slice(0, n) + '…(+' + (str.length - n) + ')';
}

function mgrInstance() {
  const Mgr = ObjC.classes.TTNetworkManagerChromium || ObjC.classes.TTNetworkManager;
  if (!Mgr) return null;
  try {
    const inst = Mgr.shareInstance();
    if (!inst || inst.handle.isNull()) return null;
    return inst;
  } catch (_e) {
    return null;
  }
}

function toNSDictionary(obj) {
  const dict = ObjC.classes.NSMutableDictionary.alloc().init();
  if (!obj || typeof obj !== 'object') return dict;
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const v = obj[k];
    if (v == null) continue;
    try {
      if (typeof v === 'number') {
        dict.setObject_forKey_(ObjC.classes.NSNumber.numberWithDouble_(v), k);
      } else if (typeof v === 'boolean') {
        dict.setObject_forKey_(ObjC.classes.NSNumber.numberWithBool_(v), k);
      } else if (typeof v === 'object') {
        dict.setObject_forKey_(
          ObjC.classes.NSString.stringWithString_(JSON.stringify(v)),
          k,
        );
      } else {
        dict.setObject_forKey_(ObjC.classes.NSString.stringWithString_(String(v)), k);
      }
    } catch (_e) { /* skip bad value */ }
  }
  return dict;
}

function objcToJson(obj, maxDepth, maxLen) {
  maxDepth = maxDepth == null ? 8 : maxDepth;
  maxLen = maxLen == null ? 12000 : maxLen;
  function walk(o, depth) {
    if (o == null || (o.handle && o.handle.isNull())) return null;
    if (depth <= 0) return '[MaxDepth]';
    try {
      if (!o.handle) {
        if (typeof o === 'string' || typeof o === 'number' || typeof o === 'boolean') return o;
        return safeStr(o);
      }
      const cls = o.$className || '';
      if (cls === 'NSString' || cls.indexOf('String') >= 0) return safeStr(o);
      if (cls === 'NSNumber' || o.objCType) {
        try {
          return Number(o);
        } catch (_e) {
          return safeStr(o);
        }
      }
      if (o.isKindOfClass_(ObjC.classes.NSArray)) {
        const n = Math.min(Number(o.count()), 80);
        const arr = [];
        for (let i = 0; i < n; i++) arr.push(walk(o.objectAtIndex_(i), depth - 1));
        if (Number(o.count()) > n) arr.push('…(+)' + (Number(o.count()) - n));
        return arr;
      }
      if (o.isKindOfClass_(ObjC.classes.NSDictionary)) {
        const keys = o.allKeys();
        const n = Math.min(Number(keys.count()), 120);
        const out = {};
        // Prefer identity fields first so truncation keeps aweme_id / desc
        const prefer = [
          'aweme_id',
          'awemeId',
          'group_id',
          'desc',
          'title',
          'create_time',
          'createTime',
          'statistics',
          'stats',
          'aweme_list',
          'status_code',
          'max_cursor',
          'has_more',
          'share_info',
          'share_url',
        ];
        const keyStrs = [];
        for (let i = 0; i < n; i++) keyStrs.push(safeStr(keys.objectAtIndex_(i)));
        const ordered = prefer.filter((k) => keyStrs.indexOf(k) >= 0).concat(
          keyStrs.filter((k) => prefer.indexOf(k) < 0),
        );
        for (let i = 0; i < ordered.length; i++) {
          const k = ordered[i];
          out[k] = walk(o.objectForKey_(k), depth - 1);
        }
        return out;
      }
      return safeStr(o);
    } catch (_e) {
      return safeStr(o);
    }
  }
  const raw = walk(obj, maxDepth);
  let s = '';
  try {
    s = JSON.stringify(raw);
  } catch (_e) {
    s = safeStr(raw);
  }
  return {
    json: truncate(s, maxLen),
    truncated: s.length > maxLen,
    length: s.length,
  };
}

/**
 * @param {object} options
 * @returns {Promise-like via sync wait} — Frida RPC is sync; we block with recv pattern using a latch.
 */
export function ttnetRequest(options) {
  const opts = options || {};
  const url = String(opts.url || '');
  if (!url) return { ok: false, error: 'url required' };
  const method = String(opts.method || 'GET').toUpperCase();
  const needCommonParams = opts.needCommonParams !== false;
  const timeoutMs = Math.max(1000, Math.min(60000, Number(opts.timeoutMs) || 15000));
  const maxBody = Math.max(512, Number(opts.maxBody) || 12000);

  const mgr = mgrInstance();
  if (!mgr) return { ok: false, error: 'TTNetworkManager shareInstance unavailable' };

  const params = toNSDictionary(opts.params || {});
  const headerField =
    opts.headerField && typeof opts.headerField === 'object'
      ? toNSDictionary(opts.headerField)
      : null;

  let done = false;
  let result = { ok: false, error: 'timeout' };

  const finish = (payload) => {
    if (done) return;
    done = true;
    result = payload;
  };

  // Callback: (NSError *error, id obj) OR (NSError *error, id obj, TTHttpResponse *response)
  const makeBlock2 = () =>
    new ObjC.Block({
      retType: 'void',
      argTypes: ['object', 'object'],
      implementation(error, obj) {
        try {
          if (error && !error.isNull()) {
            finish({
              ok: false,
              error: safeStr(new ObjC.Object(error).localizedDescription()),
              url,
              method,
            });
            return;
          }
          const body = obj && !obj.isNull() ? objcToJson(new ObjC.Object(obj), 6, maxBody) : null;
          finish({ ok: true, url, method, body });
        } catch (e) {
          finish({ ok: false, error: String(e), url, method });
        }
      },
    });

  const makeBlock3 = () =>
    new ObjC.Block({
      retType: 'void',
      argTypes: ['object', 'object', 'object'],
      implementation(error, obj, response) {
        try {
          let status = undefined;
          try {
            if (response && !response.isNull()) {
              status = Number(new ObjC.Object(response).statusCode());
            }
          } catch (_e) { /* */ }
          if (error && !error.isNull()) {
            finish({
              ok: false,
              error: safeStr(new ObjC.Object(error).localizedDescription()),
              url,
              method,
              status,
            });
            return;
          }
          const body = obj && !obj.isNull() ? objcToJson(new ObjC.Object(obj), 6, maxBody) : null;
          finish({ ok: true, url, method, status, body });
        } catch (e) {
          finish({ ok: false, error: String(e), url, method });
        }
      },
    });

  let api = null;
  try {
    // Prefer WithResponse variants
    if (
      mgr.respondsToSelector_(
        ObjC.selector('requestForJSONWithResponse:params:method:needCommonParams:callback:'),
      )
    ) {
      api = 'requestForJSONWithResponse:params:method:needCommonParams:callback:';
      mgr['- requestForJSONWithResponse:params:method:needCommonParams:callback:'](
        url,
        params,
        method,
        needCommonParams,
        makeBlock2(),
      );
    } else if (
      mgr.respondsToSelector_(
        ObjC.selector('requestForJSONWithURL:params:method:needCommonParams:callback:'),
      )
    ) {
      api = 'requestForJSONWithURL:params:method:needCommonParams:callback:';
      mgr['- requestForJSONWithURL:params:method:needCommonParams:callback:'](
        url,
        params,
        method,
        needCommonParams,
        makeBlock2(),
      );
    } else if (
      mgr.respondsToSelector_(
        ObjC.selector(
          'requestForJSONWithResponse:params:method:needCommonParams:headerField:requestSerializer:responseSerializer:autoResume:callback:',
        ),
      )
    ) {
      api =
        'requestForJSONWithResponse:params:method:needCommonParams:headerField:requestSerializer:responseSerializer:autoResume:callback:';
      mgr[
        '- requestForJSONWithResponse:params:method:needCommonParams:headerField:requestSerializer:responseSerializer:autoResume:callback:'
      ](url, params, method, needCommonParams, headerField, null, null, true, makeBlock2());
    } else {
      return { ok: false, error: 'No supported requestForJSON* selector on TTNetworkManager' };
    }
  } catch (e) {
    // Retry with 3-arg block if 2-arg crashed at invoke time — caller sees timeout/error
    try {
      if (
        mgr.respondsToSelector_(
          ObjC.selector('requestForJSONWithResponse:params:method:needCommonParams:callback:'),
        )
      ) {
        api = 'requestForJSONWithResponse:params:method:needCommonParams:callback:(block3)';
        mgr['- requestForJSONWithResponse:params:method:needCommonParams:callback:'](
          url,
          params,
          method,
          needCommonParams,
          makeBlock3(),
        );
      } else {
        return { ok: false, error: String(e), api };
      }
    } catch (e2) {
      return { ok: false, error: String(e2), api };
    }
  }

  const start = Date.now();
  while (!done && Date.now() - start < timeoutMs) {
    Thread.sleep(0.05);
  }
  if (!done) {
    return { ok: false, error: 'timeout', url, method, api, timeoutMs };
  }
  result.api = api;
  result.elapsedMs = Date.now() - start;
  return result;
}

export function ttnetStatus() {
  const MgrC = ObjC.classes.TTNetworkManagerChromium;
  const Mgr = ObjC.classes.TTNetworkManager;
  const inst = mgrInstance();
  return {
    ok: true,
    hasChromium: !!MgrC,
    hasBase: !!Mgr,
    shareOk: !!inst,
    className: inst ? inst.$className : null,
    selectors: {
      jsonUrl: !!(
        inst &&
        inst.respondsToSelector_(
          ObjC.selector('requestForJSONWithURL:params:method:needCommonParams:callback:'),
        )
      ),
      jsonResponse: !!(
        inst &&
        inst.respondsToSelector_(
          ObjC.selector('requestForJSONWithResponse:params:method:needCommonParams:callback:'),
        )
      ),
    },
  };
}
