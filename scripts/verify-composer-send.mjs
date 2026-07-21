import frida from 'frida';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const udid = process.env.FRIDA_UDID || '6849e3300bb49162c3c7274e0268b8564cd229ce';
const device = await frida.getDevice(udid);
const dryOnly = process.env.DRY_ONLY === '1';
const text = process.env.SEND_TEXT || `mcp composer ${new Date().toISOString().slice(11, 19)}`;

// Spawn only — never attach to an existing TikTok process.
console.log('compile…');
const source = await new frida.Compiler().build('scripts/verify-composer-send.js', {
  projectRoot: root,
});

// Kill any existing TikTok first so spawn is clean.
try {
  const procs = await device.enumerateProcesses();
  for (const p of procs) {
    if (p.identifier === 'com.ss.iphone.ugc.Ame' || p.name === 'TikTok') {
      try { await device.kill(p.pid); console.log('killed existing', p.pid); } catch {}
    }
  }
} catch {}

console.log('spawn…');
const pid = await device.spawn(['com.ss.iphone.ugc.Ame']);
console.log('pid', pid);
const session = await device.attach(pid);
const script = await session.createScript(source);
script.message.connect((message) => {
  if (message.type === 'error') console.error(JSON.stringify(message, null, 2));
});
await script.load();
await device.resume(pid);
await new Promise((r) => setTimeout(r, Number(process.env.SPAWN_WAIT_MS || 14000)));

const result = await Promise.race([
  script.exports.run({
    peerUid: process.env.TIKTOK_PEER_UID || '7631865245183525889',
    text,
    dryOnly,
  }),
  new Promise((_, rej) => setTimeout(() => rej(new Error('rpc timeout 120s')), 120000)),
]);
const outPath = path.join(root, 'scripts', 'verify-composer-send-out.json');
fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await script.unload();
await session.detach();
process.exit(result && (result.exactMatch || (dryOnly && result?.dry?.ok)) ? 0 : 1);
