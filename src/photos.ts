/**
 * Photos.app side channel: spawn+resume+settle → photos agent → import/clear.
 * Does NOT replace the main App (TikTok) session.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type frida from "frida";
import { afcListUntrashed, afcPush, afcRmDcim } from "./afc.js";
import { StageError } from "./errors.js";
import { compileAgent, waitForReady } from "./frida/agent.js";
import {
  callRpc,
  closeLiveSession,
  getDevice,
  type LiveSession,
} from "./frida/device.js";
import { AsyncMutex } from "./mutex.js";

export const PHOTOS_BUNDLE_ID = "com.apple.mobileslideshow";
const SETTLE_MS = 4000;
const AFC_BASE = "/var/mobile/Media";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolvePhotosAgent(): string {
  const candidates = [
    path.resolve(__dirname, "..", "agent", "photos", "photos_import_agent.js"),
    path.resolve(__dirname, "..", "..", "agent", "photos", "photos_import_agent.js"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new StageError("attach", "photos_import_agent.js not found", [
    "ensure agent/photos/photos_import_agent.js exists",
  ]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class PhotosChannel {
  private live: LiveSession | null = null;
  private readonly lock = new AsyncMutex();
  private agentSrcCache: string | null = null;

  status(): {
    photosAlive: boolean;
    photosPid?: number;
    photosBundleId: string;
  } {
    return {
      photosAlive: !!this.live?.alive,
      photosPid: this.live?.alive ? this.live.pid : undefined,
      photosBundleId: PHOTOS_BUNDLE_ID,
    };
  }

  private async compilePhotosAgent(): Promise<string> {
    if (this.agentSrcCache) return this.agentSrcCache;
    const entry = resolvePhotosAgent();
    this.agentSrcCache = await compileAgent(entry);
    return this.agentSrcCache;
  }

  private async findPhotosPid(device: frida.Device): Promise<number | null> {
    try {
      const apps = await device.enumerateApplications();
      const hit = apps.find((a) => a.identifier === PHOTOS_BUNDLE_ID);
      if (hit?.pid) return hit.pid;
    } catch {
      /* ignore */
    }
    return null;
  }

  private async killPid(device: frida.Device, pid: number | null | undefined): Promise<void> {
    if (!pid) return;
    try {
      await device.kill(pid);
    } catch {
      /* ignore */
    }
  }

  /**
   * Production path: kill old Photos → spawn → resume → settle ~4s → attach → load photos agent.
   * Leaves photosLive attached for subsequent RPCs until closePhotos().
   */
  async ensure(opts: { udid?: string; settleMs?: number } = {}): Promise<{
    ok: true;
    pid: number;
    mode: "spawn";
    udid: string;
    settleMs: number;
    note: string;
  }> {
    return this.lock.run(async () => {
      const settleMs = opts.settleMs ?? SETTLE_MS;
      let device: frida.Device;
      try {
        device = await getDevice(opts.udid);
      } catch (e) {
        throw new StageError(
          "attach",
          e instanceof Error ? e.message : String(e),
          ["device_list", "check USB + frida-server 17.x"],
        );
      }
      const udid = device.id;

      // Tear previous photos side session
      await closeLiveSession(this.live);
      this.live = null;

      const old = await this.findPhotosPid(device);
      if (old) await this.killPid(device, old);

      let pid: number;
      try {
        pid = await device.spawn([PHOTOS_BUNDLE_ID]);
        await device.resume(pid);
      } catch (e) {
        throw new StageError(
          "attach",
          `spawn Photos.app failed: ${e instanceof Error ? e.message : String(e)}`,
          ["unlock device", "retry photos_ensure"],
        );
      }
      await sleep(settleMs);

      let session: frida.Session;
      try {
        session = await device.attach(pid);
      } catch (e) {
        await this.killPid(device, pid);
        throw new StageError(
          "attach",
          `attach Photos pid=${pid} failed: ${e instanceof Error ? e.message : String(e)}`,
          ["photos_ensure again", "check frida-server"],
        );
      }

      try {
        const code = await this.compilePhotosAgent();
        const script = await session.createScript(code);
        const ready = waitForReady(script, 8000);
        await script.load();
        await ready;
        this.live = {
          device,
          session,
          script,
          pid,
          udid,
          bundleId: PHOTOS_BUNDLE_ID,
          mode: "spawn",
          touchReliable: true,
          alive: true,
        };
      } catch (e) {
        try {
          await session.detach();
        } catch {
          /* */
        }
        await this.killPid(device, pid);
        throw new StageError(
          "attach",
          `load photos agent failed: ${e instanceof Error ? e.message : String(e)}`,
          ["pnpm build", "check agent/photos/photos_import_agent.js"],
        );
      }

      return {
        ok: true as const,
        pid,
        mode: "spawn" as const,
        udid,
        settleMs,
        note: "Photos spawned+resumed; may steal foreground briefly. App (TikTok) session untouched.",
      };
    });
  }

  async close(opts: { kill?: boolean } = {}): Promise<{ ok: true; killed: boolean }> {
    return this.lock.run(async () => {
      const kill = opts.kill !== false;
      const live = this.live;
      const pid = live?.pid;
      const device = live?.device;
      await closeLiveSession(live);
      this.live = null;
      if (kill && device && pid) {
        await this.killPid(device, pid);
        await sleep(800);
      }
      return { ok: true as const, killed: !!(kill && pid) };
    });
  }

  private async withPhotosRpc<T>(
    fn: (live: LiveSession) => Promise<T>,
    opts: { udid?: string; ensure?: boolean } = {},
  ): Promise<T> {
    return this.lock.run(async () => {
      if (!this.live?.alive && opts.ensure !== false) {
        // ensure without nested lock — call body of ensure inline is hard; re-enter via ensure is OK (mutex reentrant)
        await this.ensure({ udid: opts.udid });
      }
      if (!this.live?.alive) {
        throw new StageError("attach", "Photos session not ready", ["photos_ensure"]);
      }
      return fn(this.live);
    });
  }

  async importDevicePath(opts: {
    devicePath: string;
    mediaType: "image" | "video";
    udid?: string;
    terminateAfter?: boolean;
  }): Promise<{
    ok: true;
    localIdentifier: string;
    elapsedMs: number;
    stage: "import";
    mediaType: string;
    devicePath: string;
    agent: unknown;
  }> {
    const t0 = Date.now();
    const devicePath = opts.devicePath.startsWith("/var/mobile/Media")
      ? opts.devicePath
      : opts.devicePath.startsWith("/DCIM/")
        ? AFC_BASE + opts.devicePath
        : opts.devicePath;

    return this.withPhotosRpc(async (live) => {
      const rpcName =
        opts.mediaType === "video" ? "importVideoFromPath" : "importImageFromPath";
      let result: Record<string, unknown>;
      try {
        result = (await callRpc(live.script, rpcName, [devicePath])) as Record<
          string,
          unknown
        >;
      } catch (e) {
        throw new StageError(
          "import",
          `PhotoKit RPC failed: ${e instanceof Error ? e.message : String(e)}`,
          ["photos_ensure", "check devicePath exists on device", "retry photos_import"],
        );
      }
      if (!result || result.ok !== true || !result.localIdentifier) {
        throw new StageError(
          "import",
          `PhotoKit refused: ${String(result?.error ?? JSON.stringify(result))}`,
          ["photos_ensure", "retry photos_import", "photos_list"],
          { detail: result },
        );
      }
      if (opts.terminateAfter !== false) {
        const { pid, device } = live;
        await closeLiveSession(live);
        this.live = null;
        await this.killPid(device, pid);
        await sleep(800);
      }
      return {
        ok: true as const,
        localIdentifier: String(result.localIdentifier),
        elapsedMs: Date.now() - t0,
        stage: "import" as const,
        mediaType: opts.mediaType,
        devicePath,
        agent: result,
      };
    }, { udid: opts.udid, ensure: true });
  }

  async deleteByLocalIds(opts: {
    localIdentifiers: string[];
    udid?: string;
    terminateAfter?: boolean;
  }): Promise<Record<string, unknown>> {
    if (!opts.localIdentifiers.length) {
      return { ok: true, requested: 0, found: [], deleted: 0 };
    }
    return this.withPhotosRpc(async (live) => {
      let result: Record<string, unknown>;
      try {
        result = (await callRpc(live.script, "deleteMediaAssetsByLocalIdentifiers", [
          opts.localIdentifiers,
        ])) as Record<string, unknown>;
      } catch (e) {
        throw new StageError(
          "import",
          `delete RPC failed: ${e instanceof Error ? e.message : String(e)}`,
          ["photos_ensure", "retry photos_clear"],
        );
      }
      if (opts.terminateAfter !== false) {
        const { pid, device } = live;
        await closeLiveSession(live);
        this.live = null;
        await this.killPid(device, pid);
        await sleep(800);
      }
      return result;
    }, { udid: opts.udid, ensure: true });
  }
}

