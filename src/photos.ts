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

  /** PhotoKit fetch by localIdentifier (in-memory; may ahead of Photos.sqlite). */
  async fetchByLocalIdentifier(opts: {
    localIdentifier: string;
    udid?: string;
    terminateAfter?: boolean;
  }): Promise<Record<string, unknown>> {
    return this.withPhotosRpc(async (live) => {
      const result = (await callRpc(live.script, "fetchByLocalIdentifier", [
        opts.localIdentifier,
      ])) as Record<string, unknown>;
      if (opts.terminateAfter) {
        const { pid, device } = live;
        await closeLiveSession(live);
        this.live = null;
        await this.killPid(device, pid);
        await sleep(400);
      }
      return result;
    }, { udid: opts.udid, ensure: true });
  }

  /** PhotoKit untrashed listing (fallback when AFC sqlite is empty / WAL lag). */
  async listUntrashedPhotoKit(opts: {
    udid?: string;
    limit?: number;
    terminateAfter?: boolean;
  } = {}): Promise<{
    ok: boolean;
    count: number;
    total?: number;
    assets: Array<{
      localIdentifier: string;
      uuid?: string;
      mediaType: "image" | "video";
      pixelWidth?: number;
      pixelHeight?: number;
      duration?: number;
      source?: string;
    }>;
    error?: string;
  }> {
    return this.withPhotosRpc(async (live) => {
      const result = (await callRpc(live.script, "listUntrashedAssets", [
        opts.limit ?? 200,
      ])) as {
        ok?: boolean;
        count?: number;
        total?: number;
        assets?: Array<Record<string, unknown>>;
        error?: string;
      };
      if (opts.terminateAfter !== false) {
        const { pid, device } = live;
        await closeLiveSession(live);
        this.live = null;
        await this.killPid(device, pid);
        await sleep(400);
      }
      const assets = (result.assets || []).map((a) => ({
        localIdentifier: String(a.localIdentifier || ""),
        uuid: a.uuid
          ? String(a.uuid)
          : String(a.localIdentifier || "").split("/")[0],
        mediaType: (a.mediaType === "video" ? "video" : "image") as
          | "image"
          | "video",
        pixelWidth: typeof a.pixelWidth === "number" ? a.pixelWidth : undefined,
        pixelHeight:
          typeof a.pixelHeight === "number" ? a.pixelHeight : undefined,
        duration: typeof a.duration === "number" ? a.duration : undefined,
        source: "photokit",
      }));
      return {
        ok: result.ok === true,
        count: assets.length,
        total: result.total,
        assets,
        error: result.error,
      };
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

export async function photosList(
  opts: {
    udid?: string;
    /** Filter by media type (default: all untrashed) */
    mediaType?: "image" | "video";
    /** Match uuid or localIdentifier prefix / substring */
    idPrefix?: string;
    localIdentifier?: string;
    /** When sqlite empty, list via PhotoKit (default true). Disable during import sqlite poll. */
    allowPhotoKitFallback?: boolean;
  } = {},
) {
  const udid = await resolveUdid(opts.udid);
  // Prefer kill Photos so sqlite is not locked
  await photosChannel.close({ kill: true });
  const r = await afcListUntrashed(udid);
  let assets = r.assets;
  let source: "sqlite" | "photokit" = "sqlite";
  const filters: Record<string, string | undefined> = {};
  if (opts.mediaType === "image" || opts.mediaType === "video") {
    assets = assets.filter((a) => a.mediaType === opts.mediaType);
    filters.mediaType = opts.mediaType;
  }
  const idQ = (opts.localIdentifier || opts.idPrefix || "").trim();
  if (idQ) {
    const q = idQ.toLowerCase();
    assets = assets.filter((a) => {
      const lid = String(a.localIdentifier || "").toLowerCase();
      const uuid = String(a.uuid || "").toLowerCase();
      return lid.includes(q) || uuid.includes(q) || lid.startsWith(q) || uuid.startsWith(q);
    });
    filters.idPrefix = idQ;
  }
  // AFC sqlite can lag PhotoKit (WAL). Fall back when empty.
  if (assets.length === 0 && opts.allowPhotoKitFallback !== false) {
    try {
      const pk = await photosChannel.listUntrashedPhotoKit({
        udid,
        limit: 200,
        terminateAfter: true,
      });
      if (pk.ok && pk.assets.length) {
        source = "photokit";
        assets = pk.assets;
        if (opts.mediaType === "image" || opts.mediaType === "video") {
          assets = assets.filter((a) => a.mediaType === opts.mediaType);
        }
        if (idQ) {
          const q = idQ.toLowerCase();
          assets = assets.filter((a) => {
            const lid = String(a.localIdentifier || "").toLowerCase();
            const uuid = String(a.uuid || "").toLowerCase();
            return (
              lid.includes(q) ||
              uuid.includes(q) ||
              lid.startsWith(q) ||
              uuid.startsWith(q)
            );
          });
        }
      }
    } catch {
      /* keep sqlite empty result */
    }
  }
  return {
    ok: true as const,
    stage: "verify" as const,
    udid: r.udid,
    count: assets.length,
    totalUnfiltered: r.count,
    assets,
    source,
    filters: Object.keys(filters).length ? filters : undefined,
    note:
      source === "photokit"
        ? "Listed via PhotoKit (Photos.sqlite empty/lag). Recents ≈ localIdentifier."
        : "Untrashed PHAssets only (default all). Optional mediaType=image|video and idPrefix/localIdentifier filter. Recents ≈ PhotoKit localIdentifier.",
  };
}

/** True when MCP already holds a live non-Photos app session (can slow sqlite verify). */
async function appSessionConflictHint(): Promise<{
  appSessionOpen: boolean;
  bundleId?: string;
}> {
  try {
    const { sessionStore } = await import("./session.js");
    const s = sessionStore.status();
    if (s.open && s.alive && s.bundleId && s.bundleId !== PHOTOS_BUNDLE_ID) {
      return { appSessionOpen: true, bundleId: s.bundleId };
    }
  } catch {
    /* ignore circular/init */
  }
  return { appSessionOpen: false };
}

function assetMatchesLocalId(
  assets: Array<{ localIdentifier?: string; uuid?: string }>,
  localIdentifier: string,
): boolean {
  const uuid = localIdentifier.split("/")[0];
  return assets.some((a) => {
    const lid = String(a.localIdentifier || "");
    const u = String(a.uuid || "");
    return (
      lid === localIdentifier ||
      u === uuid ||
      lid.startsWith(uuid) ||
      (uuid.length > 0 && lid.toLowerCase().includes(uuid.toLowerCase()))
    );
  });
}

export async function photosImportFile(opts: {
  udid?: string;
  localPath: string;
  mediaType: "image" | "video";
  verify?: boolean;
}) {
  const t0 = Date.now();
  const verify = opts.verify !== false;
  const isVideo = opts.mediaType === "video";
  const conflict = await appSessionConflictHint();

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
  let verifiedInPhotoKit = false;
  // Prefer quicker sqlite probes; PhotoKit confirm is authoritative when WAL lags.
  const firstWaitMs = isVideo ? 3000 : 1500;
  const pollMs = isVideo ? 2000 : 1500;
  const polls = isVideo ? 6 : 3;
  if (verify && imp.localIdentifier) {
    await sleep(firstWaitMs);
    for (let i = 0; i < polls; i++) {
      list = await photosList({
        udid: upload.udid,
        // Prefer type filter when listing for verify noise; fall back to full if miss
        mediaType: opts.mediaType,
        allowPhotoKitFallback: false,
      });
      if (assetMatchesLocalId(list.assets, imp.localIdentifier)) {
        verified = true;
        break;
      }
      // one full unfiltered pass if type filter empty-missed
      if (list.count === 0 || i === Math.floor(polls / 2)) {
        const full = await photosList({
          udid: upload.udid,
          allowPhotoKitFallback: false,
        });
        list = full;
        if (assetMatchesLocalId(full.assets, imp.localIdentifier)) {
          verified = true;
          break;
        }
      }
      await sleep(pollMs);
    }
    // Explicit PhotoKit id fetch if list still misses (sqlite-only empty + list filter miss)
    if (!verified) {
      try {
        const fetched = await photosChannel.fetchByLocalIdentifier({
          localIdentifier: imp.localIdentifier,
          udid: upload.udid,
          terminateAfter: true,
        });
        if (fetched.ok === true) {
          verified = true;
          verifiedInPhotoKit = true;
        }
      } catch {
        /* leave unverified */
      }
    }
  }

  const needsRetry = verify && !verified;
  let note: string;
  if (!verify) {
    note = "PhotoKit localIdentifier set; verify skipped.";
  } else if (verified && verifiedInPhotoKit) {
    note =
      "Import OK; confirmed via PhotoKit (Photos.sqlite may still lag — Recents should show it).";
  } else if (verified) {
    note =
      "Import OK; asset in Photos.sqlite untrashed list (Recents should show it).";
  } else {
    note =
      "PhotoKit returned localIdentifier but verify missed (WAL lag or concurrent App session). " +
      "Not a fake success: re-run photos_list({ idPrefix / mediaType }) or close other session_open and retry. " +
      (isVideo
        ? "Video: prefer no parallel session_open (e.g. Preferences/TikTok) during import."
        : "Retry photos_list shortly.");
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
    verifiedInSqlite: verify ? verified && !verifiedInPhotoKit : undefined,
    verifiedInPhotoKit: verify ? verifiedInPhotoKit : undefined,
    needsRetry,
    appSessionOpenDuringImport: conflict.appSessionOpen || undefined,
    appSessionBundleId: conflict.bundleId,
    recovery: needsRetry
      ? [
          "photos_list with mediaType and/or idPrefix=" +
            imp.localIdentifier.split("/")[0],
          "close other session (session_close) then re-import or re-list",
          isVideo
            ? "video: avoid session_open other apps during photos_import_file"
            : "wait a few seconds and photos_list again",
        ]
      : undefined,
    note,
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
  let targetIds = before.assets.map((a) => a.localIdentifier).filter(Boolean);
  let listSource: "sqlite" | "photokit" = "sqlite";
  if (!targetIds.length) {
    try {
      const pk = await photosChannel.listUntrashedPhotoKit({
        udid,
        limit: 500,
        terminateAfter: true,
      });
      if (pk.ok && pk.assets.length) {
        listSource = "photokit";
        targetIds = pk.assets.map((a) => a.localIdentifier).filter(Boolean);
      }
    } catch {
      /* keep empty */
    }
  }
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
  // verify — sqlite first; PhotoKit if we deleted via PhotoKit list or sqlite still empty
  let after = await afcListUntrashed(udid);
  for (let i = 0; i < 5 && after.count > 0; i++) {
    await sleep(1500);
    after = await afcListUntrashed(udid);
  }
  let afterPhotoKitCount = 0;
  if (after.count === 0 && (listSource === "photokit" || targetIds.length > 0)) {
    try {
      const pkAfter = await photosChannel.listUntrashedPhotoKit({
        udid,
        limit: 500,
        terminateAfter: true,
      });
      afterPhotoKitCount = pkAfter.ok ? pkAfter.count : 0;
    } catch {
      afterPhotoKitCount = 0;
    }
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
  const cleared = after.count === 0 && afterPhotoKitCount === 0;
  return {
    ok: cleared,
    stage: "verify" as const,
    beforeCount: Math.max(before.count, targetIds.length),
    afterCount: Math.max(after.count, afterPhotoKitCount),
    listSource,
    targets: targetIds,
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

