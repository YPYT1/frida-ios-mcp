/**
 * Probe agent: NSURLSession request/response capture + optional test fire.
 */
import ObjC from "frida-objc-bridge";

const MAX_ENTRIES = 200;
const entries = [];
let enabled = false;
let seq = 0;
let opts = { maxBody: 4096, captureResponse: true, urlFilter: "" };
let hooksInstalled = false;

function safeStr(v) {
  try {
    if (v === null || v === undefined) return "";
    if (typeof v === "string") return v;
    return v.toString();
  } catch {
    return "";
  }
}

function truncate(s, n) {
  if (!s) return s;
  if (s.length <= n) return s;
  return s.slice(0, n) + `…(+${s.length - n})`;
}

function headersFrom(req) {
  const out = {};
  try {
    const all = req.allHTTPHeaderFields();
    if (!all || all.handle.isNull()) return out;
    const keys = all.allKeys();
    const count = Number(keys.count());
    for (let i = 0; i < count; i++) {
      const k = safeStr(keys.objectAtIndex_(i));
      const v = safeStr(all.objectForKey_(keys.objectAtIndex_(i)));
      out[k] = truncate(v, 500);
    }
  } catch {
    /* ignore */
  }
  return out;
}

function bodyFrom(req) {
  try {
    const data = req.HTTPBody();
    if (!data || data.handle.isNull()) return null;
    const len = Number(data.length());
    if (len <= 0) return null;
    const max = opts.maxBody || 4096;
    const n = Math.min(len, max);
    const buf = data.bytes().readByteArray(n);
    // try utf8
    try {
      const u8 = new Uint8Array(buf);
      let s = "";
      for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
      // detect binary
      if (/[\x00-\x08\x0e-\x1f]/.test(s.slice(0, 64))) {
        return { encoding: "base64", length: len, preview: truncate(btoa(s), max) };
      }
      return { encoding: "utf8", length: len, preview: truncate(s, max) };
    } catch {
      return { encoding: "raw", length: len };
    }
  } catch {
    return null;
  }
}

function dataPreview(data) {
  try {
    if (!data || data.handle.isNull()) return null;
    const len = Number(data.length());
    if (len <= 0) return null;
    const max = opts.maxBody || 4096;
    const n = Math.min(len, max);
    const ptr = data.bytes();
    const buf = ptr.readByteArray(n);
    const u8 = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    if (/[\x00-\x08\x0e-\x1f]/.test(s.slice(0, 64))) {
      return { encoding: "base64", length: len, preview: truncate(btoa(s), max) };
    }
    return { encoding: "utf8", length: len, preview: truncate(s, max) };
  } catch {
    return null;
  }
}

function pushEntry(entry) {
  if (!enabled) return;
  if (opts.urlFilter) {
    try {
      const re = new RegExp(opts.urlFilter, "i");
      if (!re.test(entry.url || "")) return;
    } catch {
      /* ignore bad regex */
    }
  }
  entry.id = ++seq;
  entry.ts = Date.now();
  entries.push(entry);
  while (entries.length > MAX_ENTRIES) entries.shift();
  send({ type: "net", entry: { id: entry.id, method: entry.method, url: entry.url, status: entry.status } });
}