export const photosChannel = new PhotosChannel();

export async function resolveUdid(udid?: string): Promise<string> {
  const d = await getDevice(udid);
  return d.id;
}

export async function mediaUpload(opts: {
  udid?: string;
  localPath: string;
  mediaType: "image" | "video";
}) {
  const udid = await resolveUdid(opts.udid);
  try {
    const r = await afcPush({
      udid,
      localPath: opts.localPath,
      mediaType: opts.mediaType,
    });
    return { ok: true as const, stage: "upload" as const, ...r };
  } catch (e) {
    if (e instanceof StageError) throw e;
    throw new StageError(
      "upload",
      e instanceof Error ? e.message : String(e),
      ["pip install pymobiledevice3", "check USB"],
    );
  }
}

export async function photosList(opts: { udid?: string } = {}) {
  const udid = await resolveUdid(opts.udid);
  // Prefer kill Photos so sqlite is not locked
  await photosChannel.close({ kill: true });
  const r = await afcListUntrashed(udid);
  return {
    ok: true as const,
    stage: "verify" as const,
    ...r,
    note:
      "Untrashed PHAssets only. Album UI Recents should match after PhotoKit import (localIdentifier).",
  };
}

export async function photosImportFile(opts: {
  udid?: string;
  localPath: string;
  mediaType: "image" | "video";
  verify?: boolean;
}) {
  const t0 = Date.now();
  const verify = opts.verify !== false;
  const upload = await mediaUpload({
    udid: opts.udid,
    localPath: opts.localPath,
    mediaType: opts.mediaType,
  });
  await photosChannel.ensure({ udid: upload.udid });
  const imp = await photosChannel.importDevicePath({
    devicePath: upload.devicePath,
    mediaType: opts.mediaType,
    udid: upload.udid,
    terminateAfter: true,
  });
  let list: Awaited<ReturnType<typeof photosList>> | undefined;
  let verified = false;
  if (verify && imp.localIdentifier) {
    // Photos.sqlite WAL can lag after kill; poll up to ~20s
    await sleep(2000);
    const uuid = imp.localIdentifier.split("/")[0];
    for (let i = 0; i < 10; i++) {
      list = await photosList({ udid: upload.udid });
      if (
        list.assets.some(
          (a) =>
            a.localIdentifier === imp.localIdentifier ||
            a.uuid === uuid ||
            (typeof a.localIdentifier === "string" &&
              a.localIdentifier.startsWith(uuid)),
        )
      ) {
        verified = true;
        break;
      }
      await sleep(2000);
    }
  }
  return {
    ok: true as const,
    stage: "import" as const,
    localPath: upload.localPath,
    remotePath: upload.remotePath,
    devicePath: upload.devicePath,
    sizeBytes: upload.sizeBytes,
    mediaType: opts.mediaType,
    localIdentifier: imp.localIdentifier,
    elapsedMs: Date.now() - t0,
    verifiedInSqlite: verify ? verified : undefined,
    needsRetry: verify && !verified,
    note: verified
      ? "Import OK; asset in Photos.sqlite untrashed list (Recents should show it)."
      : verify
        ? "PhotoKit returned localIdentifier but sqlite verify missed — open Photos Recents or retry photos_list."
        : "PhotoKit localIdentifier set; verify skipped.",
    listCount: list?.count,
  };
}

