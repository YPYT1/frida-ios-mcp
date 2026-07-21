/**
 * Light TTNet probe — never enumerate all ObjC classes (TikTok may kill).
 */
import ObjC from 'frida-objc-bridge';

function safeMethods(clsName) {
  try {
    const C = ObjC.classes[clsName];
    if (!C) {
      console.log('MISSING ' + clsName);
      return { name: clsName, ok: false };
    }
    const methods = C.$ownMethods || [];
    console.log('\n=== ' + clsName + ' methods=' + methods.length + ' ===');
    for (let i = 0; i < methods.length; i++) console.log('  ' + methods[i]);
    return { name: clsName, ok: true, methods };
  } catch (e) {
    console.log('ERR ' + clsName + ' ' + e);
    return { name: clsName, ok: false, error: String(e) };
  }
}

rpc.exports = {
  probe() {
    const candidates = [
      'TTHttpTask',
      'TTHttpRequest',
      'TTHttpResponse',
      'TTHttpRequestSerializer',
      'TTNetworkManager',
      'TTNetworkManagerChromium',
      'TTNetworkManagerBase',
      'TTHttpTaskDelegate',
      'TTRequestModel',
      'TTResponseModel',
      'BDNetworkRequest',
      'BDNetworkManager',
      'CronetHttpURLConnection',
      'TTHttpClient',
      'AWENetworkService',
      'AWENetworkRequest',
      'TTFNetworkManager',
      'TTNetClient',
      'TTHttpTaskChromium',
      'TTHttpTaskInterceptor',
      'TTNetworkUtil',
    ];
    const results = [];
    console.log('ObjC.available=' + ObjC.available);
    for (let i = 0; i < candidates.length; i++) {
      results.push(safeMethods(candidates[i]));
    }
    try {
      const T = ObjC.classes.TTHttpTask;
      if (T) {
        console.log('\nTTHttpTask $superClass=' + (T.$superClass ? T.$superClass.$className : 'null'));
      }
    } catch (e) {
      console.log('super err ' + e);
    }
    console.log('\nDONE');
    return {
      ok: true,
      present: results.filter((r) => r.ok).map((r) => r.name),
      missing: results.filter((r) => !r.ok).map((r) => r.name),
      details: results.filter((r) => r.ok),
    };
  },
};

send({ type: 'ready' });
