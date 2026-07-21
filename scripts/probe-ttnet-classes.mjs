/**
 * Compile + spawn TikTok + dump TTNet ObjC methods via RPC (after resume).
 */
import frida from "frida";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const UDID = process.env.FRIDA_UDID || "6849e3300bb49162c3c7274e0268b8564cd229ce";
const BUNDLE = process.argv[2] || "com.ss.iphone.ugc.Ame";

const device = await frida.getDevice(UDID);
console.log("device", device.id);

const compiler = new frida.Compiler();
const code = await compiler.build("scripts/probe-ttnet-classes.js", { projectRoot: root });

const pid = await device.spawn([BUNDLE]);
console.log("spawned", pid);
const session = await device.attach(pid);
const script = await session.createScript(code);
const out = [];
script.message.connect((msg) => {
  if (msg.type === "error") {
    console.error("ERR", msg);
    out.push(JSON.stringify(msg));
  }
});
script.logHandler = (level, text) => {
  out.push(text);
  console.log(text);
};
await script.load();
await device.resume(pid);
await new Promise((r) => setTimeout(r, 4000));
const result = await script.exports.probe();
console.log("PRESENT", result.present);
console.log("MISSING", result.missing);
for (const d of result.details || []) {
  console.log("\n====", d.name, "====");
  for (const m of d.methods || []) console.log(" ", m);
}
fs.writeFileSync(
  path.join(__dirname, "probe-ttnet-out.txt"),
  out.join("\n") + "\n\n" + JSON.stringify(result, null, 2),
  "utf8",
);
await script.unload();
await session.detach();
try {
  await device.kill(pid);
} catch {
  /* ignore */
}
console.log("PROBE_EXIT");
