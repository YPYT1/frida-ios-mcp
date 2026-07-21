/**
 * E2E: agent net capture with captureResponse + dump IM / profile / works APIs.
 */
import frida from "frida";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const UDID = process.env.FRIDA_UDID || "6849e3300bb49162c3c7274e0268b8564cd229ce";

const device = await frida.getDevice(UDID);
const code = await new frida.Compiler().build("agent/agent_main.js", { projectRoot: root });
const pid = await device.spawn(["com.ss.iphone.ugc.Ame"]);
const session = await device.attach(pid);
const script = await session.createScript(code);
let destroyed = false;
script.destroyed.connect(() => {
  destroyed = true;
  console.log("DESTROYED");
});
await script.load();
const en = await script.exports.netEnable({
  captureMode: "all",
  maxBody: 16384,
  captureResponse: true,
});
console.log("enable", en.ok, en.layers, (en.hooked || []).filter((h) => String(h).includes("ttnet")));
await device.resume(pid);
await new Promise((r) => setTimeout(r, 15000));

if (destroyed) {
  console.log("FAIL script dead");
  process.exit(1);
}

const dump = await script.exports.netDump({ limit: 200 });
const entries = dump.entries || [];
const interesting = entries.filter((e) => {
  const u = (e.url || "") + " " + (e.api || "") + " " + (e.field || "");
  return /imapi|\/im\/|inbox|message|profile\/self|aweme\/v1\/aweme|post\/|publish|sign_header|security-argus/i.test(
    u,
  );
});
const responses = entries.filter((e) => e.phase === "response");
const withBody = responses.filter((e) => e.responseBody && e.responseBody.length > 0);
const sign = entries.filter((e) => e.signHeaders && e.signHeaders["x-security-argus"]);

const summary = {
  total: entries.length,
  interesting: interesting.length,
  responses: responses.length,
  withBody: withBody.length,
  securityArgus: sign.length,
  sampleInteresting: interesting.slice(0, 25).map((e) => ({
    phase: e.phase,
    method: e.method,
    url: (e.url || "").slice(0, 140),
    api: e.api,
    signKeys: e.signHeaders ? Object.keys(e.signHeaders) : [],
    bodyLen: e.responseBody?.length || e.body?.length,
    bodyEnc: e.responseBody?.encoding || e.body?.encoding,
    preview: (e.responseBody?.preview || e.body?.preview || "").slice(0, 120),
  })),
};
console.log(JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(__dirname, "probe-agent-net-resp-summary.json"), JSON.stringify(summary, null, 2));

try {
  await script.unload();
} catch {
  /* */
}
try {
  await session.detach();
} catch {
  /* */
}
try {
  await device.kill(pid);
} catch {
  /* */
}
console.log("RESP_E2E_DONE destroyed=", destroyed);
