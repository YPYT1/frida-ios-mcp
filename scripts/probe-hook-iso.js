/**
 * Isolate which hooks kill the script; also collect unique header keys.
 */
import ObjC from 'frida-objc-bridge';

const headerKeys = new Set();
const hits = [];

function safeStr(v) {
  try {
    return v == null ? '' : String(v);
  } catch (_e) {
    return '';
  }
}

function noteHeaders(req) {
  try {
    const all = req.allHTTPHeaderFields();
    if (!all || all.handle.isNull()) return;
    const keys = all.allKeys();
    for (let i = 0; i < Math.min(Number(keys.count()), 100); i++) {
      headerKeys.add(safeStr(keys.objectAtIndex_(i)));
    }
  } catch (_e) { /* */ }
}

rpc.exports = {
  install(mode) {
    const C = ObjC.classes.TTHttpTaskChromium;
    if (!C) return { ok: false, error: 'no C' };
    const hooked = [];
    mode = String(mode || 'filters');

    if (mode === 'filters' || mode === 'all') {
      Interceptor.attach(C['- runRequestFiltersAndStart'].implementation, {
        onEnter(args) {
          this.self = new ObjC.Object(args[0]);
        },
        onLeave() {
          try {
            const req = this.self.request();
            noteHeaders(req);
            hits.push({ phase: 'req', url: safeStr(req.URL().absoluteString()).slice(0, 100) });
            if (hits.length > 50) hits.shift();
          } catch (_e) { /* */ }
        },
      });
      hooked.push('filters');
    }

    if (mode === 'complete' || mode === 'all') {
      Interceptor.attach(C['- onURLFetchComplete:'].implementation, {
        onEnter(args) {
          try {
            const self = new ObjC.Object(args[0]);
            const req = self.request();
            const url = safeStr(req && req.URL() && req.URL().absoluteString()).slice(0, 120);
            let infoClass = null;
            try {
              if (args[2] && !args[2].isNull()) infoClass = safeStr(new ObjC.Object(args[2]).$className);
            } catch (_e) { /* */ }
            hits.push({ phase: 'complete', url, infoClass });
            if (hits.length > 50) hits.shift();
            send({ type: 'c', url, infoClass });
          } catch (_e) { /* */ }
        },
      });
      hooked.push('complete');
    }

    if (mode === 'readdata' || mode === 'all') {
      Interceptor.attach(C['- onReadResponseData:'].implementation, {
        onEnter(args) {
          try {
            // touch only length — no bytes()
            const data = args[2] && !args[2].isNull() ? new ObjC.Object(args[2]) : null;
            const len = data ? Number(data.length()) : 0;
            hits.push({ phase: 'readdata', len });
            if (hits.length > 50) hits.shift();
          } catch (_e) { /* */ }
        },
      });
      hooked.push('readdata');
    }

    if (mode === 'started' || mode === 'all') {
      Interceptor.attach(C['- onResponseStarted:'].implementation, {
        onEnter(args) {
          try {
            const self = new ObjC.Object(args[0]);
            const req = self.request();
            const url = safeStr(req && req.URL() && req.URL().absoluteString()).slice(0, 100);
            let infoClass = null;
            try {
              if (args[2] && !args[2].isNull()) infoClass = safeStr(new ObjC.Object(args[2]).$className);
            } catch (_e) { /* */ }
            hits.push({ phase: 'started', url, infoClass });
            if (hits.length > 50) hits.shift();
            send({ type: 's', url, infoClass });
          } catch (_e) { /* */ }
        },
      });
      hooked.push('started');
    }

    if (mode === 'completedflag') {
      Interceptor.attach(C['- setIsCompleted:'].implementation, {
        onEnter(args) {
          try {
            const flag = args[2].toInt32();
            if (!flag) return;
            const self = new ObjC.Object(args[0]);
            const req = self.request();
            const url = safeStr(req && req.URL() && req.URL().absoluteString()).slice(0, 100);
            hits.push({ phase: 'completedflag', url });
            if (hits.length > 50) hits.shift();
            send({ type: 'done', url });
          } catch (_e) { /* */ }
        },
      });
      hooked.push('setIsCompleted');
    }

    if (mode === 'dealloc') {
      Interceptor.attach(C['- dealloc'].implementation, {
        onEnter(args) {
          try {
            const self = new ObjC.Object(args[0]);
            const req = self.request();
            const url = safeStr(req && req.URL() && req.URL().absoluteString()).slice(0, 100);
            hits.push({ phase: 'dealloc', url });
            if (hits.length > 50) hits.shift();
          } catch (_e) { /* */ }
        },
      });
      hooked.push('dealloc');
    }

    if (mode === 'nsheader') {
      const M = ObjC.classes.NSMutableURLRequest;
      Interceptor.attach(M['- setValue:forHTTPHeaderField:'].implementation, {
        onEnter(args) {
          try {
            const field = safeStr(new ObjC.Object(args[3]));
            if (/gorgon|argus|ladon|khronos|token|stub|metasec|security/i.test(field)) {
              hits.push({ phase: 'ns', field, value: safeStr(new ObjC.Object(args[2])).slice(0, 120) });
              if (hits.length > 50) hits.shift();
              send({ type: 'ns', field });
            }
          } catch (_e) { /* */ }
        },
      });
      hooked.push('nsheader');
    }

    if (mode === 'respcombo') {
      // filters + readdata(bytes) + setIsCompleted finalize
      Interceptor.attach(C['- runRequestFiltersAndStart'].implementation, {
        onEnter(args) {
          this.self = new ObjC.Object(args[0]);
        },
        onLeave() {
          try {
            const req = this.self.request();
            noteHeaders(req);
            hits.push({ phase: 'req', url: safeStr(req.URL().absoluteString()).slice(0, 80) });
            if (hits.length > 80) hits.shift();
          } catch (_e) { /* */ }
        },
      });
      const buf = new Map();
      Interceptor.attach(C['- onReadResponseData:'].implementation, {
        onEnter(args) {
          try {
            const key = args[0].toString();
            const data = args[2] && !args[2].isNull() ? new ObjC.Object(args[2]) : null;
            if (!data) return;
            const len = Number(data.length());
            if (len <= 0) return;
            let e = buf.get(key);
            if (!e) {
              e = { total: 0, preview: null };
              buf.set(key, e);
            }
            e.total += len;
            if (!e.preview) {
              const n = Math.min(len, 2048);
              e.preview = data.bytes().readByteArray(n);
            }
          } catch (_e) { /* */ }
        },
      });
      Interceptor.attach(C['- setIsCompleted:'].implementation, {
        onEnter(args) {
          try {
            if (!args[2].toInt32()) return;
            const key = args[0].toString();
            const self = new ObjC.Object(args[0]);
            const req = self.request();
            const url = safeStr(req && req.URL() && req.URL().absoluteString());
            const b = buf.get(key);
            buf.delete(key);
            let preview = null;
            if (b && b.preview) {
              const u8 = new Uint8Array(b.preview);
              let s = '';
              for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
              preview = s.slice(0, 400);
            }
            hits.push({
              phase: 'response',
              url: url.slice(0, 120),
              total: b ? b.total : 0,
              preview,
            });
            if (hits.length > 80) hits.shift();
            if ((url || '').indexOf('tiktokv.com') >= 0) {
              send({ type: 'resp', url: url.slice(0, 100), total: b ? b.total : 0 });
            }
          } catch (_e) { /* */ }
        },
      });
      hooked.push('respcombo');
    }

    return { ok: true, hooked, mode };
  },  dump() {
    return {
      count: hits.length,
      hits: hits.slice(-30),
      headerKeys: Array.from(headerKeys).sort(),
    };
  },
};

send({ type: 'ready' });
