/**
 * Probe MetaSec / sign header write sites + response callback surface.
 * Never enumerate all ObjC classes.
 */
import ObjC from 'frida-objc-bridge';

function listOwn(clsName, filter) {
  const C = ObjC.classes[clsName];
  if (!C) return { name: clsName, ok: false };
  const methods = C.$ownMethods || [];
  const hits = filter
    ? methods.filter((m) => m.toLowerCase().indexOf(filter) >= 0)
    : methods;
  return { name: clsName, ok: true, count: methods.length, methods: hits.slice(0, 80) };
}

rpc.exports = {
  probeClasses() {
    const names = [
      'MSManager',
      'MSManagerTV',
      'MetaSec',
      'TTNetworkManager',
      'TTNetworkManagerChromium',
      'TTHttpTaskChromium',
      'TTHttpRequest',
      'BDTuring',
      'TTKOrpheus',
      'AWEIMManager',
      'AWEIMMessageManager',
      'AWEIMSendMessageController',
      'AWEIMChatManager',
      'TikTokIMManager',
      'AWEUserModel',
      'AWEAwemeModel',
    ];
    const out = [];
    for (const n of names) {
      const C = ObjC.classes[n];
      out.push({ name: n, present: !!C });
    }
    return { ok: true, classes: out };
  },
  probeMethods() {
    return {
      ok: true,
      ttHttpRequest: listOwn('TTHttpRequest', 'header'),
      ttHttpRequestSet: listOwn('TTHttpRequest', 'set'),
      ttTask: listOwn('TTHttpTaskChromium', 'callback'),
      ttTaskOn: listOwn('TTHttpTaskChromium', 'on'),
      ttTaskData: listOwn('TTHttpTaskChromium', 'data'),
      ttTaskResponse: listOwn('TTHttpTaskChromium', 'response'),
      imSend: listOwn('AWEIMSendMessageController', null),
      imMgr: listOwn('AWEIMManager', 'send'),
      imChat: listOwn('AWEIMChatManager', 'send'),
      ms: listOwn('MSManager', 'sign'),
      ms2: listOwn('MSManagerTV', null),
    };
  },
  probeModules() {
    const keys = ['metasec', 'mssdk', 'ttencrypt', 'cronet', 'ttnet', 'bdhelmet', 'orpheus'];
    const hits = [];
    const mods = Process.enumerateModules();
    for (let i = 0; i < mods.length; i++) {
      const n = mods[i].name.toLowerCase();
      for (let k = 0; k < keys.length; k++) {
        if (n.indexOf(keys[k]) >= 0) {
          hits.push({ name: mods[i].name, base: String(mods[i].base), size: mods[i].size });
          break;
        }
      }
    }
    return { ok: true, hits };
  },
  probeExports(moduleName, needles) {
    const mod = Process.findModuleByName(moduleName);
    if (!mod) return { ok: false, error: 'module missing' };
    const need = (needles || ['gorgon', 'argus', 'ladon', 'khronos', 'sign', 'header']).map((s) =>
      String(s).toLowerCase(),
    );
    const found = [];
    try {
      const ex = mod.enumerateExports();
      for (let i = 0; i < ex.length && found.length < 60; i++) {
        const ln = ex[i].name.toLowerCase();
        for (let j = 0; j < need.length; j++) {
          if (ln.indexOf(need[j]) >= 0) {
            found.push(ex[i].name);
            break;
          }
        }
      }
    } catch (e) {
      return { ok: false, error: String(e) };
    }
    return { ok: true, module: moduleName, found, exportCount: mod.enumerateExports().length };
  },
};

send({ type: 'ready' });
