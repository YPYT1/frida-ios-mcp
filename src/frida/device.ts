import frida from "frida";
import { compileAgent, waitForReady } from "./agent.js";
import { ProbeError } from "../errors.js";

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

/** Default 60s — override with FRIDA_MCP_OPEN_TIMEOUT_MS */
export function openTimeoutMs(): number {
  const n = Number(process.env.FRIDA_MCP_OPEN_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 60_000;
}

/** Default 90s — override with FRIDA_MCP_LOCK_WAIT_MS */
export function lockWaitTimeoutMs(): number {
  const n = Number(process.env.FRIDA_MCP_LOCK_WAIT_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 90_000;
}

/** Default 5s — unload/detach must not hold appLock forever */
export function closeTimeoutMs(): number {
  const n = Number(process.env.FRIDA_MCP_CLOSE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5_000;
}

/** Wall clock for whole session_open critical section (close + spawn). */
export function sessionOpenHoldTimeoutMs(): number {
  return openTimeoutMs() + closeTimeoutMs() + 5_000;
}

async function raceTimeout<T>(
  work: Promise<T>,
  ms: number,
  onTimeout: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(
            new ProbeError(
              "SESSION_OPEN_TIMEOUT",
              `session open timed out after ${ms}ms (spawn/attach/inject). Lock will release; Frida may still be cleaning up in background.`,
              [
                "session_force_unlock",
                "kill leftover app on device if needed",
                "retry session_open",
                "or restart MCP process",
              ],
            ),
          );
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function bestEffortCleanup(partial: {
  device?: frida.Device;
  session?: frida.Session;
  script?: frida.Script;
  pid?: number;
}): Promise<void> {
  try {
    if (partial.script) await partial.script.unload();
  } catch {
    /* ignore */
  }
  try {
    if (partial.session) await partial.session.detach();
  } catch {
    /* ignore */
  }
  try {
    if (partial.device && partial.pid) await partial.device.kill(partial.pid);
  } catch {
    /* ignore */
  }
}

/** Best-effort kill by udid+pid (orphan recovery after hold/close timeout). */
export async function bestEffortKillPid(
  udid: string | undefined,
  pid: number,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const device = await getDevice(udid);
    await device.kill(pid);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

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
  /** Override FRIDA_MCP_OPEN_TIMEOUT_MS */
  timeoutMs?: number;
  /** Fired as soon as spawn returns a pid (for orphan kill if open later times out). */
  onPid?: (info: { pid: number; udid: string; bundleId: string }) => void;
}): Promise<LiveSession> {
  const timeoutMs = opts.timeoutMs ?? openTimeoutMs();
  const cancelled = { value: false };
  const partial: {
    device?: frida.Device;
    session?: frida.Session;
    script?: frida.Script;
    pid?: number;
  } = {};

  const work = async (): Promise<LiveSession> => {
    const device = await getDevice(opts.udid);
    if (cancelled.value) throw new Error("session open cancelled");
    partial.device = device;
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
    if (cancelled.value) throw new Error("session open cancelled");

    const pid = await device.spawn([opts.bundleId]);
    partial.pid = pid;
    try {
      opts.onPid?.({ pid, udid, bundleId: opts.bundleId });
    } catch {
      /* ignore */
    }
    if (cancelled.value) {
      await bestEffortCleanup(partial);
      throw new Error("session open cancelled");
    }

    const session = await device.attach(pid);
    partial.session = session;
    if (cancelled.value) {
      await bestEffortCleanup(partial);
      throw new Error("session open cancelled");
    }

    const code = await compileAgent();
    const script = await session.createScript(code);
    partial.script = script;
    const ready = waitForReady(script, 8000);
    await script.load();
    await ready;
    if (cancelled.value) {
      await bestEffortCleanup(partial);
      throw new Error("session open cancelled");
    }
    // Hooks installed here catch launch-time traffic after resume
    if (opts.beforeResume) {
      await opts.beforeResume(script);
    }
    if (cancelled.value) {
      await bestEffortCleanup(partial);
      throw new Error("session open cancelled");
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
  };

  try {
    return await raceTimeout(work(), timeoutMs, () => {
      cancelled.value = true;
      void bestEffortCleanup(partial);
    });
  } catch (e) {
    cancelled.value = true;
    await bestEffortCleanup(partial);
    throw e;
  }
}

export async function openAttachSession(opts: {
  udid?: string;
  bundleId: string;
  timeoutMs?: number;
}): Promise<LiveSession> {
  const timeoutMs = opts.timeoutMs ?? openTimeoutMs();
  const cancelled = { value: false };
  const partial: {
    device?: frida.Device;
    session?: frida.Session;
    script?: frida.Script;
    pid?: number;
  } = {};

  const work = async (): Promise<LiveSession> => {
    const device = await getDevice(opts.udid);
    if (cancelled.value) throw new Error("session open cancelled");
    partial.device = device;
    const udid = device.id;
    const apps = await device.enumerateApplications();
    const hit = apps.find((a) => a.identifier === opts.bundleId);
    if (!hit) {
      throw new Error(`App not installed: ${opts.bundleId}`);
    }
    let pid = hit.pid ?? 0;
    if (!pid) {
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
    if (cancelled.value) throw new Error("session open cancelled");
    const session = await device.attach(pid);
    partial.session = session;
    partial.pid = pid;
    if (cancelled.value) {
      await bestEffortCleanup(partial);
      throw new Error("session open cancelled");
    }
    const code = await compileAgent();
    const script = await session.createScript(code);
    partial.script = script;
    const ready = waitForReady(script, 8000);
    await script.load();
    await ready;
    if (cancelled.value) {
      await bestEffortCleanup(partial);
      throw new Error("session open cancelled");
    }

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
  };

  try {
    return await raceTimeout(work(), timeoutMs, () => {
      cancelled.value = true;
      void bestEffortCleanup(partial);
    });
  } catch (e) {
    cancelled.value = true;
    await bestEffortCleanup(partial);
    throw e;
  }
}

export async function closeLiveSession(
  live: LiveSession | null,
  timeoutMs = closeTimeoutMs(),
  opts: { killOnTimeout?: boolean } = {},
): Promise<{ timedOut: boolean; killed?: boolean }> {
  if (!live) return { timedOut: false };
  live.alive = false;
  let timedOut = false;
  const cleanup = (async () => {
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
  })();
  try {
    await Promise.race([
      cleanup,
      new Promise<void>((resolve) => {
        setTimeout(() => {
          timedOut = true;
          resolve();
        }, timeoutMs);
      }),
    ]);
  } catch {
    /* ignore */
  }
  let killed = false;
  if (timedOut) {
    console.error(
      `[frida-mcp] closeLiveSession timed out after ${timeoutMs}ms (bundle=${live.bundleId}, pid=${live.pid}) — abandoned detach` +
        (opts.killOnTimeout ? "; attempting kill" : ""),
    );
    if (opts.killOnTimeout && live.pid) {
      const r = await bestEffortKillPid(live.udid, live.pid);
      killed = r.ok;
      if (!r.ok) {
        console.error(
          `[frida-mcp] orphan kill failed pid=${live.pid}: ${r.error ?? "unknown"}`,
        );
      }
    }
  }
  return { timedOut, killed: killed || undefined };
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
