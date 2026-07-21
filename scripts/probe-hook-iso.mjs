import frida from "frida";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const UDID = process.env.FRIDA_UDID || "6849e3300bb49162c3c7274e0268b8564cd229ce";
const MODE = process.argv[2] || "filters";

const device = await frida.getDevice(UDID);
const code = await new frida.Compiler().build("scripts/probe-hook-iso.js", { projectRoot: root });
const pid = await device.spawn(["com.ss.iphone.ugc.Ame"]);
const session = await device.attach(pid);
const script = await session.createScript(code);
let alive = true;
script.message.connect((msg) => {
  if (msg.type === "send") console.log("MSG", JSON.stringify(msg.payload).slice(0, 200));
  if (msg.type === "error") console.error("ERR", msg.description || msg);
});
script.destroyed.connect(() => {
  alive = false;
  console.log("DESTROYED");
});
await script.load();
console.log("install", await script.exports.install(MODE));
await device.resume(pid);
await new Promise((r) => setTimeout(r, 10000));
let dump = { error: "dead", alive };
if (alive) {
  try {
    dump = await script.exports.dump();
    dump.alive = true;
  } catch (e) {
    dump = { error: String(e), alive: false };
  }
}
console.log(
  "result",
  JSON.stringify({
    mode: MODE,
    alive: dump.alive,
    count: dump.count,
    keys: (dump.headerKeys || []).length,
    error: dump.error,
    sampleKeys: (dump.headerKeys || []).filter((k) =>
      /gorgon|argus|ladon|khronos|token|stub|metasec|ss-|tt-/i.test(k),
    ),
    hits: (dump.hits || []).slice(0, 5),
  }),
);
fs.writeFileSync(path.join(__dirname, `probe-hook-iso-${MODE}.json`), JSON.stringify(dump, null, 2));
try {
  if (alive) await script.unload();
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
console.log("ISO_DONE", MODE);
