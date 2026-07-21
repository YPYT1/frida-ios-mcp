/**
 * End-to-end: compile real agent, spawn TikTok with netEnable(ttnet), dump.
 */
import frida from "frida";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const UDID = process.env.FRIDA_UDID || "6849e3300bb49162c3c7274e0268b8564cd229ce";

const device = await frida.getDevice(UDID);
console.log("device", device.id);
const code = await new frida.Compiler().build("agent/agent_main.js", { projectRoot: root });

const pid = await device.spawn(["com.ss.iphone.ugc.Ame"]);
console.log("spawned", pid);
const session = await device.attach(pid);
const script = await session.createScript(code);
let ready = false;
script.message.connect((msg) => {
  if (msg.type === "send" && msg.payload?.type === "ready") ready = true;
  if (msg.type === "send" && msg.payload?.type === "net") {
    const e = msg.payload.entry;
    if (e?.stack === "ttnet") {
      console.log("NET", e.method, (e.url || "").slice(0, 100), "sign=" + !!e.hasSign);
    }
  }
  if (msg.type === "error") console.error("ERR", msg.description || msg);
});
await script.load();
const en = await script.exports.netEnable({
  captureMode: "all",
  maxBody: 16384,
  captureResponse: false,
});
console.log("netEnable", JSON.stringify(en, null, 2));
await device.resume(pid);
await new Promise((r) => setTimeout(r, 12000));

const st = await script.exports.netStatus();
console.log("status", JSON.stringify(st));
const dump = await script.exports.netDump({ limit: 80 });
const entries = dump.entries || [];
const ttnet = entries.filter((e) => e.stack === "ttnet");
const withSign = ttnet.filter((e) => e.signHeaders && Object.keys(e.signHeaders).length);
const hosts = {};
for (const e of ttnet) {
  try {
    const h = new URL(e.url).host;
    hosts[h] = (hosts[h] || 0) + 1;
  } catch {
    /* */
  }
}
console.log("total", entries.length, "ttnet", ttnet.length, "withSign", withSign.length);
console.log("hosts", hosts);
const sample = ttnet.find((e) => (e.url || "").includes("aweme")) || ttnet[0];
if (sample) {
  console.log(
    "SAMPLE",
    JSON.stringify(
      {
        method: sample.method,
        url: (sample.url || "").slice(0, 180),
        headerKeys: Object.keys(sample.headers || {}),
        signHeaders: sample.signHeaders,
        queryKeys: Object.keys(sample.query || {}).slice(0, 20),
        body: sample.body
          ? { encoding: sample.body.encoding, length: sample.body.length }
          : null,
      },
      null,
      2,
    ),
  );
}
fs.writeFileSync(
  path.join(__dirname, "probe-agent-net-out.json"),
  JSON.stringify(
    {
      enable: en,
      status: st,
      hosts,
      ttnetCount: ttnet.length,
      withSign: withSign.length,
      samples: ttnet.slice(0, 5),
    },
    null,
    2,
  ),
);
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
console.log("AGENT_NET_DONE ready=", ready);