export async function photosClear(opts: {
  udid?: string;
  clearDcim?: boolean;
} = {}) {
  const udid = await resolveUdid(opts.udid);
  await photosChannel.close({ kill: true });
  const before = await afcListUntrashed(udid);
  const targetIds = before.assets.map((a) => a.localIdentifier).filter(Boolean);
  let deleteResult: Record<string, unknown> = {
    ok: true,
    requested: 0,
    deleted: 0,
  };
  if (targetIds.length) {
    await photosChannel.ensure({ udid });
    deleteResult = await photosChannel.deleteByLocalIds({
      localIdentifiers: targetIds,
      udid,
      terminateAfter: true,
    });
    if (deleteResult.ok === false) {
      throw new StageError("import", "PhotoKit batch delete failed", ["photos_clear again"], {
        detail: deleteResult,
        needsRetry: true,
      });
    }
  }
  // verify
  let after = await afcListUntrashed(udid);
  for (let i = 0; i < 5 && after.count > 0; i++) {
    await sleep(1500);
    after = await afcListUntrashed(udid);
  }
  let dcimCleanup: unknown;
  if (opts.clearDcim !== false) {
    try {
      dcimCleanup = await afcRmDcim(udid);
    } catch (e) {
      dcimCleanup = {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
  const cleared = after.count === 0;
  return {
    ok: cleared,
    stage: "verify" as const,
    beforeCount: before.count,
    afterCount: after.count,
    targets: before.assets,
    remaining: after.assets,
    deleteResult,
    dcimCleanup,
    needsRetry: !cleared,
    semantics: "moved_to_recently_deleted",
    note: cleared
      ? "Untrashed media cleared (Recently Deleted may still hold items)."
      : "Leftover untrashed assets — retry photos_clear",
  };
}

