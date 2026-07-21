import {
  bestEffortKillPid,
  closeLiveSession,
  callRpc,
  closeTimeoutMs,
  lockWaitTimeoutMs,
  openAttachByProcessName,
  openAttachSession,
  openSpawnSession,
  openTimeoutMs,
  sessionOpenHoldTimeoutMs,
  type LiveSession,
} from "./frida/device.js";
import {
  assertSafeRpc,
  assertWhitelistedRpc,
  attachAllowed,
  isTikTokBundle,
  snapshotModeFor,
  SPAWN_ONLY_HINT,
  TIKTOK_WAIT_HINT,
} from "./safety.js";
import {
  looksLikeTikTokSearchPage,
  TIKTOK_SEARCH_ENTRY_POINTS,
} from "./tiktok-search.js";
import {
  buildTextSnapshot,
  formatSnapshot,
  resolveSearchMode,
  searchSnapshot,
  type SnapshotFormatOpts,
  type SnapshotTable,
  type TextNode,
} from "./snapshot.js";
import { ProbeError } from "./errors.js";
import { AsyncMutex, type MutexStatus } from "./mutex.js";
import { photosChannel } from "./photos.js";
import { resolveTextPreset } from "./presets.js";
import { normalizeSwipeDuration } from "./swipe-duration.js";

export type SessionStatus = {
  open: boolean;
  alive?: boolean;
  udid?: string;
  bundleId?: string;
  pid?: number;
  mode?: "spawn" | "attach";
  safeUi?: boolean;
  injected?: boolean;
  touchReliable?: boolean;
  /** True only when in-memory ref table is valid for tap/type */
  hasSnapshot?: boolean;
  /** Alias of hasSnapshot — prefer this name in new clients */
  refsValid?: boolean;
  snapshotNodeCount?: number;
  snapshotGeneration?: number;
  lastSnapshotGeneration?: number;
  snapshotStale?: boolean;
  deadReason?: string;
  hint?: string;
  recovery?: string[];
  loginStateRisk?: boolean;
  springboardAlive?: boolean;
  /** true when user kept SB via closeSpringBoard:false */
  springboardKept?: boolean;
  /** Dual-session model: app + SB held together; RPCs use separate locks */
  dualParallel?: boolean;
  springboardPid?: number;
  /** Photos.app side channel (import/clear) — independent of app/SB */
  photosAlive?: boolean;
  photosPid?: number;
  /** appLock observability (no lock taken) */
  appLockBusy?: boolean;
  appLockWaiters?: number;
  appLockBusyOp?: string | null;
  appLockBusySinceMs?: number;
  sbLockBusy?: boolean;
  sbLockWaiters?: number;
  sbLockBusyOp?: string | null;
  orphanFridaOpPossible?: boolean;
  /** True while session_open critical section is running (even before lock acquire) */
  openInFlight?: boolean;
  /** Last known app pid (live or in-flight spawn) — for orphan diagnostics */
  lastAppPid?: number;
  /** Pid reported during spawn before live session is assigned */
  inFlightPid?: number;
};

export type SnapshotRequest = SnapshotFormatOpts & {
  mode?: "texts" | "tree";
};

class SessionStore {
  private live: LiveSession | null = null;
  /** Parallel SpringBoard session (attach by process name) — does not replace app live */
  private sbLive: LiveSession | null = null;
  /** User asked closeSpringBoard:false — SB kept on purpose (not an error state) */
  private sbKeepIntentional = false;
  private snapshot: SnapshotTable | null = null;
  /** Previous texts snapshot for showDiff */
  private prevSnapshot: SnapshotTable | null = null;
  /** Last successful snapshot meta (survives act-clear for status reads) */
  private lastSnapMeta: { generation: number; at: number; nodeCount: number } | null =
    null;
  /** Last tree dump text (does not replace text ref table) */
  private lastTreeText: string | null = null;

  /**
   * Separate locks: App RPCs and SpringBoard RPCs can run concurrently
   * (e.g. Promise.all([screen_snapshot, sb_alert_list])).
   * Same-channel calls still serialize (safe for Frida script).
   */
  private readonly appLock = new AsyncMutex();
  private readonly sbLock = new AsyncMutex();
  /** Set after forceUnlock / open timeout — native Frida may still be running. */
  private orphanFridaOpPossible = false;
  /** Guards overlapping session_open before lock is even acquired. */
  private openInFlight = false;
  /** True while session_close is tearing down (status must not flicker half-closed). */
  private closeInFlight: null | { keepSb: boolean } = null;
  /** True after a UI act until resnapshot replaces the ref table (status must not claim refsValid). */
  private uiDirty = false;
  /** Last app pid we spawned/attached — for orphan kill after force unlock */
  private lastAppPid: number | null = null;
  private lastAppUdid: string | undefined;
  private lastAppBundleId: string | undefined;
  /** Spawn returned pid but open not finished — prefer this for orphan kill */
  private inFlightPid: number | null = null;
  private inFlightUdid: string | undefined;

  private lockFields(): Pick<
    SessionStatus,
    | "appLockBusy"
    | "appLockWaiters"
    | "appLockBusyOp"
    | "appLockBusySinceMs"
    | "sbLockBusy"
    | "sbLockWaiters"
    | "sbLockBusyOp"
    | "orphanFridaOpPossible"
    | "openInFlight"
    | "lastAppPid"
    | "inFlightPid"
  > {
    const app = this.appLock.status();
    const sb = this.sbLock.status();
    return {
      appLockBusy: app.busy,
      appLockWaiters: app.waiters,
      appLockBusyOp: app.busyOp,
      appLockBusySinceMs: app.busySinceMs,
      sbLockBusy: sb.busy,
      sbLockWaiters: sb.waiters,
      sbLockBusyOp: sb.busyOp,
      orphanFridaOpPossible: this.orphanFridaOpPossible || undefined,
      openInFlight: this.openInFlight || undefined,
      lastAppPid: this.live?.pid ?? this.lastAppPid ?? undefined,
      inFlightPid: this.inFlightPid ?? undefined,
    };
  }

  private refsFields(): Pick<
    SessionStatus,
    | "hasSnapshot"
    | "refsValid"
    | "snapshotNodeCount"
    | "snapshotGeneration"
    | "lastSnapshotGeneration"
    | "snapshotStale"
  > {
    const refsValid = !!this.snapshot && !this.uiDirty;
    return {
      hasSnapshot: refsValid,
      refsValid,
      snapshotNodeCount: this.snapshot?.nodes.length ?? 0,
      snapshotGeneration: this.snapshot?.generation,
      lastSnapshotGeneration:
        this.snapshot?.generation ?? this.lastSnapMeta?.generation,
      snapshotStale: (!this.snapshot || this.uiDirty) && !!this.lastSnapMeta,
    };
  }

  private lockHint(app: MutexStatus): { hint?: string; recovery?: string[] } {
    if (!app.busy) return {};
    const stuck =
      app.busySinceMs >= Math.min(openTimeoutMs(), 30_000)
        ? " Prefer session_force_unlock now."
        : "";
    return {
      hint: `appLock busy (op=${app.busyOp ?? "?"}, since ${app.busySinceMs}ms, waiters=${app.waiters}). Cursor cancel does not abort server Frida.${stuck}`,
      recovery: [
        "session_force_unlock",
        "or wait for APP_LOCK_HOLD_TIMEOUT / SESSION_OPEN_TIMEOUT",
        "or restart MCP process",
      ],
    };
  }

  /** Default snapshot opts for auto-resnapshot after acts */
  static readonly DEFAULT_SNAP: SnapshotFormatOpts = {
    onScreenOnly: true,
    limit: 40,
  };

