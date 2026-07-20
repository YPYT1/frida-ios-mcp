import frida from "frida";
import { compileAgent, waitForReady } from "./agent.js";

export type DeviceInfo = {
  id: string;
  name: string;
  type: string;
};

export type AppInfo = {
  identifier: string;
  name: string;
  pid: number;
};

export async function listDevices(): Promise<DeviceInfo[]> {
  const dm = await frida.getDeviceManager();
  const devices = await dm.enumerateDevices();
  return devices.map((d) => ({
    id: d.id,
    name: d.name,
    type: String(d.type),
  }));
}

export async function getDevice(udid?: string): Promise<frida.Device> {
  if (udid) {
    return frida.getDevice(udid, { timeout: 10_000 });
  }
  // USB first (MVP: native USB frida-server only)
  try {
    return await frida.getUsbDevice({ timeout: 10_000 });
  } catch {
    const dm = await frida.getDeviceManager();
    const all = await dm.enumerateDevices();
    const usb = all.find((d) => d.type === frida.DeviceType.Usb);
    if (usb) return usb;
    const local = all.find((d) => d.type === frida.DeviceType.Local);
    if (local) return local;
    throw new Error(
      "No Frida device found. Check USB + frida-server (match frida npm major, e.g. 17.x).",
    );
  }
}

export type ListAppsOptions = {
  udid?: string;
  /** Only apps with pid > 0 */
  runningOnly?: boolean;
  /** Drop com.apple.* helper services with pid=0 (keeps user apps + running system apps) */
  userFacing?: boolean;
  /** Case-insensitive substring match on identifier or name */
  query?: string;
};

export type ProcessInfo = {
  pid: number;
  name: string;
};

export async function listProcesses(opts: {
  udid?: string;
  query?: string;
  limit?: number;
} = {}): Promise<ProcessInfo[]> {
  const device = await getDevice(opts.udid);
  const procs = await device.enumerateProcesses();
  let list = procs.map((p) => ({
    pid: p.pid,
    name: p.name,
  }));
  if (opts.query) {
    const q = opts.query.toLowerCase();
    list = list.filter((p) => p.name.toLowerCase().includes(q));
  }
  list.sort((a, b) => a.name.localeCompare(b.name) || a.pid - b.pid);
  const limit = Math.min(500, Math.max(1, opts.limit ?? 200));
  return list.slice(0, limit);
}

export async function listApps(opts: ListAppsOptions = {}): Promise<AppInfo[]> {
  const device = await getDevice(opts.udid);
  const apps = await device.enumerateApplications({
    scope: frida.Scope.Full,
  } as frida.ApplicationQueryOptions);
  let list = apps.map((a) => ({
    identifier: a.identifier,
    name: a.name,
    pid: a.pid ?? 0,
  }));

  if (opts.runningOnly) {
    list = list.filter((a) => a.pid > 0);
  }
  if (opts.userFacing) {
    list = list.filter((a) => {
      if (a.pid > 0) return true;
      const id = a.identifier.toLowerCase();
      // Keep non-Apple apps always; drop Apple system services that are not launched
      if (!id.startsWith("com.apple.")) return true;
      // Keep common user-facing Apple apps even when not running
      const keep = [
        "preferences",
        "mobilesafari",
        "mobilenotes",
        "mobileslideshow",
        "mobilesms",
        "mobilephone",
        "appstore",
        "camera",
        "documentsapp",
        "news",
        "passbook",
        "health",
        "weather",
        "maps",
        "music",
        "videos",
        "calculator",
        "compass",
        "stocks",
        "tips",
        "voice memos",
        "facetime",
        "findmy",
        "home",
        "shortcuts",
        "clock",
        "reminders",
        "contacts",
        "calendar",
      ];
      return keep.some((k) => id.includes(k));
    });
  }
  if (opts.query) {
    const q = opts.query.toLowerCase();
    list = list.filter(
      (a) =>
        a.identifier.toLowerCase().includes(q) || a.name.toLowerCase().includes(q),
    );
  }

  return list.sort((a, b) => a.identifier.localeCompare(b.identifier));
}

export type LiveSession = {
  device: frida.Device;
  session: frida.Session;
  script: frida.Script;
  pid: number;
  udid: string;
  bundleId: string;
  mode: "spawn" | "attach";
  touchReliable: boolean;
  /** Set false when Frida reports script destroyed / session detached */
  alive: boolean;
  deadReason?: string;
  onDead?: (reason: string) => void;
};

function wireLifecycle(live: LiveSession): void {
  const markDead = (reason: string) => {
    if (!live.alive) return;
    live.alive = false;
    live.deadReason = reason;
    try {
      live.onDead?.(reason);
    } catch {
      /* ignore */
    }
  };

  try {
    live.script.destroyed.connect(() => markDead("script destroyed"));
  } catch {
    /* older bindings */
  }
  try {
    live.session.detached.connect((reason) => {
      markDead(`session detached: ${String(reason)}`);
    });
  } catch {
    /* ignore */
  }
  try {
    live.script.message.connect((message) => {
      if (message.type === "error") {
        // Do not kill session on every agent log error; only surface
        console.error("[frida-mcp] agent error:", message.description ?? message);
      }
    });
  } catch {
    /* ignore */
  }
}

