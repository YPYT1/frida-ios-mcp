import {
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
  buildTextSnapshot,
  formatSnapshot,
  searchSnapshot,
  type SnapshotFormatOpts,
  type SnapshotTable,
  type TextNode,
} from "./snapshot.js";
import { ProbeError } from "./errors.js";
import { AsyncMutex, type MutexStatus } from "./mutex.js";
import { photosChannel } from "./photos.js";

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
  hasSnapshot?: boolean;
  snapshotNodeCount?: number;
  snapshotGeneration?: number;
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
    const lockHint = this.lockHint(this.appLock.status());
    if (!this.live) {
      const sbAlive = !!this.sbLive?.alive;
      const intentionalKeep = sbAlive && this.sbKeepIntentional;
      const ph = photosChannel.status();
      return {
        open: false,
        alive: false,
        injected: false,
        hasSnapshot: false,
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
      hasSnapshot: !!this.snapshot,
      snapshotNodeCount: this.snapshot?.nodes.length ?? 0,
      snapshotGeneration: this.snapshot?.generation,
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
    const hasLiveRefs = !!this.snapshot;
    return {
      alive: !!s.alive,
      open: s.open,
      bundleId: s.bundleId,
      /** Current in-memory ref table is valid for tap/type */
      hasSnapshot: hasLiveRefs,
      refsValid: hasLiveRefs,
      /** Last completed snapshot gen (may be stale after act cleared refs) */
      lastSnapshotGeneration:
        this.snapshot?.generation ?? this.lastSnapMeta?.generation,
      snapshotStale: !this.snapshot && !!this.lastSnapMeta,
      snapshotGeneration: s.snapshotGeneration,
      note: !hasLiveRefs && this.lastSnapMeta
        ? "refs cleared/stale — call screen_snapshot before tap(ref)"
        : undefined,
    };
  }

  /** Drop app session pointers then timed detach (caller must hold appLock or be forceUnlock). */
  private async detachAppSessionUnlocked(): Promise<{ closeTimedOut: boolean }> {
    const live = this.live;
    this.live = null;
    this.snapshot = null;
    this.prevSnapshot = null;
    this.lastTreeText = null;
    this.lastSnapMeta = null;
    const r = await closeLiveSession(live);
    if (r.timedOut) this.orphanFridaOpPossible = true;
    return { closeTimedOut: r.timedOut };
  }

  private async detachSbSessionUnlocked(): Promise<{ closeTimedOut: boolean }> {
    const sb = this.sbLive;
    this.sbLive = null;
    this.sbKeepIntentional = false;
    const r = await closeLiveSession(sb);
    if (r.timedOut) this.orphanFridaOpPossible = true;
    return { closeTimedOut: r.timedOut };
  }

  /** After UI act: optional auto screen_snapshot (default true). */
  private async maybeResnapshot(
    resnapshot: boolean | undefined,
    settleMs = 450,
  ): Promise<string | undefined> {
    if (resnapshot === false) return undefined;
    await new Promise((r) => setTimeout(r, settleMs));
    // Caller must already hold appLock (re-entrant screenSnapshotBody)
    const { text } = await this.screenSnapshotBody({ ...SessionStore.DEFAULT_SNAP });
    return text;
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
    const bundleId = opts.bundleId;
    const warnings: string[] = [];
    let net: unknown;
    let springboard: unknown;

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
          const sbClose = await this.detachSbSessionUnlocked();
          if (sbClose.closeTimedOut) {
            warnings.push(
              `previous SpringBoard close timed out after ${closeTimeoutMs()}ms — continued.`,
            );
          }

          // Attach SB in parallel with spawn (separate sbLock)
          if (wantSb) {
            sbPromise = this.ensureSpringBoard(opts.udid)
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
              beforeResume: opts.captureNet
                ? async (script) => {
                    net = await callRpc(script, "netEnable", [
                      {
                        captureResponse: false,
                        maxBody: 2048,
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
                  maxBody: 2048,
                  ...(opts.netOptions ?? {}),
                },
              ]);
              warnings.push(
                "captureNet on attach enables hooks late — launch traffic already missed.",
              );
            }
          }

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
    }
    if (opts.captureNet) {
      warnings.push(
        "Network capture enabled (NSURLSession). Prefer captureNet with spawn so hooks are live before resume.",
      );
    }

    this.orphanFridaOpPossible = false;
    return {
      ...this.status(),
      warnings,
      net,
      springboard,
      loginStateRisk: true,
      dualParallel: true,
      next:
        "wait(3000-5000) then screen_snapshot. Dual: app tools + sb_* can run in parallel (separate locks).",
    };
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
  async close(opts: { closeSpringBoard?: boolean } = {}): Promise<{
    appClosed: boolean;
    springboardClosed: boolean;
    springboardAlive: boolean;
    springboardKept?: boolean;
    hint?: string;
    closeTimedOut?: boolean;
  }> {
    const closeSb = opts.closeSpringBoard !== false;
    let closeTimedOut = false;
    await this.appLock.run(
      async () => {
        const r = await this.detachAppSessionUnlocked();
        closeTimedOut = r.closeTimedOut;
      },
      {
        waitTimeoutMs: lockWaitTimeoutMs(),
        holdTimeoutMs: closeTimeoutMs() + 2_000,
        op: "session_close",
      },
    );
    let springboardClosed = false;
    if (closeSb) {
      this.sbKeepIntentional = false;
      await this.sbClose();
      springboardClosed = true;
      return {
        appClosed: true,
        springboardClosed: true,
        springboardAlive: false,
        closeTimedOut: closeTimedOut || undefined,
        hint: "App and SpringBoard sessions closed.",
      };
    }
    this.sbKeepIntentional = !!this.sbLive?.alive;
    return {
      appClosed: true,
      springboardClosed: false,
      springboardAlive: !!this.sbLive?.alive,
      springboardKept: this.sbKeepIntentional,
      closeTimedOut: closeTimedOut || undefined,
      hint: this.sbKeepIntentional
        ? "SpringBoard kept intentionally; call sb_close when done."
        : "App closed; SpringBoard was not attached.",
    };
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
   * Does not wait on locks — force-resets then best-effort timed detach.
   */
  async forceUnlock(): Promise<{
    ok: true;
    before: SessionStatus;
    after: SessionStatus;
    appReset: ReturnType<AsyncMutex["forceReset"]>;
    sbReset: ReturnType<AsyncMutex["forceReset"]>;
    orphanFridaOpPossible: true;
    hint: string;
  }> {
    const before = this.status();
    const appReset = this.appLock.forceReset();
    const sbReset = this.sbLock.forceReset();
    this.orphanFridaOpPossible = true;

    await this.detachAppSessionUnlocked();
    await this.detachSbSessionUnlocked();

    return {
      ok: true as const,
      before,
      after: this.status(),
      appReset,
      sbReset,
      orphanFridaOpPossible: true as const,
      hint:
        "Locks reset and sessions detached best-effort. A native Frida call may still be running in background — if device acts oddly, restart MCP.",
    };
  }

  /** Entire app-session op under one lock (serializes AI parallel tap/swipe). */
  private withAppOp<T>(fn: () => Promise<T>, op = "app_op"): Promise<T> {
    return this.appLock.run(fn, {
      waitTimeoutMs: lockWaitTimeoutMs(),
      op,
    });
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
          const live = await this.ensureSpringBoardUnlocked();
          return String(await callRpc(live.script, "ping"));
        })
        .then((pong) => ({ ok: true as const, pong, channel: "springboard" as const }))
        .catch((e: unknown) => ({
          ok: false as const,
          channel: "springboard" as const,
          error: e instanceof Error ? e.message : String(e),
        })),
    ]);
    return {
      ok: app.ok && sb.ok,
      parallel: true,
      elapsedMs: Date.now() - started,
      app,
      springboard: sb,
      appSession: this.appSessionBrief(),
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

  screenSearch(query: string, useRegex = false): TextNode[] {
    if (!this.snapshot) {
      throw new ProbeError("STALE_REF", "No snapshot yet. Call screen_snapshot first.", [
        "screen_snapshot",
      ]);
    }
    return searchSnapshot(this.snapshot, query, useRegex);
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
      const result = await this.rpc("tap", [x, y]);
      this.snapshot = null;
      const snapshot = await this.maybeResnapshot(opts.resnapshot);
      return this.actEnvelope(result, snapshot, { action: "tap", at: { x, y } });
    });
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
      const gapMs = opts.gapMs ?? 140;
      const result = await this.rpc("doubleTap", [x, y, gapMs]);
      this.snapshot = null;
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
    return this.sbLock.run(() => this.ensureSpringBoardUnlocked(udid), {
      waitTimeoutMs: lockWaitTimeoutMs(),
      op: "sb_ensure",
    });
  }

  private async sbRpc(name: string, args: unknown[] = []): Promise<unknown> {
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
            throw new Error(`${msg}. SpringBoard session lost — retry sb_alert_list.`);
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
    const hasAlert =
      typeof r.hasAlert === "boolean"
        ? r.hasAlert
        : alertCount > 0 || actionViewCount > 0;
    return {
      ...r,
      hasAlert,
      note:
        typeof r.note === "string"
          ? r.note
          : "alerts=SBUserNotificationAlert; actionViews=buttons (test alerts often only actionViews). hasAlert = actionViewCount>0 || alertCount>0.",
      appSession: this.appSessionBrief(),
      springboardAlive: !!this.sbLive?.alive,
      next: hasAlert
        ? 'Unsure if stacked (live count can undercount) → sb_alert_dismiss({ all: true }); then app screen_snapshot'
        : "No SB alert — continue with app screen_snapshot",
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
    duration?: number;
    resnapshot?: boolean;
  }): Promise<Record<string, unknown>> {
    return this.withAppOp(async () => {
      const dur = opts.duration ?? 0.4;
      this.snapshot = null;
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
      return this.actEnvelope(result, snapshot, { action: "swipe" });
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
      this.snapshot = null;
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
    // Short nav / tab / CTA labels
    if (
      /^(首頁|好友|收信匣|個人資料|發佈|關注中|為您推薦|搜尋|搜索|取消|完成|發送|发佈|一般|設定|设置|Wi-Fi|藍牙|通知)$/i.test(
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
   * SmartTypeTextAction: tap → wait FR → human_pause → 拟人逐字.
   * Safer defaults: reject non-input labels; no aggressive retry on dead session;
   * require canInsertText before typing when possible.
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
            "screen_snapshot({ search: \"搜尋|Search|评论|留言\" })",
            "tap a real field then type_text",
            "first_responder to verify canInsertText",
          ],
        );
      }
      tapX = n.cx;
      tapY = n.cy;
      tapMeta = { ref: n.ref, label: n.text };
    } else {
      tapX = opts.x!;
      tapY = opts.y!;
    }

    const tapTarget = async () => {
      await this.rpc("tap", [tapX, tapY]);
      this.snapshot = null;
      return { x: tapX, y: tapY, ...tapMeta };
    };

    const waitFirstResponder = async (): Promise<{
      fr: unknown;
      canInsert: boolean;
    }> => {
      const deadline = Date.now() + waitKeyboardMs;
      let last: unknown = null;
      while (Date.now() < deadline) {
        try {
          last = await this.rpc("firstResponderInfo");
          if (
            last &&
            typeof last === "object" &&
            (last as { canInsertText?: boolean }).canInsertText
          ) {
            return { fr: last, canInsert: true };
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (/script is destroyed|session is dead|destroyed/i.test(msg)) {
            throw e;
          }
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return { fr: last, canInsert: false };
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
      throw e instanceof ProbeError
        ? e
        : new ProbeError(
            "SCRIPT_DESTROYED",
            e instanceof Error ? e.message : String(e),
            ["session_respawn", "wait(4000)", "screen_snapshot"],
          );
    }

    let frWait: { fr: unknown; canInsert: boolean };
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

    if (!frWait.canInsert) {
      const snapshot = await this.maybeResnapshot(opts.resnapshot, 300);
      return {
        ...this.actEnvelope(
          { ok: false, reason: "no canInsertText after tap" },
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
              "screen_snapshot search for 搜尋/Search/评论",
              "first_responder before type_text",
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
        }),
      };
    }

    // Optional single retry only when explicitly enabled and session still alive
    const tap2 = await tapTarget();
    const fr2 = await waitFirstResponder();
    if (!fr2.canInsert) {
      const snapshot = await this.maybeResnapshot(opts.resnapshot, 300);
      return {
        ...this.actEnvelope(
          { ok: false, reason: "retry: still no canInsertText" },
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
    // App backgrounds; keep session but clear snapshot
    this.snapshot = null;
    return this.rpc("pressHome");
  }

  async netEnable(options: {
    maxBody?: number;
    captureResponse?: boolean;
    urlFilter?: string;
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
