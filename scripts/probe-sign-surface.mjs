import frida from "frida";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const UDID = process.env.FRIDA_UDID || "6849e3300bb49162c3c7274e0268b8564cd229ce";

const device = await frida.getDevice(UDID);
const code = await new frida.Compiler().build("scripts/probe-sign-surface.js", { projectRoot: root });
const pid = await device.spawn(["com.ss.iphone.ugc.Ame"]);
const session = await device.attach(pid);
const script = await session.createScript(code);
await script.load();
await device.resume(pid);
await new Promise((r) => setTimeout(r, 5000));

const classes = await script.exports.probeClasses();
const methods = await script.exports.probeMethods();
const modules = await script.exports.probeModules();
const exportHits = [];
for (const h of modules.hits || []) {
  try {
    const r = await script.exports.probeExports(h.name, [
      "gorgon",
      "argus",
      "ladon",
      "khronos",
      "sign",
      "header",
      "encrypt",
      "stub",
    ]);
    if (r.found?.length) exportHits.push(r);
  } catch (e) {
    exportHits.push({ module: h.name, error: String(e) });
  }
}

const out = { classes, methods, modules, exportHits };
fs.writeFileSync(path.join(__dirname, "probe-sign-surface-out.json"), JSON.stringify(out, null, 2));
console.log("classes", JSON.stringify(classes.classes.filter((c) => c.present)));
console.log("modules", JSON.stringify(modules.hits.map((h) => h.name)));
console.log("exports", exportHits.map((e) => ({ m: e.module, n: (e.found || []).length, sample: (e.found || []).slice(0, 15) })));
console.log("ttTaskOn", methods.ttTaskOn);
console.log("ttTaskData", methods.ttTaskData);
console.log("im", { send: methods.imSend, mgr: methods.imMgr, chat: methods.imChat });

await script.unload();
await session.detach();
try {
  await device.kill(pid);
} catch {
  /* */
}
console.log("SIGN_SURFACE_DONE");