function installHooks() {
  if (hooksInstalled) return { ok: true, already: true };
  if (!ObjC.available) return { ok: false, error: "ObjC not available" };

  const NSURLSession = ObjC.classes.NSURLSession;
  if (!NSURLSession) return { ok: false, error: "NSURLSession missing" };

  // dataTaskWithRequest:completionHandler:
  try {
    Interceptor.attach(NSURLSession["- dataTaskWithRequest:completionHandler:"].implementation, {
      onEnter(args) {
        if (!enabled) return;
        try {
          const req = new ObjC.Object(args[2]);
          const url = safeStr(req.URL() && req.URL().absoluteString());
          const method = safeStr(req.HTTPMethod() || "GET");
          const entry = {
            phase: "request",
            method,
            url,
            headers: headersFrom(req),
            body: bodyFrom(req),
            api: "dataTaskWithRequest:completionHandler:",
          };

          // Wrap completionHandler to capture response
          if (opts.captureResponse && !args[3].isNull()) {
            const orig = new ObjC.Block(args[3]);
            const origImpl = orig.implementation;
            const maxBody = opts.maxBody;
            args[3] = new ObjC.Block({
              retType: "void",
              argTypes: ["object", "object", "object"],
              implementation(data, response, error) {
                try {
                  const respEntry = {
                    phase: "response",
                    method,
                    url,
                    headers: entry.headers,
                    body: entry.body,
                    api: entry.api,
                  };
                  if (response && !response.isNull()) {
                    const r = new ObjC.Object(response);
                    try {
                      respEntry.status = Number(r.statusCode());
                    } catch {
                      /* not HTTP */
                    }
                    try {
                      respEntry.mimeType = safeStr(r.MIMEType());
                    } catch {
                      /* */
                    }
                    try {
                      const rh = r.allHeaderFields && r.allHeaderFields();
                      if (rh && !rh.handle.isNull()) {
                        const h = {};
                        const keys = rh.allKeys();
                        for (let i = 0; i < Number(keys.count()); i++) {
                          const k = safeStr(keys.objectAtIndex_(i));
                          h[k] = truncate(safeStr(rh.objectForKey_(keys.objectAtIndex_(i))), 500);
                        }
                        respEntry.responseHeaders = h;
                      }
                    } catch {
                      /* */
                    }
                  }
                  if (data && !data.isNull()) {
                    respEntry.responseBody = dataPreview(new ObjC.Object(data));
                  }
                  if (error && !error.isNull()) {
                    respEntry.error = safeStr(new ObjC.Object(error).localizedDescription());
                  }
                  pushEntry(respEntry);
                } catch (e) {
                  pushEntry({
                    phase: "response",
                    method,
                    url,
                    error: "wrap failed: " + (e.message || e),
                  });
                }
                return origImpl(data, response, error);
              },
            });
          } else {
            pushEntry(entry);
          }
          // always log request start
          pushEntry({ ...entry, phase: "request" });
        } catch (e) {
          /* swallow */
        }
      },
    });
  } catch (e) {
    return { ok: false, error: "hook dataTask failed: " + e.message };
  }

  // dataTaskWithURL:completionHandler:
  try {
    Interceptor.attach(NSURLSession["- dataTaskWithURL:completionHandler:"].implementation, {
      onEnter(args) {
        if (!enabled) return;
        try {
          const urlObj = new ObjC.Object(args[2]);
          const url = safeStr(urlObj.absoluteString && urlObj.absoluteString());
          pushEntry({
            phase: "request",
            method: "GET",
            url,
            headers: {},
            body: null,
            api: "dataTaskWithURL:completionHandler:",
          });
        } catch {
          /* */
        }
      },
    });
  } catch {
    /* optional */
  }

  // uploadTaskWithRequest:fromData:completionHandler:
  try {
    Interceptor.attach(
      NSURLSession["- uploadTaskWithRequest:fromData:completionHandler:"].implementation,
      {
        onEnter(args) {
          if (!enabled) return;
          try {
            const req = new ObjC.Object(args[2]);
            pushEntry({
              phase: "request",
              method: safeStr(req.HTTPMethod() || "POST"),
              url: safeStr(req.URL() && req.URL().absoluteString()),
              headers: headersFrom(req),
              body: bodyFrom(req),
              api: "uploadTaskWithRequest:fromData:completionHandler:",
            });
          } catch {
            /* */
          }
        },
      },
    );
  } catch {
    /* optional */
  }

  hooksInstalled = true;
  return { ok: true, already: false };
}

rpc.exports = {
  probe() {
    return {
      objc: ObjC.available,
      NSURLSession: !!ObjC.classes.NSURLSession,
      NSURLRequest: !!ObjC.classes.NSURLRequest,
      hooksInstalled,
      enabled,
      entries: entries.length,
    };
  },

  netEnable(options) {
    if (options && typeof options === "object") {
      if (options.maxBody != null) opts.maxBody = Number(options.maxBody);
      if (options.captureResponse != null) opts.captureResponse = !!options.captureResponse;
      if (options.urlFilter != null) opts.urlFilter = String(options.urlFilter);
    }
    const r = installHooks();
    if (!r.ok) return r;
    enabled = true;
    return { ok: true, enabled, opts, hooksInstalled };
  },

  netDisable() {
    enabled = false;
    return { ok: true, enabled: false, retainedEntries: entries.length };
  },

  netClear() {
    entries.length = 0;
    seq = 0;
    return { ok: true, cleared: true };
  },

  netDump(options) {
    const limit = Math.min(200, Number((options && options.limit) || 50));
    const filter = options && options.query ? String(options.query).toLowerCase() : "";
    let list = entries.slice();
    if (filter) {
      list = list.filter(
        (e) =>
          (e.url && e.url.toLowerCase().includes(filter)) ||
          (e.method && e.method.toLowerCase().includes(filter)) ||
          (e.api && e.api.toLowerCase().includes(filter)),
      );
    }
    const slice = list.slice(-limit);
    return {
      count: list.length,
      returned: slice.length,
      enabled,
      opts,
      entries: slice,
    };
  },

  fireTestRequest(url) {
    return new Promise((resolve, reject) => {
      ObjC.schedule(ObjC.mainQueue, () => {
        try {
          const NSUrl = ObjC.classes.NSURL.URLWithString_(url);
          const req = ObjC.classes.NSMutableURLRequest.requestWithURL_(NSUrl);
          req.setHTTPMethod_("GET");
          req.setValue_forHTTPHeaderField_("frida-mcp-probe/1", "User-Agent");
          const session = ObjC.classes.NSURLSession.sharedSession();
          const task = session.dataTaskWithRequest_completionHandler_(
            req,
            new ObjC.Block({
              retType: "void",
              argTypes: ["object", "object", "object"],
              implementation(data, response, error) {
                let status = null;
                try {
                  if (response && !response.isNull()) status = Number(new ObjC.Object(response).statusCode());
                } catch {
                  /* */
                }
                let err = null;
                try {
                  if (error && !error.isNull()) err = safeStr(new ObjC.Object(error).localizedDescription());
                } catch {
                  /* */
                }
                resolve({ ok: !err, status, error: err, url });
              },
            }),
          );
          task.resume();
        } catch (e) {
          reject(e);
        }
      });
    });
  },

  ping() {
    return "pong";
  },
};

send({ type: "ready" });
