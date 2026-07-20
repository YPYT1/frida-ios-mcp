/**
 * Minimal probe: spawn Preferences, install NSURLSession hooks, trigger a request.
 */
import frida from "frida";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentPath = path.join(__dirname, "probe-net-agent.js");

const device = await frida.getUsbDevice({ timeout: 10_000 });
console.log("device", device.id, device.name);

const bundleId = process.argv[2] || "com.apple.Preferences";
const pid = await device.spawn([bundleId]);
const session = await device.attach(pid);
const source = fs.readFileSync(agentPath, "utf8");

// compile via frida compiler if imports present
let code = source;
if (source.includes("import ")) {
  const compiler = new frida.Compiler();
  const root = path.resolve(__dirname, "..");
  code = await compiler.build("scripts/probe-net-agent.js", {
    projectRoot: root,
  });
}

const events = [];
const script = await session.createScript(code);
script.message.connect((msg) => {
  if (msg.type === "send") {
    events.push(msg.payload);
    if (msg.payload?.type === "net") {
      console.log("NET", JSON.stringify(msg.payload.entry).slice(0, 300));
    }
  } else if (msg.type === "error") {
    console.error("SCRIPT_ERR", msg);
  }
});

await script.load();
await device.resume(pid);
await new Promise((r) => setTimeout(r, 2000));

const probe = await script.exports.probe();
console.log("probe", probe);

const enabled = await script.exports.netEnable({ maxBody: 2048, captureResponse: true });
console.log("enabled", enabled);

// Fire a simple request from inside the app
try {
  const fired = await script.exports.fireTestRequest("https://httpbin.org/get?frida=1");
  console.log("fire", fired);
} catch (e) {
  console.log("fire failed", e.message);
}

await new Promise((r) => setTimeout(r, 3000));
const dump = await script.exports.netDump({ limit: 20 });
console.log("dump count", dump.count);
console.log(JSON.stringify(dump.entries?.slice(0, 5), null, 2));

await script.exports.netDisable();
await script.unload();
await session.detach();
console.log("PROBE_DONE events=", events.filter((e) => e?.type === "net").length);
