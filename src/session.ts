import {
  closeLiveSession,
  callRpc,
  openAttachByProcessName,
  openAttachSession,
  openSpawnSession,
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
import { AsyncMutex } from "./mutex.js";

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
  /** Dual-session model: app + SB held together; RPCs use separate locks */
  dualParallel?: boolean;
  springboardPid?: number;
};

export type SnapshotRequest = SnapshotFormatOpts & {
  mode?: "texts" | "tree";
};

class SessionStore {
  private live: LiveSession | null = null;
  /** Parallel SpringBoard session (attach by process name) — does not replace app live */
  private sbLive: LiveSession | null = null;
  private snapshot: SnapshotTable | null = null;
  /** Previous texts snapshot for showDiff */
  private prevSnapshot: SnapshotTable | null = null;
  /** Last tree dump text (does not replace text ref table) */
  private lastTreeText: string | null = null;

  /**
   * Separate locks: App RPCs and SpringBoard RPCs can run concurrently
   * (e.g. Promise.all([screen_snapshot, sb_alert_list])).
   * Same-channel calls still serialize (safe for Frida script).
   */
  private readonly appLock = new AsyncMutex();
  private readonly sbLock = new AsyncMutex();

  /** Default snapshot opts for auto-resnapshot after acts */
  static readonly DEFAULT_SNAP: SnapshotFormatOpts = {
    onScreenOnly: true,
    limit: 40,
  };

  status(): SessionStatus {
    if (!this.live) {
      const sbOrphan = !!this.sbLive?.alive;
      return {
        open: false,
        alive: false,
        injected: false,
        hasSnapshot: false,
        springboardAlive: sbOrphan,
        springboardPid: this.sbLive?.alive ? this.sbLive.pid : undefined,
        dualParallel: true,
        hint: sbOrphan
          ? "App session closed but SpringBoard still attached (orphan). Call sb_close or session_close."
          : undefined,
        recovery: sbOrphan
          ? ["sb_close", "session_open"]
          : ["session_open", "wait(3000-5000)", "screen_snapshot"],
      };
    }
    const alive = this.live.alive;
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
      hint: !alive
        ? "Session script is dead. Call session_respawn or session_open."
        : isTikTokBundle(this.live.bundleId)
          ? TIKTOK_WAIT_HINT
          : undefined,
      recovery: !alive
        ? ["session_respawn", "wait(4000)", "screen_snapshot", "note: spawn may reset login UI"]
        : undefined,
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
    return {
      alive: !!s.alive,
      open: s.open,
      bundleId: s.bundleId,
      hasSnapshot: s.hasSnapshot,
      snapshotGeneration: s.snapshotGeneration,
    };
  }