  status(): SessionStatus {
    const locks = this.lockFields();
    const refs = this.refsFields();
    const lockHint = this.lockHint(this.appLock.status());
    if (this.closeInFlight) {
      const keepSb = this.closeInFlight.keepSb;
      const sbAlive = keepSb && !!this.sbLive?.alive;
      return {
        open: false,
        alive: false,
        injected: false,
        ...refs,
        hasSnapshot: false,
        refsValid: false,
        snapshotNodeCount: 0,
        springboardAlive: sbAlive,
        springboardPid: sbAlive ? this.sbLive!.pid : undefined,
        springboardKept: keepSb || undefined,
        dualParallel: true,
        photosAlive: photosChannel.status().photosAlive,
        ...locks,
        hint: keepSb
          ? "session_close in progress (app); SpringBoard will be kept."
          : "session_close in progress — wait for it to finish.",
        recovery: keepSb
          ? ["wait for session_close", "sb_close when finished"]
          : ["wait for session_close", "then session_open"],
      };
    }
    if (this.openInFlight && !lockHint.hint) {
      lockHint.hint =
        "session_open in flight — do not start another open; wait or session_force_unlock if stuck.";
      lockHint.recovery = [
        "wait for current session_open",
        "session_force_unlock if hung",
        "or restart MCP process",
      ];
    }
    if (this.orphanFridaOpPossible) {
      const pidHint =
        this.inFlightPid ?? this.live?.pid ?? this.lastAppPid ?? null;
      lockHint.hint =
        `ORPHAN FRIDA POSSIBLE` +
        (pidHint ? ` (pid=${pidHint})` : "") +
        ` — do NOT session_open again until session_force_unlock (kills orphan pid). ` +
        (lockHint.hint ?? "");
      lockHint.recovery = [
        "session_force_unlock",
        "session_status (confirm orphanFridaOpPossible cleared)",
        "then ONE session_open",
        "or restart MCP process",
      ];
    }
    if (!this.live) {
      const sbAlive = !!this.sbLive?.alive;
      const intentionalKeep = sbAlive && this.sbKeepIntentional;
      const ph = photosChannel.status();
      return {
        open: false,
        alive: false,
        injected: false,
        ...refs,
        springboardAlive: sbAlive,
        springboardPid: this.sbLive?.alive ? this.sbLive.pid : undefined,
        springboardKept: intentionalKeep || undefined,
        dualParallel: true,
        photosAlive: ph.photosAlive,
        photosPid: ph.photosPid,
        ...locks,
        hint:
          lockHint.hint ??
          (intentionalKeep
            ? "SpringBoard kept intentionally; call sb_close when done."
            : sbAlive
              ? "App session ended but SpringBoard still attached unexpectedly. Call sb_close."
              : undefined),
        recovery:
          lockHint.recovery ??
          (sbAlive
            ? intentionalKeep
              ? ["sb_close when finished", "or session_open for a new app"]
              : ["sb_close", "session_open"]
            : ["session_open", "wait(3000-5000)", "screen_snapshot"]),
      };
    }
    const alive = this.live.alive;
    const ph = photosChannel.status();
    return {
      open: true,
      alive,
      udid: this.live.udid,
      bundleId: this.live.bundleId,
      pid: this.live.pid,
      mode: this.live.mode,
      safeUi: isTikTokBundle(this.live.bundleId),
      injected: alive,
      touchReliable: alive ? this.live.touchReliable : false,
      ...refs,
      deadReason: this.live.deadReason,
      loginStateRisk: this.live.mode === "spawn",
      springboardAlive: !!this.sbLive?.alive,
      springboardPid: this.sbLive?.alive ? this.sbLive.pid : undefined,
      dualParallel: true,
      photosAlive: ph.photosAlive,
      photosPid: ph.photosPid,
      ...locks,
      hint:
        lockHint.hint ??
        (!alive
          ? "Session script is dead. Call session_respawn or session_open."
          : isTikTokBundle(this.live.bundleId)
            ? TIKTOK_WAIT_HINT
            : undefined),
      recovery:
        lockHint.recovery ??
        (!alive
          ? ["session_respawn", "wait(4000)", "screen_snapshot", "note: spawn may reset login UI"]
          : undefined),
    };
  }

  private markDead(reason: string): void {
    if (this.live) {
      this.live.alive = false;
      this.live.deadReason = reason;
    }
  }

  private requireLive(): LiveSession {
    if (!this.live) {
      throw new ProbeError("NO_SESSION", "No active session. Call session_open first.", [
        "session_open",
        "wait(3000-5000)",
        "screen_snapshot",
      ]);
    }
    if (!this.live.alive) {
      const why = this.live.deadReason ?? "unknown";
      throw new ProbeError(
        "SCRIPT_DESTROYED",
        `Session is dead (${why}). Call session_respawn (spawn kills app; login may reset).`,
        ["session_respawn", "wait(4000)", "screen_snapshot"],
      );
    }
    return this.live;
  }

  private appSessionBrief() {
    const s = this.status();
    const refsValid = !!this.snapshot && !this.uiDirty;
    const app = this.appLock.status();
    let note: string | undefined;
    if (this.uiDirty || (app.busy && app.busyOp === "app_op")) {
      note = "app act / resnapshot in progress — wait for that tool to finish; do not use mid-flight refs";
    } else if (!refsValid && this.lastSnapMeta) {
      note = "refs cleared/stale — call screen_snapshot before tap(ref)";
    }
    return {
      alive: !!s.alive,
      open: s.open,
      bundleId: s.bundleId,
      hasSnapshot: refsValid,
      refsValid,
      lastSnapshotGeneration:
        this.snapshot?.generation ?? this.lastSnapMeta?.generation,
      snapshotStale: (!this.snapshot || this.uiDirty) && !!this.lastSnapMeta,
      snapshotGeneration: s.snapshotGeneration,
      note,
    };
  }

  /** Drop app session pointers then timed detach (caller must hold appLock or be forceUnlock). */
  private async detachAppSessionUnlocked(): Promise<{
    closeTimedOut: boolean;
    killed?: boolean;
  }> {
    const live = this.live;
    this.live = null;
    this.snapshot = null;
    this.prevSnapshot = null;
    this.lastTreeText = null;
    this.lastSnapMeta = null;
    this.uiDirty = false;
    // App channel: on soft-close timeout, kill pid so next open does not fight an orphan.
    const r = await closeLiveSession(live, closeTimeoutMs(), {
      killOnTimeout: true,
    });
    // Kill on timeout already removed the orphan pid — do not force AI through force_unlock.
    if (r.timedOut && !r.killed) this.orphanFridaOpPossible = true;
    return { closeTimedOut: r.timedOut, killed: r.killed };
  }

  private async detachSbSessionUnlocked(): Promise<{ closeTimedOut: boolean }> {
    const sb = this.sbLive;
    this.sbLive = null;
    this.sbKeepIntentional = false;
    // Never kill SpringBoard — detach only.
    const r = await closeLiveSession(sb);
    if (r.timedOut) this.orphanFridaOpPossible = true;
    return { closeTimedOut: r.timedOut };
  }

  /**
   * Best-effort kill of in-flight / last app pid (does not touch SpringBoard).
   * Used after hold timeout and by forceUnlock.
   */
  private async orphanKillBestEffort(): Promise<{
    attempted: boolean;
    pid?: number;
    ok?: boolean;
    error?: string;
  }> {
    const killPid = this.inFlightPid ?? this.live?.pid ?? this.lastAppPid;
    const killUdid =
      this.inFlightUdid ?? this.live?.udid ?? this.lastAppUdid;
    if (!killPid) return { attempted: false };
    const r = await bestEffortKillPid(killUdid, killPid);
    this.inFlightPid = null;
    this.inFlightUdid = undefined;
    return {
      attempted: true,
      pid: killPid,
      ok: r.ok,
      error: r.error,
    };
  }

  private noteInFlightPid(info: {
    pid: number;
    udid: string;
    bundleId: string;
  }): void {
    this.inFlightPid = info.pid;
    this.inFlightUdid = info.udid;
    this.lastAppPid = info.pid;
    this.lastAppUdid = info.udid;
    this.lastAppBundleId = info.bundleId;
  }

  /** After UI act: optional auto screen_snapshot (default true). */
  private async maybeResnapshot(
    resnapshot: boolean | undefined,
    settleMs = 450,
  ): Promise<string | undefined> {
    if (resnapshot === false) {
      this.snapshot = null;
      this.uiDirty = false;
      return undefined;
    }
    this.uiDirty = true;
    try {
      await new Promise((r) => setTimeout(r, settleMs));
      // Caller must already hold appLock (re-entrant screenSnapshotBody)
      const { text } = await this.screenSnapshotBody({ ...SessionStore.DEFAULT_SNAP });
      return text;
    } finally {
      this.uiDirty = false;
    }
  }