export async function openSpawnSession(opts: {
  udid?: string;
  bundleId: string;
  /** Run while process is still suspended (after agent ready). Ideal for netEnable. */
  beforeResume?: (script: frida.Script) => Promise<void>;
}): Promise<LiveSession> {
  const device = await getDevice(opts.udid);
  const udid = device.id;
  // Kill existing then spawn suspended
  try {
    const apps = await device.enumerateApplications();
    const hit = apps.find((a) => a.identifier === opts.bundleId && a.pid);
    if (hit?.pid) {
      try {
        await device.kill(hit.pid);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }

  const pid = await device.spawn([opts.bundleId]);
  const session = await device.attach(pid);
  const code = await compileAgent();
  const script = await session.createScript(code);
  const ready = waitForReady(script, 8000);
  await script.load();
  await ready;
  // Hooks installed here catch launch-time traffic after resume
  if (opts.beforeResume) {
    await opts.beforeResume(script);
  }
  await device.resume(pid);

  const live: LiveSession = {
    device,
    session,
    script,
    pid,
    udid,
    bundleId: opts.bundleId,
    mode: "spawn",
    touchReliable: true,
    alive: true,
  };
  wireLifecycle(live);
  return live;
}

export async function openAttachSession(opts: {
  udid?: string;
  bundleId: string;
}): Promise<LiveSession> {
  const device = await getDevice(opts.udid);
  const udid = device.id;
  const apps = await device.enumerateApplications();
  const hit = apps.find((a) => a.identifier === opts.bundleId);
  if (!hit) {
    throw new Error(`App not installed: ${opts.bundleId}`);
  }
  let pid = hit.pid ?? 0;
  if (!pid) {
    // try process list by identifier
    const procs = await device.enumerateProcesses();
    const p = procs.find(
      (x) =>
        x.name === hit.name ||
        (x as { parameters?: { path?: string } }).parameters?.path?.includes(
          opts.bundleId,
        ),
    );
    if (p) pid = p.pid;
  }
  if (!pid) {
    throw new Error(
      `App not running: ${opts.bundleId}. Launch it first, or use mode=spawn.`,
    );
  }
  const session = await device.attach(pid);
  const code = await compileAgent();
  const script = await session.createScript(code);
  const ready = waitForReady(script, 8000);
  await script.load();
  await ready;

  const live: LiveSession = {
    device,
    session,
    script,
    pid,
    udid,
    bundleId: opts.bundleId,
    mode: "attach",
    touchReliable: false,
    alive: true,
  };
  wireLifecycle(live);
  return live;
}

export async function closeLiveSession(live: LiveSession | null): Promise<void> {
  if (!live) return;
  live.alive = false;
  try {
    await live.script.unload();
  } catch {
    /* ignore */
  }
  try {
    await live.session.detach();
  } catch {
    /* ignore */
  }
}

/** Attach Frida to a process by name (e.g. SpringBoard). Not for TikTok apps. */
export async function openAttachByProcessName(opts: {
  udid?: string;
  processName: string;
}): Promise<LiveSession> {
  const device = await getDevice(opts.udid);
  const udid = device.id;
  const procs = await device.enumerateProcesses();
  const hit =
    procs.find((p) => p.name === opts.processName) ||
    procs.find((p) => p.name.toLowerCase() === opts.processName.toLowerCase());
  if (!hit) {
    throw new Error(
      `Process not found: ${opts.processName}. Is the device unlocked? SpringBoard should always run.`,
    );
  }
  const session = await device.attach(hit.pid);
  const code = await compileAgent();
  const script = await session.createScript(code);
  const ready = waitForReady(script, 8000);
  await script.load();
  await ready;

  const live: LiveSession = {
    device,
    session,
    script,
    pid: hit.pid,
    udid,
    bundleId: `process:${opts.processName}`,
    mode: "attach",
    touchReliable: true,
    alive: true,
  };
  wireLifecycle(live);
  return live;
}

/** Call RPC; try camelCase then snake_case. */
export async function callRpc(
  script: frida.Script,
  name: string,
  args: unknown[] = [],
): Promise<unknown> {
  const exports = script.exports as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const snake = name.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
  const fn = exports[name] ?? exports[snake];
  if (typeof fn !== "function") {
    const keys = Object.keys(exports).slice(0, 40).join(", ");
    throw new Error(`RPC not found: ${name} (or ${snake}). Available-ish: ${keys}`);
  }
  try {
    return await fn(...args);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/script is destroyed|session is destroyed|detached/i.test(msg)) {
      throw new Error(
        `${msg}. Session is dead — call session_open or session_respawn (spawn preferred for touch).`,
      );
    }
    throw e instanceof Error ? e : new Error(msg);
  }
}