  /** After UI act: optional auto screen_snapshot (default true). */
  private async maybeResnapshot(
    resnapshot: boolean | undefined,
    settleMs = 450,
  ): Promise<string | undefined> {
    if (resnapshot === false) return undefined;
    await new Promise((r) => setTimeout(r, settleMs));
    const { text } = await this.screenSnapshot({ ...SessionStore.DEFAULT_SNAP });
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
    await this.appLock.run(async () => {
      await this.close();
    });
    const bundleId = opts.bundleId;
    const warnings: string[] = [];
    let net: unknown;
    let springboard: unknown;

    // --- Spawn-only policy (this device stack) ---
    // Default always spawn. attach only if FRIDA_MCP_ALLOW_ATTACH=1.
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

    // Optionally start SpringBoard attach in parallel with app spawn
    const sbPromise =
      opts.withSpringBoard === true
        ? this.ensureSpringBoard(opts.udid)
            .then((sb) => ({
              ok: true as const,
              pid: sb.pid,
              process: "SpringBoard",
              mode: "attach" as const,
            }))
            .catch((e: unknown) => ({
              ok: false as const,
              error: e instanceof Error ? e.message : String(e),
            }))
        : null;

    await this.appLock.run(async () => {
      if (mode === "spawn") {
        this.live = await openSpawnSession({
          udid: opts.udid,
          bundleId,
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
        this.live = await openAttachSession({ udid: opts.udid, bundleId });
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
    });

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
   * Close app session. By default also tears down SpringBoard (no orphan SB).
   * Pass closeSpringBoard:false to keep SB for next app open.
   */
  async close(opts: { closeSpringBoard?: boolean } = {}): Promise<{
    appClosed: boolean;
    springboardClosed: boolean;
    springboardAlive: boolean;
  }> {
    const closeSb = opts.closeSpringBoard !== false;
    await this.appLock.run(async () => {
      const live = this.live;
      this.live = null;
      this.snapshot = null;
      this.prevSnapshot = null;
      this.lastTreeText = null;
      await closeLiveSession(live);
    });
    let springboardClosed = false;
    if (closeSb) {
      await this.sbClose();
      springboardClosed = true;
    }
    return {
      appClosed: true,
      springboardClosed,
      springboardAlive: !!this.sbLive?.alive,
    };
  }

  async sbClose(): Promise<void> {
    await this.sbLock.run(async () => {
      const sb = this.sbLive;
      this.sbLive = null;
      await closeLiveSession(sb);
    });
  }

  async ping(): Promise<string> {
    return this.appLock.run(async () => {
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
    return this.appLock.run(async () => {
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
    const { x, y } = this.resolveTapPoint(opts);
    const result = await this.rpc("tap", [x, y]);
    this.snapshot = null;
    const snapshot = await this.maybeResnapshot(opts.resnapshot);
    return this.actEnvelope(result, snapshot, { action: "tap", at: { x, y } });
  }

  async doubleTap(opts: {
    ref?: string;
    x?: number;
    y?: number;
    gapMs?: number;
    resnapshot?: boolean;
  }): Promise<Record<string, unknown>> {
    const { x, y } = this.resolveTapPoint(opts);
    const gapMs = opts.gapMs ?? 140;
    const result = await this.rpc("doubleTap", [x, y, gapMs]);
    this.snapshot = null;
    const snapshot = await this.maybeResnapshot(opts.resnapshot, 500);
    return this.actEnvelope(result, snapshot, { action: "double_tap", at: { x, y } });
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
    return this.sbLock.run(() => this.ensureSpringBoardUnlocked(udid));
  }

  private async sbRpc(name: string, args: unknown[] = []): Promise<unknown> {
    return this.sbLock.run(async () => {
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
    });
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
    return {
      ...r,
      appSession: this.appSessionBrief(),
      springboardAlive: !!this.sbLive?.alive,
      next:
        "After sb_alert_tap/dismiss, call screen_snapshot on the APP session (not sb).",
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

  async sbAlertDismiss(policy?: string): Promise<unknown> {
    const r = (await this.sbRpc("sbAlertDismiss", [policy ?? "deny"])) as Record<
      string,
      unknown
    >;
    return {
      ...r,
      appSession: this.appSessionBrief(),
      next: "screen_snapshot (app session) after dismissing system alert",
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
   * SmartTypeTextAction: tap → wait FR → human_pause → 拟人逐字 (+retry).
   * Internal taps use resnapshot=false; optional final resnapshot defaults true.
   */
  async smartTypeText(opts: {
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
    const retryOnFail = opts.retryOnFail !== false;
    const perCharDelayMs =
      opts.perCharDelayMs != null && Number.isFinite(opts.perCharDelayMs)
        ? Math.max(0, Number(opts.perCharDelayMs))
        : SessionStore.PER_CHAR_DELAY_MS;

    let tapX: number;
    let tapY: number;
    let tapMeta: Record<string, unknown> = {};
    if (opts.ref) {
      const n = this.resolveRef(opts.ref);
      tapX = n.cx;
      tapY = n.cy;
      tapMeta = { ref: n.ref, label: n.text };
    } else {
      tapX = opts.x!;
      tapY = opts.y!;
    }

    const tapTarget = async () => {
      // Do not resnapshot mid-flow (would burn time / lose focus race)
      await this.rpc("tap", [tapX, tapY]);
      this.snapshot = null;
      return { x: tapX, y: tapY, ...tapMeta };
    };

    const waitFirstResponder = async (): Promise<unknown> => {
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
            return last;
          }
        } catch {
          /* keep polling */
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return last;
    };

    const tryType = async () => {
      try {
        const frida = await this.rpc("inputText", [text, perCharDelayMs]);
        return { ok: true as const, frida };
      } catch (e) {
        return {
          ok: false as const,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    };

    await this.humanPause(80, 200);
    const tap1 = await tapTarget();
    const fr1 = await waitFirstResponder();
    await this.humanPause(200, 400);

    let type1 = await tryType();
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
          firstResponder: fr1,
          type_text: type1,
          retried: false,
          ok: type1.ok,
        }),
      };
    }

    const tap2 = await tapTarget();
    const fr2 = await waitFirstResponder();
    await this.humanPause(200, 400);
    const type2 = await tryType();
    await this.humanPause(150, 400);
    const snapshot = await this.maybeResnapshot(opts.resnapshot, 350);

    return {
      ...this.actEnvelope(type2, snapshot, {
        action: "SmartTypeTextAction",
        text,
        perCharDelayMs,
        humanized: true,
        tap: tap1,
        firstResponder: fr1,
        type_text_first: type1,
        retry_tap: tap2,
        retry_first_responder: fr2,
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

  async netDump(options: { limit?: number; query?: string } = {}): Promise<unknown> {
    return this.rpc("netDump", [options]);
  }
}

/** Singleton for embedded (stdio single-process) mode. */
export const sessionStore = new SessionStore();

export type { SessionStore };