  private actEnvelope(
    result: unknown,
    snapshotText: string | undefined,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      ok: true,
      result,
      ...extra,
      warn: "Do not parallelize app acts (tap/swipe/type/smart_type). App+SB dual parallel is OK.",
      next: snapshotText
        ? "Use refs from snapshot below (this generation only)."
        : "call screen_snapshot before next ref-based action",
      ...(snapshotText ? { snapshot: snapshotText } : {}),
    };
  }

  async open(opts: {
    udid?: string;
    bundleId: string;
    mode?: "spawn" | "attach";
    /** Install NSURLSession capture before process resume (spawn path). */
    captureNet?: boolean;
    netOptions?: {
      maxBody?: number;
      captureResponse?: boolean;
      urlFilter?: string;
      /** nsurl | ttnet | all — TikTok business APIs need ttnet/all */
      captureMode?: string;
      /** Attach module+offset backtrace on sign_header writes */
      signTrace?: boolean;
    };
    /**
     * If true, attach SpringBoard in parallel with app open (dual inject ready).
     * App and SB use separate locks — later RPCs can run concurrently.
     */
    withSpringBoard?: boolean;
  }): Promise<
    SessionStatus & {
      warnings: string[];
      net?: unknown;
      next?: string;
      springboard?: unknown;
    }
  > {
    if (this.openInFlight) {
      throw new ProbeError(
        "SESSION_OPEN_IN_FLIGHT",
        "Another session_open is already running in this MCP process. Wait for it, or call session_force_unlock if it is stuck.",
        ["session_status", "session_force_unlock", "wait then retry session_open"],
      );
    }
    const appBusy = this.appLock.status();
    if (appBusy.busy && appBusy.busyOp === "session_open") {
      throw new ProbeError(
        "SESSION_OPEN_IN_FLIGHT",
        `session_open already holds appLock (since ${appBusy.busySinceMs}ms). Do not stack opens.`,
        ["session_status", "session_force_unlock", "wait then retry session_open"],
      );
    }

    this.openInFlight = true;
    const bundleId = opts.bundleId;
    const warnings: string[] = [];
    let net: unknown;
    let springboard: unknown;

    try {
    // --- Spawn-only policy (this device stack) ---
    let mode: "spawn" | "attach" = "spawn";
    if (opts.mode === "attach") {
      if (attachAllowed()) {
        mode = "attach";
        warnings.push(
          "mode=attach allowed via FRIDA_MCP_ALLOW_ATTACH=1. Touch may be unreliable (_touchesEvent null).",
        );
      } else {
        warnings.push(
          "mode=attach requested but disabled on this stack — forced mode=spawn. " + SPAWN_ONLY_HINT,
        );
        mode = "spawn";
      }
    } else if (opts.mode && opts.mode !== "spawn") {
      mode = "spawn";
    }

    const openMs = openTimeoutMs();
    const holdMs = sessionOpenHoldTimeoutMs();
    const wantSb = opts.withSpringBoard === true;

    // Started inside appLock after soft-close so we don't race-kill a parallel attach
    let sbPromise: Promise<
      | { ok: true; pid: number; process: string; mode: "attach" }
      | { ok: false; error: string }
    > | null = null;

    try {
      await this.appLock.run(
        async () => {
          const appClose = await this.detachAppSessionUnlocked();
          if (appClose.closeTimedOut) {
            warnings.push(
              `previous app session close timed out after ${closeTimeoutMs()}ms — continued open (orphanFridaOpPossible).`,
            );
          }
          // Must hold sbLock so in-flight sb_alert_* finish (or time out) before we tear SB down
          const sbClose = await this.sbLock.run(
            async () => this.detachSbSessionUnlocked(),
            {
              waitTimeoutMs: lockWaitTimeoutMs(),
              holdTimeoutMs: closeTimeoutMs() + 2_000,
              op: "session_open_sb_teardown",
            },
          );
          if (sbClose.closeTimedOut) {
            warnings.push(
              `previous SpringBoard close timed out after ${closeTimeoutMs()}ms — continued.`,
            );
          }

          // Attach SB in parallel with spawn (separate sbLock).
          // Call unlocked path under sbLock — do not use ensureSpringBoard() (blocked by openInFlight).
          if (wantSb) {
            sbPromise = this.sbLock
              .run(() => this.ensureSpringBoardUnlocked(opts.udid), {
                waitTimeoutMs: lockWaitTimeoutMs(),
                op: "session_open_sb_attach",
              })
              .then((sb) => ({
                ok: true as const,
                pid: sb.pid,
                process: "SpringBoard",
                mode: "attach" as const,
              }))
              .catch((e: unknown) => ({
                ok: false as const,
                error: e instanceof Error ? e.message : String(e),
              }));
          }

          if (mode === "spawn") {
            this.live = await openSpawnSession({
              udid: opts.udid,
              bundleId,
              timeoutMs: openMs,
              onPid: (info) => this.noteInFlightPid(info),
              beforeResume: opts.captureNet
                ? async (script) => {
                    net = await callRpc(script, "netEnable", [
                      {
                        captureResponse: false,
                        maxBody: 8192,
                        captureMode: "all",
                        ...(opts.netOptions ?? {}),
                      },
                    ]);
                  }
                : undefined,
            });
            warnings.push(
              "session opened with spawn (kill → inject while suspended → resume). touchReliable=true.",
            );
            warnings.push(
              "spawn restarts the app process (in-memory UI / some login UI state may reset).",
            );
          } else {
            this.live = await openAttachSession({
              udid: opts.udid,
              bundleId,
              timeoutMs: openMs,
            });
            if (opts.captureNet) {
              net = await callRpc(this.live.script, "netEnable", [
                {
                  captureResponse: false,
                  maxBody: 8192,
                  captureMode: "all",
                  ...(opts.netOptions ?? {}),
                },
              ]);
              warnings.push(
                "captureNet on attach enables hooks late — launch traffic already missed.",
              );
            }
          }

          this.lastAppPid = this.live.pid;
          this.lastAppUdid = this.live.udid;
          this.lastAppBundleId = this.live.bundleId;
          this.inFlightPid = null;
          this.inFlightUdid = undefined;
          this.live.onDead = (reason) => {
            this.markDead(reason);
            this.snapshot = null;
            console.error(`[frida-mcp] session dead: ${reason}`);
          };
        },
        {
          waitTimeoutMs: lockWaitTimeoutMs(),
          holdTimeoutMs: holdMs,
          op: "session_open",
        },
      );
    } catch (e) {
      if (
        e instanceof ProbeError &&
        (e.code === "SESSION_OPEN_TIMEOUT" ||
          e.code === "APP_LOCK_HOLD_TIMEOUT" ||
          e.code === "APP_LOCK_RESET")
      ) {
        this.orphanFridaOpPossible = true;
        // Hold timeout releases the lock while spawn/detach may still run — kill known pid now.
        const kill = await this.orphanKillBestEffort();
        if (kill.attempted) {
          console.error(
            `[frida-mcp] orphan kill after ${e.code}: pid=${kill.pid} ok=${kill.ok}` +
              (kill.error ? ` err=${kill.error}` : ""),
          );
        }
      }
      throw e;
    }

    if (sbPromise) {
      springboard = await sbPromise;
      if ((springboard as { ok?: boolean }).ok) {
        warnings.push(
          "SpringBoard attached in parallel (dual inject). App+SB RPCs use separate locks — concurrent OK.",
        );
      } else {
        warnings.push(
          `withSpringBoard failed: ${(springboard as { error?: string }).error ?? "unknown"}`,
        );
      }
    }

    if (isTikTokBundle(bundleId)) {
      warnings.push(TIKTOK_WAIT_HINT);
      warnings.push(
        'Prefer wait_until_texts({ preset: "tiktok_feed" }) — multi-locale (EN/ZH/JA/KO), do not hardcode one language.',
      );
    }
    if (opts.captureNet) {
      warnings.push(
        "Network capture enabled (NSURLSession + TTNet/Cronet). Prefer captureNet with spawn so hooks are live before resume. TikTok APIs: net_dump({query:\"tiktokv\", redact:false, dedupe:false}).",
      );
    }

    this.orphanFridaOpPossible = false;
    this.openInFlight = false;
    return {
      ...this.status(),
      warnings,
      net,
      springboard,
      loginStateRisk: true,
      dualParallel: true,
      next: isTikTokBundle(bundleId)
        ? 'wait_until_texts({ preset: "tiktok_feed", timeoutMs: 15000 }) then probe. Dual: app + sb_* parallel OK.'
        : "wait(3000-5000) then screen_snapshot. Dual: app tools + sb_* can run in parallel (separate locks).",
    };
    } finally {
      this.openInFlight = false;
    }
  }

  async respawn(): Promise<SessionStatus & { warnings: string[] }> {
    if (!this.live) {
      throw new Error("No session to respawn. Call session_open first.");
    }
    const { udid, bundleId } = this.live;
    return this.open({ udid, bundleId, mode: "spawn", withSpringBoard: !!this.sbLive?.alive });
  }

  /**
   * Close app session. Default also tears down SpringBoard.
   * closeSpringBoard:false keeps SB intentionally (springboardKept, not an error).
   */
  async close(opts: {
    closeSpringBoard?: boolean;
    /** Default true — tear down Photos side channel so photosAlive does not linger */
    closePhotos?: boolean;
  } = {}): Promise<{
    appClosed: boolean;
    springboardClosed: boolean;
    springboardAlive: boolean;
    springboardKept?: boolean;
    photosClosed?: boolean;
    hint?: string;
    closeTimedOut?: boolean;
    orphanKilled?: boolean;
  }> {
    const closeSb = opts.closeSpringBoard !== false;
    const closePhotos = opts.closePhotos !== false;
    this.closeInFlight = { keepSb: !closeSb };
    let closeTimedOut = false;
    let orphanKilled = false;
    let photosClosed = false;
    try {
      await this.appLock.run(
        async () => {
          const r = await this.detachAppSessionUnlocked();
          closeTimedOut = r.closeTimedOut;
          orphanKilled = !!r.killed;
        },
        {
          waitTimeoutMs: lockWaitTimeoutMs(),
          holdTimeoutMs: closeTimeoutMs() + 2_000,
          op: "session_close",
        },
      );
      if (closeSb) {
        this.sbKeepIntentional = false;
        await this.sbClose();
      } else {
        this.sbKeepIntentional = !!this.sbLive?.alive;
      }
      if (closePhotos) {
        try {
          await photosChannel.close({ kill: true });
          photosClosed = true;
        } catch {
          photosClosed = false;
        }
      }
      if (closeSb) {
        return {
          appClosed: true,
          springboardClosed: true,
          springboardAlive: false,
          photosClosed: closePhotos ? photosClosed : undefined,
          closeTimedOut: closeTimedOut || undefined,
          orphanKilled: orphanKilled || undefined,
          hint: orphanKilled
            ? "App close timed out; orphan pid killed. Safe to session_open."
            : "App and SpringBoard sessions closed" +
              (closePhotos ? " (Photos side channel cleared)." : "."),
        };
      }
      return {
        appClosed: true,
        springboardClosed: false,
        springboardAlive: !!this.sbLive?.alive,
        springboardKept: this.sbKeepIntentional,
        photosClosed: closePhotos ? photosClosed : undefined,
        closeTimedOut: closeTimedOut || undefined,
        orphanKilled: orphanKilled || undefined,
        hint: this.sbKeepIntentional
          ? "SpringBoard kept intentionally; call sb_close when done."
          : "App closed; SpringBoard was not attached.",
      };
    } finally {
      this.closeInFlight = null;
    }
  }

  async sbClose(): Promise<void> {
    await this.sbLock.run(
      async () => {
        await this.detachSbSessionUnlocked();
      },
      {
        waitTimeoutMs: lockWaitTimeoutMs(),
        holdTimeoutMs: closeTimeoutMs() + 2_000,
        op: "sb_close",
      },
    );
  }

  /**
   * Emergency recovery when appLock is stuck (hung Frida / Cursor cancel).
   * Does not wait on locks — force-resets then best-effort timed detach + kill.
   */
  async forceUnlock(): Promise<{
    ok: true;
    before: SessionStatus;
    after: SessionStatus;
    appReset: ReturnType<AsyncMutex["forceReset"]>;
    sbReset: ReturnType<AsyncMutex["forceReset"]>;
    orphanKill?: { attempted: boolean; pid?: number; ok?: boolean; error?: string };
    orphanFridaOpPossible: boolean;
    hint: string;
  }> {
    const before = this.status();
    this.openInFlight = false;
    const appReset = this.appLock.forceReset();
    const sbReset = this.sbLock.forceReset();
    this.orphanFridaOpPossible = true;

    // Kill first (while pids still known), then detach pointers.
    const orphanKill = await this.orphanKillBestEffort();

    await this.detachAppSessionUnlocked();
    await this.detachSbSessionUnlocked();
    try {
      await photosChannel.close({ kill: true });
    } catch {
      /* ignore */
    }

    this.lastAppPid = null;
    this.lastAppUdid = undefined;
    this.lastAppBundleId = undefined;
    this.inFlightPid = null;
    this.inFlightUdid = undefined;
    // After successful force path, clear orphan flag so AI may open again.
    this.orphanFridaOpPossible = false;

    return {
      ok: true as const,
      before,
      after: this.status(),
      appReset,
      sbReset,
      orphanKill,
      orphanFridaOpPossible: false,
      hint:
        "Locks reset, sessions detached, best-effort kill of in-flight/last app pid. Safe to session_open once. If device acts oddly, restart MCP.",
    };
  }

  /** Entire app-session op under one lock (serializes AI parallel tap/swipe). */
  private withAppOp<T>(fn: () => Promise<T>, op = "app_op"): Promise<T> {
    // Cap hold so a bad swipe duration (or hung RPC) cannot pin appLock for minutes.
    const holdTimeoutMs = Math.max(15_000, Number(process.env.FRIDA_MCP_APP_OP_HOLD_MS || 45_000));
    return this.appLock.run(fn, {
      waitTimeoutMs: lockWaitTimeoutMs(),
      holdTimeoutMs,
      op,
    });
  }

  /** Mark refs unusable before a mutating act (parallel dual_ping/status must not claim refsValid). */
  private beginUiAct(): void {
    this.uiDirty = true;
  }

  async ping(): Promise<string> {
    return this.withAppOp(async () => {
      const live = this.requireLive();
      try {
        const r = await callRpc(live.script, "ping");
        return String(r);
      } catch (e) {
        this.handleRpcDeath(e);
        throw e;
      }
    });
  }

  async rpc(name: string, args: unknown[] = []): Promise<unknown> {
    // Re-entrant when already inside withAppOp (ALS)
    return this.withAppOp(async () => {
      const live = this.requireLive();
      assertSafeRpc(live.bundleId, name);
      try {
        return await callRpc(live.script, name, args);
      } catch (e) {
        this.handleRpcDeath(e);
        throw e;
      }
    });
  }

  /**
   * Concurrent health check: app ping + SpringBoard ping at the same time.
   * Proves dual inject + parallel locks.
   */
  async dualPing(): Promise<Record<string, unknown>> {
    const started = Date.now();
    const [app, sb] = await Promise.all([
      this.ping()
        .then((pong) => ({ ok: true as const, pong, channel: "app" as const }))
        .catch((e: unknown) => ({
          ok: false as const,
          channel: "app" as const,
          error: e instanceof Error ? e.message : String(e),
        })),
      this.sbLock
        .run(async () => {
          if (this.openInFlight) {
            throw new ProbeError(
              "SESSION_OPEN_IN_FLIGHT",
              "session_open in progress — SpringBoard ping deferred.",
              ["wait for session_open", "or session_force_unlock"],
            );
          }
          const live = await this.ensureSpringBoardUnlocked();
          return String(await callRpc(live.script, "ping"));
        }, { waitTimeoutMs: lockWaitTimeoutMs(), op: "dual_ping_sb" })
        .then((pong) => ({ ok: true as const, pong, channel: "springboard" as const }))
        .catch((e: unknown) => ({
          ok: false as const,
          channel: "springboard" as const,
          error: e instanceof Error ? e.message : String(e),
        })),
    ]);
    // Brief under appLock so we don't race a parallel tap/swipe mid-resnapshot
    const appSession = await this.withAppOp(
      async () => this.appSessionBrief(),
      "dual_ping_status",
    );
    return {
      ok: app.ok && sb.ok,
      parallel: true,
      elapsedMs: Date.now() - started,
      app,
      springboard: sb,
      appSession,
      springboardAlive: !!this.sbLive?.alive,
      springboardPid: this.sbLive?.pid,
      note: "App and SpringBoard RPCs ran under separate locks (true parallel).",
    };
  }

  private handleRpcDeath(e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e);
    if (/script is destroyed|session is dead|detached/i.test(msg)) {
      this.markDead(msg);
      this.snapshot = null;
    }
  }

  private parseWindow(
    wf: unknown,
  ): { width: number; height: number; x: number; y: number; className?: string } | null {
    if (!wf || typeof wf !== "object") return null;
    const o = wf as Record<string, unknown>;
    let width = Number(o.width ?? o.w ?? 0);
    let height = Number(o.height ?? o.h ?? 0);
    let x = Number(o.x ?? 0);
    let y = Number(o.y ?? 0);
    const f = o.frame;
    if ((!width || !height) && Array.isArray(f)) {
      if (typeof f[0] === "number") {
        x = Number(f[0] ?? 0);
        y = Number(f[1] ?? 0);
        width = Number(f[2] ?? 0);
        height = Number(f[3] ?? 0);
      } else if (Array.isArray(f[0]) && Array.isArray(f[1])) {
        // CGRect-like [[x,y],[w,h]]
        x = Number((f[0] as number[])[0] ?? 0);
        y = Number((f[0] as number[])[1] ?? 0);
        width = Number((f[1] as number[])[0] ?? 0);
        height = Number((f[1] as number[])[1] ?? 0);
      }
    }
    const center = o.center;
    if ((!width || !height) && Array.isArray(center) && Array.isArray(f) && typeof f[2] === "number") {
      width = Number(f[2]);
      height = Number(f[3]);
    }
    if (!(width > 0 && height > 0)) return null;
    return {
      width,
      height,
      x,
      y,
      className: typeof o.className === "string" ? o.className : undefined,
    };
  }

  async windowFrame(): Promise<unknown> {
    const raw = await this.rpc("windowFrame");
    const parsed = this.parseWindow(raw);
    if (parsed) {
      return {
        ...parsed,
        cx: parsed.x + parsed.width / 2,
        cy: parsed.y + parsed.height / 2,
        raw,
      };
    }
    return raw;
  }

  async screenSnapshot(
    opts: SnapshotRequest = {},
  ): Promise<{ text: string; table: SnapshotTable }> {
    return this.withAppOp(async () => this.screenSnapshotBody(opts));
  }

  /**
   * Poll screen_snapshot until pattern matches on-screen text or timeout.
   * Prefer over blind wait() after TikTok session_open.
   * Use preset:"tiktok_feed" for multi-locale land (do not hardcode one language).
   */
  async waitUntilTexts(opts: {
    pattern?: string;
    /** e.g. tiktok_feed — multi-locale nav/For-You chrome */
    preset?: string;
    timeoutMs?: number;
    intervalMs?: number;
    searchRegex?: boolean;
    onScreenOnly?: boolean;
  }): Promise<{
    ok: boolean;
    matched: boolean;
    elapsedMs: number;
    polls: number;
    pattern: string;
    preset?: string;
    hits: Array<{ ref: string; text: string; likelyInput?: boolean }>;
    snapshot?: string;
    timedOut?: boolean;
    next?: string;
  }> {
    const presetInfo = resolveTextPreset(opts.preset);
    const pattern = (opts.pattern?.trim() || presetInfo?.pattern || "").trim();
    if (!pattern) {
      throw new ProbeError(
        "INVALID_ARGS",
        'pattern or preset is required. TikTok: wait_until_texts({ preset: "tiktok_feed" })',
        ['wait_until_texts({ preset: "tiktok_feed", timeoutMs: 15000 })'],
      );
    }
    const timeoutMs = Math.max(
      500,
      Math.min(120_000, Math.floor(opts.timeoutMs ?? 15_000)),
    );
    const intervalMs = Math.max(
      200,
      Math.min(5_000, Math.floor(opts.intervalMs ?? 800)),
    );
    // Presets are always regex alternations; explicit pattern keeps resolveSearchMode
    const forceRegex = presetInfo ? true : opts.searchRegex;
    const { useRegex } = resolveSearchMode(pattern, forceRegex);
    const t0 = Date.now();
    let polls = 0;
    let lastText = "";

    while (Date.now() - t0 < timeoutMs) {
      polls += 1;
      const { text, table } = await this.screenSnapshot({
        onScreenOnly: opts.onScreenOnly !== false,
        limit: 40,
        search: pattern,
        searchRegex: useRegex,
      });
      lastText = text;
      const hits = searchSnapshot(table, pattern, useRegex)
        .filter((n) => n.onScreen)
        .slice(0, 8)
        .map((n) => ({
          ref: n.ref,
          text: n.text.length > 80 ? `${n.text.slice(0, 77)}...` : n.text,
          likelyInput: n.likelyInput,
        }));
      if (hits.length > 0) {
        return {
          ok: true,
          matched: true,
          elapsedMs: Date.now() - t0,
          polls,
          pattern,
          preset: presetInfo?.id,
          hits,
          snapshot: text,
          next: "Use refs from snapshot (this generation). Prefer [input] for typing.",
        };
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }

    return {
      ok: false,
      matched: false,
      timedOut: true,
      elapsedMs: Date.now() - t0,
      polls,
      pattern,
      preset: presetInfo?.id,
      hits: [],
      snapshot: lastText || undefined,
      next:
        "Timed out — try preset:\"tiktok_feed\" (multi-locale), or screen_snapshot without filter (login wall?).",
    };
  }

  private async screenSnapshotBody(
    opts: SnapshotRequest = {},
  ): Promise<{ text: string; table: SnapshotTable }> {
    const live = this.requireLive();
    const mode = opts.mode;
    const m = snapshotModeFor(live.bundleId, mode);

    let window: { width: number; height: number } | null = null;
    try {
      const wf = await this.windowFrame();
      const p = this.parseWindow(wf);
      if (p) window = { width: p.width, height: p.height };
    } catch {
      /* optional */
    }

    if (m === "tree") {
      const tree = await this.rpc("dumpTree", [{}]);
      const text =
        `mode=tree (non-TikTok only)\n` +
        `NOTE: tree dump does NOT replace text refs — previous screen_snapshot(texts) refs remain.\n` +
        (typeof tree === "string" ? tree : JSON.stringify(tree, null, 2));
      this.lastTreeText = text;
      const table =
        this.snapshot ??
        ({
          window: window ?? undefined,
          nodes: [],
          rawCount: 0,
          createdAt: Date.now(),
          generation: 0,
        } satisfies SnapshotTable);
      if (window && this.snapshot) {
        this.snapshot = { ...this.snapshot, window };
      }
      return { text, table };
    }

    const items = await this.rpc("collectTextsWithFrames");
    const table = buildTextSnapshot(items, window);
    // Prefer live snapshot; if act cleared it, fall back to last complete table
    const previous = this.snapshot ?? this.prevSnapshot;
    this.snapshot = table;
    this.uiDirty = false;
    const text = formatSnapshot(table, {
      onScreenOnly: opts.onScreenOnly,
      limit: opts.limit,
      search: opts.search,
      searchRegex: opts.searchRegex,
      showDiff: opts.showDiff,
      prev: opts.showDiff ? previous : null,
    });
    // Next showDiff compares against this complete table
    this.prevSnapshot = table;
    this.lastSnapMeta = {
      generation: table.generation,
      at: Date.now(),
      nodeCount: table.nodes.length,
    };
    return { text, table };
  }

  screenSearch(query: string, useRegex = false): {
    nodes: TextNode[];
    refsValid: boolean;
    snapshotGeneration?: number;
    warn?: string;
  } {
    if (this.uiDirty) {
      throw new ProbeError(
        "STALE_REF",
        "UI act in progress (or just finished without valid resnapshot). Call screen_snapshot before screen_search.",
        ["wait for tap/swipe to finish", "screen_snapshot", "then screen_search"],
      );
    }
    if (!this.snapshot) {
      throw new ProbeError("STALE_REF", "No snapshot yet. Call screen_snapshot first.", [
        "screen_snapshot",
      ]);
    }
    const nodes = searchSnapshot(this.snapshot, query, useRegex);
    return {
      nodes,
      refsValid: true,
      snapshotGeneration: this.snapshot.generation,
    };
  }

  resolveRef(ref: string): TextNode {
    if (!this.snapshot) {
      throw new ProbeError(
        "STALE_REF",
        "No snapshot / ref table. Call screen_snapshot first (or use resnapshot on acts).",
        ["screen_snapshot"],
      );
    }
    let node = this.snapshot.nodes.find((n) => n.ref === ref);
    if (!node && /^t\d+$/i.test(ref)) {
      const full = `g${this.snapshot.generation}${ref}`;
      node = this.snapshot.nodes.find((n) => n.ref === full);
    }
    if (!node) {
      throw new ProbeError(
        "STALE_REF",
        `Unknown or expired ref "${ref}". Current generation is g${this.snapshot.generation}.`,
        ["screen_snapshot", "use only refs from the latest generation"],
      );
    }
    return node;
  }

  private resolveTapPoint(opts: {
    ref?: string;
    x?: number;
    y?: number;
  }): { x: number; y: number } {
    let x = opts.x;
    let y = opts.y;
    if (opts.ref) {
      const n = this.resolveRef(opts.ref);
      if (!n.tappable) {
        throw new ProbeError(
          "NOT_TAPPABLE",
          `ref ${opts.ref} ("${n.text}") is not tappable (zero-size frame).`,
          ["pick another ref", "or tap absolute x,y"],
        );
      }
      if (!n.onScreen) {
        throw new ProbeError(
          "OFF_SCREEN",
          `ref ${opts.ref} ("${n.text}") is off-screen (cx=${n.cx}, cy=${n.cy}).`,
          ["swipe toward target", "screen_snapshot", "tap new ref"],
        );
      }
      x = n.cx;
      y = n.cy;
    }
    if (x == null || y == null) {
      throw new ProbeError("INVALID_ARGS", "requires ref or x,y (points)", [
        "screen_snapshot",
        "pass ref or x,y",
      ]);
    }
    return { x, y };
  }

  async tap(opts: {
    ref?: string;
    x?: number;
    y?: number;
    /** Default true: auto screen_snapshot after act */
    resnapshot?: boolean;
  }): Promise<Record<string, unknown>> {
    return this.withAppOp(async () => {
      const { x, y } = this.resolveTapPoint(opts);
      this.beginUiAct();
      const result = await this.rpc("tap", [x, y]);
      const snapshot = await this.maybeResnapshot(opts.resnapshot);
      return this.actEnvelope(result, snapshot, { action: "tap", at: { x, y } });
    });
  }

  /**
   * Open TikTok search landing from For You feed by tapping the top-right magnifier
   * (not the「搜尋」submit button). Retries a few known points until search chrome appears.
   */
  async openTikTokSearch(opts: { maxTries?: number } = {}): Promise<Record<string, unknown>> {
    return this.withAppOp(async () => {
      const settle = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
      const snapOpts = { ...SessionStore.DEFAULT_SNAP, limit: 40 };
      const first = await this.screenSnapshotBody(snapOpts);
      if (looksLikeTikTokSearchPage(first.table.nodes)) {
        return {
          ok: true,
          alreadyOpen: true,
          attempts: 0,
          snapshot: first.text,
          next: "smart_type_text on wide [input]; then tap 搜尋 submit (not smart_type)",
        };
      }
      const maxTries = Math.min(
        TIKTOK_SEARCH_ENTRY_POINTS.length,
        Math.max(1, opts.maxTries ?? TIKTOK_SEARCH_ENTRY_POINTS.length),
      );
      const tried: Array<{ x: number; y: number }> = [];
      let lastSnap = first.text;
      for (let i = 0; i < maxTries; i++) {
        const p = TIKTOK_SEARCH_ENTRY_POINTS[i];
        tried.push(p);
        this.beginUiAct();
        await this.rpc("tap", [p.x, p.y]);
        await settle(500);
        const { text, table } = await this.screenSnapshotBody(snapOpts);
        lastSnap = text;
        if (looksLikeTikTokSearchPage(table.nodes)) {
          return {
            ok: true,
            alreadyOpen: false,
            at: p,
            attempts: i + 1,
            tried,
            snapshot: text,
            next: "smart_type_text on wide [input]; then tap 搜尋 submit (not smart_type)",
          };
        }
      }
      return {
        ok: false,
        tried,
        snapshot: lastSnap,
        recovery: [
          "confirm feed is For You (wait_until_texts tiktok_feed)",
          "tap x≈398 y≈38 manually then screen_snapshot",
          "avoid tapping the narrow 搜尋 label — that submits a query",
        ],
      };
    }, "tiktok_open_search");
  }

  async doubleTap(opts: {
    ref?: string;
    x?: number;
    y?: number;
    gapMs?: number;
    resnapshot?: boolean;
  }): Promise<Record<string, unknown>> {
    return this.withAppOp(async () => {
      const { x, y } = this.resolveTapPoint(opts);
      this.beginUiAct();
      const gapMs = opts.gapMs ?? 140;
      const result = await this.rpc("doubleTap", [x, y, gapMs]);
      const snapshot = await this.maybeResnapshot(opts.resnapshot, 500);
      return this.actEnvelope(result, snapshot, { action: "double_tap", at: { x, y } });
    });
  }

  async setOtp(opts: { code: string; source?: string }): Promise<unknown> {
    const code = String(opts.code ?? "").trim();
    if (!code) throw new Error("code is required");
    return this.rpc("setOtpCode", [code, opts.source ?? "mcp"]);
  }

  async setTextAtPoint(opts: {
    text: string;
    ref?: string;
    x?: number;
    y?: number;
  }): Promise<unknown> {
    const text = String(opts.text ?? "");
    if (!text) throw new Error("text is required");
    const { x, y } = this.resolveTapPoint({ ref: opts.ref, x: opts.x, y: opts.y });
    return this.rpc("setTextAtPoint", [x, y, text]);
  }

  async dumpModal(): Promise<unknown> {
    const live = this.requireLive();
    assertSafeRpc(live.bundleId, "dumpModalView");
    return this.rpc("dumpModalView");
  }

  async rpcCall(name: string, args: unknown[] = []): Promise<unknown> {
    assertWhitelistedRpc(name);
    // Normalize to agent export name used in assertSafeRpc / exports
    const live = this.requireLive();
    assertSafeRpc(live.bundleId, name);
    return this.rpc(name, args);
  }

  // --- SpringBoard (separate attach session; does not replace app session) ---

  /** Caller must hold sbLock (or use ensureSpringBoard which takes it). */
  private async ensureSpringBoardUnlocked(udid?: string): Promise<LiveSession> {
    if (this.sbLive?.alive) return this.sbLive;
    await closeLiveSession(this.sbLive);
    this.sbLive = await openAttachByProcessName({
      udid: udid ?? this.live?.udid,
      processName: "SpringBoard",
    });
    this.sbLive.onDead = (reason) => {
      if (this.sbLive) {
        this.sbLive.alive = false;
        this.sbLive.deadReason = reason;
      }
      console.error(`[frida-mcp] SpringBoard session dead: ${reason}`);
    };
    return this.sbLive;
  }

  private async ensureSpringBoard(udid?: string): Promise<LiveSession> {
    if (this.openInFlight) {
      throw new ProbeError(
        "SESSION_OPEN_IN_FLIGHT",
        "session_open is in progress — wait before sb_ensure / sb_* (open tears down and re-attaches SpringBoard).",
        ["wait for session_open to return", "session_force_unlock if stuck"],
      );
    }
    return this.sbLock.run(() => this.ensureSpringBoardUnlocked(udid), {
      waitTimeoutMs: lockWaitTimeoutMs(),
      op: "sb_ensure",
    });
  }

  private async sbRpc(name: string, args: unknown[] = []): Promise<unknown> {
    if (this.openInFlight) {
      throw new ProbeError(
        "SESSION_OPEN_IN_FLIGHT",
        `session_open is in progress — sb_${name} blocked until open finishes (avoids SCRIPT_DESTROYED on SpringBoard teardown).`,
        [
          "wait for session_open",
          "then sb_alert_list / sb_alert_dismiss",
          "or session_force_unlock if open is stuck",
        ],
      );
    }
    return this.sbLock.run(
      async () => {
        const sb = await this.ensureSpringBoardUnlocked();
        if (!sb.alive) {
          throw new Error("SpringBoard session dead. Retry sb_alert_list.");
        }
        try {
          return await callRpc(sb.script, name, args);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (/script is destroyed|detached/i.test(msg)) {
            this.sbLive = null;
            throw new ProbeError(
              "SCRIPT_DESTROYED",
              `${msg}. SpringBoard session lost — retry sb_alert_list (do not parallel sb_* with session_open).`,
              ["sb_ensure", "sb_alert_list", "or wait for session_open then retry"],
            );
          }
          throw e;
        }
      },
      { waitTimeoutMs: lockWaitTimeoutMs(), op: `sb:${name}` },
    );
  }

  /** Warm SpringBoard inject without listing alerts (parallel with app work). */
  async sbEnsure(): Promise<Record<string, unknown>> {
    const sb = await this.ensureSpringBoard();
    return {
      ok: true,
      springboardAlive: true,
      springboardPid: sb.pid,
      appSession: this.appSessionBrief(),
      dualParallel: true,
      note: "SpringBoard ready. App+SB RPCs can run concurrently under separate locks.",
    };
  }

  async sbAlertList(): Promise<unknown> {
    const r = (await this.sbRpc("sbAlertList")) as Record<string, unknown>;
    const alertCount = Number(r.alertCount ?? 0);
    const actionViewCount = Number(r.actionViewCount ?? 0);
    const actionViewCountRaw = Number(r.actionViewCountRaw ?? actionViewCount);
    const hasAlert =
      typeof r.hasAlert === "boolean"
        ? r.hasAlert
        : alertCount > 0 || actionViewCount > 0;
    const preferDismissAll =
      actionViewCountRaw > 1 || Number(r.alertCountRaw ?? alertCount) > 1;
    return {
      ...r,
      hasAlert,
      preferDismissAll,
      note:
        typeof r.note === "string"
          ? r.note
          : "alerts=SBUserNotificationAlert; actionViews=buttons (test alerts often only actionViews). hasAlert = actionViewCount>0 || alertCount>0.",
      appSession: this.appSessionBrief(),
      springboardAlive: !!this.sbLive?.alive,
      next: !hasAlert
        ? "No SB alert — continue with app screen_snapshot"
        : preferDismissAll
          ? "Stacked/uncertain — sb_alert_dismiss({ all: true }); then app screen_snapshot"
          : 'sb_alert_dismiss({ all: true }) or sb_alert_tap("Dismiss"); then app screen_snapshot',
    };
  }

  async sbAlertTap(title: string): Promise<unknown> {
    if (!title) throw new ProbeError("INVALID_ARGS", "title is required", ["sb_alert_list"]);
    const r = (await this.sbRpc("sbAlertTap", [title])) as Record<string, unknown>;
    return {
      ...r,
      appSession: this.appSessionBrief(),
      next: "screen_snapshot (app session) to continue probing",
    };
  }

  async sbAlertDismiss(
    opts: { policy?: string; all?: boolean; maxRounds?: number } | string = {},
  ): Promise<unknown> {
    // Back-compat: sbAlertDismiss("deny")
    const o =
      typeof opts === "string"
        ? { policy: opts, all: false as boolean | undefined, maxRounds: undefined as number | undefined }
        : opts ?? {};
    const policy = o.policy ?? "deny";
    const all = o.all === true;
    const maxRounds =
      o.maxRounds != null && Number.isFinite(Number(o.maxRounds))
        ? Math.max(1, Math.floor(Number(o.maxRounds)))
        : 5;
    const r = (await this.sbRpc("sbAlertDismiss", [
      { policy, all, maxRounds },
    ])) as Record<string, unknown>;
    const cleared = r.cleared === true;
    const needsRetry = r.needsRetry === true || (!cleared && r.ok === true && all);
    return {
      ...r,
      needsRetry,
      appSession: this.appSessionBrief(),
      springboardAlive: !!this.sbLive?.alive,
      next: cleared
        ? "screen_snapshot (app session) after dismissing system alert"
        : needsRetry || all
          ? "needsRetry — sb_alert_list then sb_alert_dismiss({all:true}) again or sb_alert_tap(title); do not parallel tap+dismiss"
          : "Still present after settle — stacked? sb_alert_dismiss({ all: true }); or re-list",
    };
  }

  async sbAlertTrigger(opts: { force?: boolean } = {}): Promise<unknown> {
    const force = opts.force === true;
    const r = (await this.sbRpc("sbAlertTrigger", [force])) as Record<string, unknown>;
    return {
      ...r,
      force,
      appSession: this.appSessionBrief(),
      springboardAlive: !!this.sbLive?.alive,
      next: r.skipped
        ? 'Alert already present — sb_alert_dismiss({all:true}) or sb_alert_tap; force:true to stack another'
        : r.ok
          ? 'sb_alert_list → sb_alert_dismiss({all:true}) or sb_alert_tap("Dismiss")'
          : "Check SpringBoard attach (sb_ensure) and iOS version support",
    };
  }

  async swipe(opts: {
    direction?: "up" | "down" | "left" | "right";
    x0?: number;
    y0?: number;
    x1?: number;
    y1?: number;
    /** Agent seconds (≤10). Values >10 are treated as milliseconds. Prefer durationMs. */
    duration?: number;
    /** Preferred: milliseconds (e.g. 280). Converted to agent seconds and clamped. */
    durationMs?: number;
    resnapshot?: boolean;
  }): Promise<Record<string, unknown>> {
    return this.withAppOp(async () => {
      this.beginUiAct();
      const norm = normalizeSwipeDuration({
        duration: opts.duration,
        durationMs: opts.durationMs,
      });
      const dur = norm.seconds;
      let result: unknown;
      if (
        opts.x0 != null &&
        opts.y0 != null &&
        opts.x1 != null &&
        opts.y1 != null
      ) {
        result = await this.rpc("swipePath", [opts.x0, opts.y0, opts.x1, opts.y1, dur]);
      } else if (!opts.direction) {
        throw new ProbeError("INVALID_ARGS", "swipe requires direction or x0,y0,x1,y1", [
          "pass direction or path",
        ]);
      } else {
        result = await this.rpc("swipe", [opts.direction, dur]);
      }
      const snapshot = await this.maybeResnapshot(opts.resnapshot, 500);
      return this.actEnvelope(result, snapshot, {
        action: "swipe",
        durationSec: dur,
        ...(norm.warn ? { durationWarn: norm.warn } : {}),
      });
    });
  }

  /**
   * Random short pause between action steps (fleetcontrol human_pause).
   * Not the per-character typing delay — that lives inside agent inputText.
   */
  async humanPause(minMs = 200, maxMs = 500): Promise<{ waitedMs: number }> {
    const lo = Math.max(0, Math.min(minMs, maxMs));
    const hi = Math.max(minMs, maxMs);
    const waitedMs = lo + Math.floor(Math.random() * (hi - lo + 1));
    await new Promise((r) => setTimeout(r, waitedMs));
    return { waitedMs };
  }

  /** Default per-char base delay — matches fleetcontrol TypeTextAction.PER_CHAR_DELAY_MS */
  static readonly PER_CHAR_DELAY_MS = 90;

  /**
   * HumanTypeInFieldAction: 已获焦输入框上的「逐字拟人输入」。
   * Agent inputText: 默认 base=90ms + randomDelay(base, jitter≈base)。
   * 4 级 fallback: insertText → replaceRange → innerInsertText → setText+通知。
   */
  async humanTypeInField(opts: {
    text: string;
    perCharDelayMs?: number;
    resnapshot?: boolean;
  }): Promise<Record<string, unknown>> {
    return this.withAppOp(async () => {
      this.beginUiAct();
      const text = opts.text;
      if (!text) throw new ProbeError("INVALID_ARGS", "text is required", ["type_text"]);
      const perCharDelayMs =
        opts.perCharDelayMs != null && Number.isFinite(opts.perCharDelayMs)
          ? Math.max(0, Number(opts.perCharDelayMs))
          : SessionStore.PER_CHAR_DELAY_MS;

      await this.humanPause(80, 200);
      let frida: unknown;
      try {
        frida = await this.rpc("inputText", [text, perCharDelayMs]);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/no first responder/i.test(msg)) {
          throw new ProbeError(
            "NO_FOCUS",
            `${msg}. Field not focused.`,
            ["smart_type_text with ref or x,y", "or tap input then type_text"],
          );
        }
        throw e;
      }
      await this.humanPause(150, 400);
      const snapshot = await this.maybeResnapshot(opts.resnapshot, 300);
      return {
        ...this.actEnvelope(frida, snapshot, {
          action: "TypeTextAction",
          text,
          perCharDelayMs,
          humanized: true,
        }),
        note: "拟人逐字: base + random jitter inside agent inputText (default base 90ms).",
      };
    });
  }

  /**
   * TypeTextAction — already focused 拟人逐字. Prefer smart_type_text if need focus.
   */
  async typeText(opts: {
    text: string;
    perCharDelayMs?: number;
    resnapshot?: boolean;
  }): Promise<Record<string, unknown>> {
    return this.humanTypeInField(opts);
  }

  /**
   * Heuristic: status chips / non-fields often destroy TikTok session if tapped as "input".
   * e.g.「有什麼好事？」「發佈」「好友」are not text fields.
   */
  private looksLikeNonInputLabel(label: string): boolean {
    const t = label.trim();
    if (!t) return false;
    // Short nav / tab / CTA labels — includes「搜尋」submit button (type first, then tap it)
    if (
      /^(首頁|好友|收信匣|個人資料|發佈|關注中|為您推薦|搜尋|搜索|Search|検索|取消|完成|發送|发佈|一般|設定|设置|Wi-Fi|藍牙|通知|猜您喜歡|熱門搜尋|熱門直播|爆紅歌曲|重新整理|剛剛看過|高度活躍|當地熱門話題|進行中活動)$/i.test(
        t,
      )
    ) {
      return true;
    }
    // Feed status / prompt chips (not real UITextField)
    if (/有什麼|有什么|好事|说点什么|說點什麼|添加评论|新增留言/i.test(t) && t.length <= 24) {
      return true;
    }
    return false;
  }

  /**
   * TikTok AWESearchBar often reports canInsertText=false while inputText still works
   * via inner UISearchBarTextField (proven on device).
   */
  private frAllowsTyping(fr: unknown): boolean {
    if (!fr || typeof fr !== "object") return false;
    const o = fr as {
      canInsertText?: boolean;
      className?: string;
      innerClassName?: string;
    };
    if (o.canInsertText === true) return true;
    const cls = `${o.className ?? ""} ${o.innerClassName ?? ""}`.toLowerCase();
    return (
      cls.includes("searchbar") ||
      cls.includes("uitextfield") ||
      cls.includes("textfield") ||
      cls.includes("uitextview") ||
      cls.includes("textview")
    );
  }

  /**
   * SmartTypeTextAction: tap → wait FR → human_pause → 拟人逐字.
   * Safer defaults: reject non-input labels; no aggressive retry on dead session;
   * SearchBar may type even when canInsertText=false.
   */
  async smartTypeText(opts: {
    text: string;
    ref?: string;
    x?: number;
    y?: number;
    perCharDelayMs?: number;
    waitKeyboardMs?: number;
    /** Default false — retry often kills TikTok after bad first tap */
    retryOnFail?: boolean;
    resnapshot?: boolean;
  }): Promise<Record<string, unknown>> {
    return this.withAppOp(async () => this.smartTypeTextBody(opts));
  }

  private async smartTypeTextBody(opts: {
    text: string;
    ref?: string;
    x?: number;
    y?: number;
    perCharDelayMs?: number;
    waitKeyboardMs?: number;
    retryOnFail?: boolean;
    resnapshot?: boolean;
  }): Promise<Record<string, unknown>> {
    const text = opts.text;
    if (!text) throw new ProbeError("INVALID_ARGS", "text is required", ["smart_type_text"]);
    if (opts.ref == null && (opts.x == null || opts.y == null)) {
      throw new ProbeError(
        "INVALID_ARGS",
        "smart_type_text requires ref or x,y to tap the input field",
        ["screen_snapshot", "pass ref of input or x,y"],
      );
    }

    const waitKeyboardMs = opts.waitKeyboardMs ?? 2000;
    const retryOnFail = opts.retryOnFail === true; // default OFF for stability
    const perCharDelayMs =
      opts.perCharDelayMs != null && Number.isFinite(opts.perCharDelayMs)
        ? Math.max(0, Number(opts.perCharDelayMs))
        : SessionStore.PER_CHAR_DELAY_MS;

    let tapX: number;
    let tapY: number;
    let tapMeta: Record<string, unknown> = {};
    if (opts.ref) {
      const n = this.resolveRef(opts.ref);
      if (this.looksLikeNonInputLabel(n.text)) {
        throw new ProbeError(
          "NOT_INPUT",
          `ref ${opts.ref} text ${JSON.stringify(n.text)} looks like chrome/chip, not a text field. Do not smart_type it.`,
          [
            "screen_snapshot — use wide search-bar [input], not the 搜尋/Search submit button",
            "tap a real field then type_text",
            "after typing, tap(ref) on 搜尋 to submit",
          ],
        );
      }
      tapX = n.cx;
      tapY = n.cy;
      tapMeta = { ref: n.ref, label: n.text, className: n.className };
    } else {
      tapX = opts.x!;
      tapY = opts.y!;
    }

    this.beginUiAct();

    const tapTarget = async () => {
      await this.rpc("tap", [tapX, tapY]);
      this.uiDirty = true;
      return { x: tapX, y: tapY, ...tapMeta };
    };

    const waitFirstResponder = async (): Promise<{
      fr: unknown;
      canType: boolean;
    }> => {
      const deadline = Date.now() + waitKeyboardMs;
      let last: unknown = null;
      while (Date.now() < deadline) {
        try {
          last = await this.rpc("firstResponderInfo");
          if (this.frAllowsTyping(last)) {
            return { fr: last, canType: true };
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (/script is destroyed|session is dead|destroyed/i.test(msg)) {
            throw e;
          }
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return { fr: last, canType: this.frAllowsTyping(last) };
    };

    const tryType = async () => {
      try {
        const frida = await this.rpc("inputText", [text, perCharDelayMs]);
        return { ok: true as const, frida };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          ok: false as const,
          error: msg,
          fatal: /script is destroyed|session is dead|destroyed/i.test(msg),
        };
      }
    };

    await this.humanPause(80, 200);
    let tap1: Record<string, unknown>;
    try {
      tap1 = await tapTarget();
    } catch (e) {
      const snapshot = await this.maybeResnapshot(opts.resnapshot, 300).catch(
        () => undefined,
      );
      void snapshot;
      throw e instanceof ProbeError
        ? e
        : new ProbeError(
            "SCRIPT_DESTROYED",
            e instanceof Error ? e.message : String(e),
            ["session_respawn", "wait(4000)", "screen_snapshot"],
          );
    }

    let frWait: { fr: unknown; canType: boolean };
    try {
      frWait = await waitFirstResponder();
    } catch (e) {
      const snapshot = await this.maybeResnapshot(false).catch(() => undefined);
      void snapshot;
      throw new ProbeError(
        "SCRIPT_DESTROYED",
        e instanceof Error ? e.message : String(e),
        ["session_respawn", "wait(4000)", "screen_snapshot", "avoid non-input refs"],
      );
    }

    if (!frWait.canType) {
      const snapshot = await this.maybeResnapshot(opts.resnapshot, 300);
      return {
        ...this.actEnvelope(
          { ok: false, reason: "no typable firstResponder after tap" },
          snapshot,
          {
            action: "SmartTypeTextAction",
            ok: false,
            code: "NOT_INPUT",
            text,
            tap: tap1,
            firstResponder: frWait.fr,
            retried: false,
            recovery: [
              "ref is probably not an editable field",
              "prefer wide search-bar placeholder [input], not hot-search chips",
              "or tap search bar then type_text (SearchBar may report canInsertText=false)",
            ],
          },
        ),
        ok: false,
      };
    }

    await this.humanPause(200, 400);
    let type1 = await tryType();
    if (type1.fatal) {
      throw new ProbeError("SCRIPT_DESTROYED", type1.error, [
        "session_respawn",
        "wait(4000)",
        "screen_snapshot",
        "do not retry-tap non-input",
      ]);
    }

    if (type1.ok || !retryOnFail) {
      await this.humanPause(150, 400);
      const snapshot = await this.maybeResnapshot(opts.resnapshot, 350);
      return {
        ...this.actEnvelope(type1, snapshot, {
          action: "SmartTypeTextAction",
          text,
          perCharDelayMs,
          humanized: true,
          tap: tap1,
          firstResponder: frWait.fr,
          type_text: type1,
          retried: false,
          ok: type1.ok,
          ...(type1.ok
            ? {}
            : {
                error: type1.error,
                recovery: [
                  "try type_text after focusing search bar",
                  "screen_snapshot for a better [input] ref",
                ],
              }),
        }),
      };
    }

    // Optional single retry only when explicitly enabled and session still alive
    const tap2 = await tapTarget();
    const fr2 = await waitFirstResponder();
    if (!fr2.canType) {
      const snapshot = await this.maybeResnapshot(opts.resnapshot, 300);
      return {
        ...this.actEnvelope(
          { ok: false, reason: "retry: still no typable firstResponder" },
          snapshot,
          {
            action: "SmartTypeTextAction",
            ok: false,
            code: "NOT_INPUT",
            retried: true,
            tap: tap1,
            retry_tap: tap2,
            firstResponder: frWait.fr,
            retry_first_responder: fr2.fr,
          },
        ),
        ok: false,
      };
    }
    await this.humanPause(200, 400);
    const type2 = await tryType();
    if (type2.fatal) {
      throw new ProbeError("SCRIPT_DESTROYED", type2.error, [
        "session_respawn",
        "wait(4000)",
        "screen_snapshot",
      ]);
    }
    await this.humanPause(150, 400);
    const snapshot = await this.maybeResnapshot(opts.resnapshot, 350);

    return {
      ...this.actEnvelope(type2, snapshot, {
        action: "SmartTypeTextAction",
        text,
        perCharDelayMs,
        humanized: true,
        tap: tap1,
        firstResponder: frWait.fr,
        type_text_first: type1,
        retry_tap: tap2,
        retry_first_responder: fr2.fr,
        type_text: type2,
        retried: true,
        ok: type2.ok,
        ...(type2.ok ? {} : { error: type2.error }),
      }),
    };
  }

  async clearText(): Promise<unknown> {
    return this.rpc("clearText");
  }

  async firstResponder(): Promise<unknown> {
    return this.rpc("firstResponderInfo");
  }

  async pressHome(): Promise<unknown> {
    return this.withAppOp(async () => {
      this.beginUiAct();
      // App backgrounds; keep session but clear snapshot
      this.snapshot = null;
      this.uiDirty = false;
      return this.rpc("pressHome");
    });
  }

  async netEnable(options: {
    maxBody?: number;
    captureResponse?: boolean;
    urlFilter?: string;
    captureMode?: string;
    signTrace?: boolean;
  } = {}): Promise<unknown> {
    return this.rpc("netEnable", [options]);
  }

  async netDisable(): Promise<unknown> {
    return this.rpc("netDisable");
  }

  async netClear(): Promise<unknown> {
    return this.rpc("netClear");
  }

  async netStatus(): Promise<unknown> {
    return this.rpc("netStatus");
  }

  async signLast(options: { limit?: number } = {}): Promise<unknown> {
    return this.rpc("signLast", [options]);
  }

  async tiktokIm(options: {
    action: string;
    conversationId?: string;
    text?: string;
    dryRun?: boolean;
    limit?: number;
    peerUid?: string;
    onlyUnread?: boolean;
    timeoutMs?: number;
    transport?: "network" | "sdk";
    confirmTimeoutMs?: number;
  }): Promise<unknown> {
    const action = String(options.action || "status").toLowerCase();
    if (action === "status") return this.rpc("imStatus");
    if (action === "conversations") {
      return this.rpc("imListConversations", [{ limit: options.limit, timeoutMs: options.timeoutMs }]);
    }
    if (action === "inbox") {
      return this.rpc("imInboxMessages", [{
        limit: options.limit,
        onlyUnread: options.onlyUnread === true,
        timeoutMs: options.timeoutMs,
      }]);
    }
    if (action === "send_text") {
      return this.rpc("imSendText", [
        {
          conversationId: options.conversationId,
          text: options.text,
          dryRun: options.dryRun !== false,
          peerUid: options.peerUid,
          transport: options.transport || "network",
          confirmTimeoutMs: options.confirmTimeoutMs,
        },
      ]);
    }
    if (action === "messages") {
      return this.rpc("imListMessages", [
        { conversationId: options.conversationId, limit: options.limit },
      ]);
    }
    if (action === "open_chat") {
      if (options.peerUid) {
        return this.rpc("imOpenChatByPeerUid", [{ peerUid: options.peerUid }]);
      }
      return this.rpc("imOpenChat", [{ conversationId: options.conversationId }]);
    }
    if (action === "peer_conversation") {
      return this.rpc("imConversationIdForPeer", [options.peerUid || ""]);
    }
    if (action === "phone_status") return this.rpc("userPhoneBindStatus");
    throw new Error(
      `tiktok_im unknown action "${options.action}". Use status|conversations|inbox|send_text|messages|open_chat|peer_conversation|phone_status`,
    );
  }

  /** Read normal Inbox plus Message Requests without navigating TikTok UIKit. */
  async tiktokInbox(options: {
    limit?: number;
    onlyUnread?: boolean;
    timeoutMs?: number;
  } = {}): Promise<unknown> {
    return this.rpc("imInboxMessages", [{
      limit: options.limit,
      onlyUnread: options.onlyUnread === true,
      timeoutMs: options.timeoutMs,
    }]);
  }

  /** Send through TikTok's real chat composer and require exact text re-read. */
  async tiktokReply(options: {
    conversationId?: string;
    peerUid?: string;
    text: string;
    dryRun?: boolean;
    confirmTimeoutMs?: number;
  }): Promise<unknown> {
    return this.rpc("imSendText", [{
      conversationId: options.conversationId,
      peerUid: options.peerUid,
      text: options.text,
      dryRun: options.dryRun !== false,
      transport: "network",
      confirmTimeoutMs: options.confirmTimeoutMs,
    }]);
  }

  async tiktokPosts(options: {
    count?: number;
    cursor?: string;
    userId?: string;
    url?: string;
  } = {}): Promise<unknown> {
    return this.rpc("postsListSelf", [options]);
  }

  async tiktokSign(options: {
    action?: string;
    limit?: number;
  } = {}): Promise<unknown> {
    const action = String(options.action || "last").toLowerCase();
    if (action === "enable_trace") {
      return this.rpc("netEnable", [{ signTrace: true, captureMode: "ttnet" }]);
    }
    if (action === "last") {
      return this.rpc("signLast", [{ limit: options.limit }]);
    }
    throw new Error(`tiktok_sign unknown action "${options.action}". Use last|enable_trace`);
  }

  async netDump(
    options: {
      limit?: number;
      query?: string;
      /** Default true — redact secrets for open-source safety */
      redact?: boolean;
      /** If true, only return host counts (low noise) */
      summaryOnly?: boolean;
      /** Include data:image/... base64 URLs. Default false. */
      includeDataUrls?: boolean;
      /** Include binary/octet-stream body previews. Default false. */
      includeBinaryBodies?: boolean;
      /** Dedupe method+url (keep first). Default true. */
      dedupe?: boolean;
    } = {},
  ): Promise<unknown> {
    const { quietNetDump, summarizeNetHosts } = await import("./redact.js");
    const raw = (await this.rpc("netDump", [
      { limit: options.limit, query: options.query },
    ])) as Record<string, unknown>;
    const redact = options.redact !== false;
    const quietOpts = {
      redact,
      includeDataUrls: options.includeDataUrls === true,
      includeBinaryBodies: options.includeBinaryBodies === true,
      dedupe: options.dedupe !== false,
    };
    if (options.summaryOnly) {
      const entries = Array.isArray(raw.entries) ? raw.entries : [];
      const summary = summarizeNetHosts(entries);
      return {
        ok: true,
        summaryOnly: true,
        redacted: true,
        enabled: raw.enabled,
        rawCount: entries.length,
        returned: summary.hosts.length,
        count: summary.hosts.length,
        ...summary,
        note: "summaryOnly: rawCount=capture entries; returned/count=distinct hosts. data: → host (data-url).",
      };
    }
    return quietNetDump(raw, quietOpts);
  }
}

/** Singleton for embedded (stdio single-process) mode. */
export const sessionStore = new SessionStore();

export type { SessionStore };


