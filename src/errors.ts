/**
 * Structured MCP errors so agents get actionable recovery steps.
 */

export type ErrorCode =
  | "NO_SESSION"
  | "SESSION_DEAD"
  | "SCRIPT_DESTROYED"
  | "SESSION_OPEN_TIMEOUT"
  | "SESSION_OPEN_IN_FLIGHT"
  | "APP_LOCK_TIMEOUT"
  | "APP_LOCK_HOLD_TIMEOUT"
  | "APP_LOCK_RESET"
  | "STALE_REF"
  | "NO_FOCUS"
  | "NOT_INPUT"
  | "NOT_TAPPABLE"
  | "OFF_SCREEN"
  | "BLOCKED_RPC"
  | "TIKTOK_SAFE_UI"
  | "INVALID_ARGS"
  | "UNKNOWN";

export class ProbeError extends Error {
  readonly code: ErrorCode;
  readonly recovery: string[];
  readonly ok = false as const;

  constructor(code: ErrorCode, message: string, recovery: string[] = []) {
    super(message);
    this.name = "ProbeError";
    this.code = code;
    this.recovery = recovery;
  }

  toJSON(): {
    ok: false;
    code: ErrorCode;
    error: string;
    recovery: string[];
  } {
    return {
      ok: false as const,
      code: this.code,
      error: this.message,
      recovery: this.recovery,
    };
  }
}

/** Staged media/AFC failures: upload | afc | attach | import | verify */
export class StageError extends Error {
  readonly stage: string;
  readonly recovery: string[];
  readonly needsRetry: boolean;
  readonly detail?: unknown;
  readonly ok = false as const;

  constructor(
    stage: string,
    message: string,
    recovery: string[] = [],
    opts: { needsRetry?: boolean; detail?: unknown } = {},
  ) {
    super(message);
    this.name = "StageError";
    this.stage = stage;
    this.recovery = recovery;
    this.needsRetry = opts.needsRetry === true;
    this.detail = opts.detail;
  }

  toJSON(): Record<string, unknown> {
    return {
      ok: false as const,
      stage: this.stage,
      error: this.message,
      recovery: this.recovery,
      needsRetry: this.needsRetry,
      ...(this.detail !== undefined ? { detail: this.detail } : {}),
    };
  }
}

export function mapError(err: unknown): {
  ok: false;
  code?: ErrorCode;
  stage?: string;
  error: string;
  recovery: string[];
  needsRetry?: boolean;
  detail?: unknown;
} {
  if (err instanceof StageError) {
    const j = err.toJSON();
    return {
      ok: false as const,
      stage: err.stage,
      error: err.message,
      recovery: err.recovery,
      needsRetry: err.needsRetry,
      ...(j.detail !== undefined ? { detail: j.detail } : {}),
    };
  }
  if (err instanceof ProbeError) {
    return err.toJSON();
  }
  const message = err instanceof Error ? err.message : String(err);
  const m = message.toLowerCase();

  if (/no active session|call session_open first/i.test(message)) {
    return {
      ok: false,
      code: "NO_SESSION",
      error: message,
      recovery: ["session_open", "wait(3000-5000)", "screen_snapshot"],
    };
  }
  if (/lock wait timed out|app_lock_timeout/i.test(m)) {
    return {
      ok: false,
      code: "APP_LOCK_TIMEOUT",
      error: message,
      recovery: [
        "session_status",
        "session_force_unlock",
        "retry session_open, or restart MCP process",
      ],
    };
  }
  if (/lock hold timed out|app_lock_hold_timeout/i.test(m)) {
    return {
      ok: false,
      code: "APP_LOCK_HOLD_TIMEOUT",
      error: message,
      recovery: [
        "session_status",
        "session_force_unlock",
        "retry session_open (previous close/spawn may still be running in background)",
        "or restart MCP process",
      ],
    };
  }
  if (/force-reset|app_lock_reset/i.test(m)) {
    return {
      ok: false,
      code: "APP_LOCK_RESET",
      error: message,
      recovery: ["session_status", "session_open"],
    };
  }
  if (/session open timed out|session_open_timeout/i.test(m)) {
    return {
      ok: false,
      code: "SESSION_OPEN_TIMEOUT",
      error: message,
      recovery: [
        "session_force_unlock",
        "kill leftover app on device",
        "retry session_open",
        "or restart MCP process",
      ],
    };
  }
  if (/already running|open in flight|session_open_in_flight|do not stack opens/i.test(m)) {
    return {
      ok: false,
      code: "SESSION_OPEN_IN_FLIGHT",
      error: message,
      recovery: [
        "session_status",
        "wait for current open or session_force_unlock",
        "then retry session_open once",
      ],
    };
  }
  if (/session is dead|script is destroyed|script destroyed|detached/i.test(m)) {
    return {
      ok: false,
      code: "SCRIPT_DESTROYED",
      error: message,
      recovery: [
        "session_respawn",
        "wait(4000)",
        "screen_snapshot",
        "note: spawn kills app — login UI may reset",
      ],
    };
  }
  if (/unknown or expired ref|no snapshot|refs expire|generation/i.test(m)) {
    return {
      ok: false,
      code: "STALE_REF",
      error: message,
      recovery: ["screen_snapshot", "use only refs from the latest generation"],
    };
  }
  if (/no first responder|no_focus|not focused/i.test(m)) {
    return {
      ok: false,
      code: "NO_FOCUS",
      error: message,
      recovery: [
        "smart_type_text with ref or x,y of the input",
        "or tap input then type_text",
      ],
    };
  }
  if (/not_input|not an input|not a text field|composer chrome|chrome\/chip/i.test(m)) {
    return {
      ok: false,
      code: "NOT_INPUT",
      error: message,
      recovery: [
        'screen_snapshot({ search: "搜尋|搜索|Search|留言|评论" })',
        "avoid nav/tabs/chips (首頁/有什麼好事)",
        "first_responder before type_text",
      ],
    };
  }
  if (/not tappable|zero-size/i.test(m)) {
    return {
      ok: false,
      code: "NOT_TAPPABLE",
      error: message,
      recovery: ["pick another ref", "or tap absolute x,y", "screen_snapshot"],
    };
  }
  if (/off-screen/i.test(m)) {
    return {
      ok: false,
      code: "OFF_SCREEN",
      error: message,
      recovery: ["swipe toward target", "screen_snapshot", "tap new ref"],
    };
  }
  if (/rpc_call blocked|not on the whitelist/i.test(m)) {
    return {
      ok: false,
      code: "BLOCKED_RPC",
      error: message,
      recovery: ["use first-class tools", "probe_help"],
    };
  }
  if (/tiktok|safeui blocked|forces screen_snapshot/i.test(m)) {
    return {
      ok: false,
      code: "TIKTOK_SAFE_UI",
      error: message,
      recovery: ["screen_snapshot mode=texts only", "never dump_tree/find_view"],
    };
  }
  if (/required|invalid/i.test(m)) {
    return {
      ok: false,
      code: "INVALID_ARGS",
      error: message,
      recovery: ["probe_help", "check tool parameters"],
    };
  }
  return {
    ok: false,
    code: "UNKNOWN",
    error: message,
    recovery: ["session_status", "probe_help"],
  };
}

export const PROBE_HELP = {
  loop: [
    "session_open { bundleId, withSpringBoard?: true }",
    'TikTok: wait_until_texts({ preset: "tiktok_feed", timeoutMs: 15000 })  // multi-locale; not one language',
    "screen_snapshot { onScreenOnly: true, limit: 40 }  // prefer [input] refs for typing",
    "optional: screen_shot when texts sparse (pixels only — still need snapshot for refs)",
    "tap | swipe | smart_type_text  // resnapshot defaults true; SERIAL on app channel",
    "screen_snapshot if resnapshot=false",
  ],
  prefer: {
    type: "smart_type_text on [input] refs; type_text only if already focused",
    read: "screen_snapshot(onScreenOnly=true, limit=40, search=optional)",
    visual:
      "screen_shot for layout when collectTexts is sparse — lockdown pixels, not Accessibility",
    land: 'wait_until_texts({ preset: "tiktok_feed" }) after TikTok open — never hardcode TW/JP/EN alone',
    stuck:
      "session_status (orphanFridaOpPossible/openInFlight/appLockBusy) → session_force_unlock (kills orphan pid) → ONE session_open",
    system_alert:
      "sb_alert_list → sb_alert_dismiss({all:true}) when unsure — never parallel tap+dismiss → app screen_snapshot",
    dead_session: "session_respawn → wait_until_texts({preset:\"tiktok_feed\"}) / wait → screen_snapshot (login may reset)",
    media:
      "photos_import_file({localPath, mediaType:image|video}) → photos_list → photos_clear; pin FRIDA_MCP_PYTHON; video: avoid parallel session_open other apps",
    system_alert_stack:
      "force stacks layers; list live count can undercount — always sb_alert_dismiss({all:true}) when unsure",
  },
  media: {
    primary: "photos_import_file",
    steps: [
      "0) Pin Python: set FRIDA_MCP_PYTHON to interpreter WITH pymobiledevice3 (MCP does not pip install)",
      "1) photos_import_file({ localPath, mediaType: image|video }) — jpg or small mp4",
      "2) photos_list — optional mediaType / idPrefix filters; confirm localIdentifier",
      "3) session_open TikTok → publish UI (not in this MCP yet)",
      "4) photos_clear — trash untrashed media (Recently Deleted, not permanent wipe)",
    ],
    host: "Photos.app only (com.apple.mobileslideshow). Never import via TikTok agent.",
    afc: "scripts/afc_tool.py; preflight ≤5s → stage=afc if pymobiledevice3 missing",
    video:
      "During video import, avoid parallel session_open of other Apps (Preferences/TikTok); concurrent sessions can delay Photos.sqlite visibility → needsRetry + re-list",
    env: {
      FRIDA_MCP_PYTHON:
        "Absolute path to python.exe that has pymobiledevice3 (preferred over bare 'python' on PATH)",
      cursor_mcp_example:
        'env: { "FRIDA_MCP_PYTHON": "C:\\\\Users\\\\You\\\\AppData\\\\Local\\\\Programs\\\\Python\\\\Python312\\\\python.exe" }',
      windows_cli:
        "set FRIDA_MCP_PYTHON=C:\\Users\\You\\AppData\\Local\\Programs\\Python\\Python312\\python.exe",
      FRIDA_MCP_TOOLS:
        "all (default) | core — core hides net/photos/dual extras from tool list",
    },
    note: "Delete = Recently Deleted (ZTRASHEDSTATE=1). Do not write Photos.sqlite or TCC.db. No auto pip install. needsRetry means re-list — not silent success without asset.",
  },
  typing: {
    steps: [
      "1) On Feed, tap search entry (region text varies: 搜尋 / 搜索 / Search — not 首頁/好友/nav)",
      "2) wait { ms: 1500-2500 }",
      '3) screen_snapshot — only top wide search-bar should be [input]; hot-search chips must NOT be [input]',
      "4) smart_type_text({ text, ref of search-bar }) — AWESearchBar may canInsertText=false but still types",
      "5) If NOT_INPUT: switch ref; never smart_type 好友/熱門搜尋 chips / nav chrome",
      "6) Fallback: tap search bar coords → type_text (innerInsertText)",
    ],
    note: "Device must be past safety/login walls; real search-box typing needs a live device — no guaranteed path on locked accounts.",
  },
  avoid: [
    "rpc_call / dump_modal / set_text_at_point — DEBUG only (set FRIDA_MCP_ALLOW_DEBUG_TOOLS=1)",
    "parallel app acts (tap+swipe together) — engine serializes but still wasteful",
    "human_type alias — use type_text",
    "session_open while orphanFridaOpPossible=true — force_unlock first",
    "using screen_shot refs for tap — pixels have no refs; always screen_snapshot",
    "swipe duration=280 meaning seconds — use durationMs:280 (or duration≤10 as seconds)",
  ],
  defaults: {
    session_mode: "spawn-only on this stack",
    snapshot_onScreenOnly: true,
    snapshot_limit: 40,
    act_resnapshot: true,
    type_perCharDelayMs: 90,
    dual_parallel: true,
    net_dump: "redact + drop data: URLs + fold binary bodies",
    tools_mode: "FRIDA_MCP_TOOLS=all|core",
  },
  dual: {
    model: "App session (live) + SpringBoard session (sbLive) held together",
    locks:
      "appLock serializes ALL app acts; sbLock separate — App+SB concurrent OK. " +
      "session_open holds the lock with holdTimeout (open+close budget, ~70s default) so hung Frida detach/spawn cannot pin the lock forever. " +
      "closeLiveSession soft-times out (FRIDA_MCP_CLOSE_TIMEOUT_MS, default 5s); app close timeout also best-effort kills app pid. " +
      "Hold timeout / SESSION_OPEN_TIMEOUT auto-kills inFlightPid/lastAppPid and sets orphanFridaOpPossible. " +
      "Lock wait: FRIDA_MCP_LOCK_WAIT_MS (default 90s). Spawn: FRIDA_MCP_OPEN_TIMEOUT_MS (default 60s). " +
      "If MCP looks half-dead: session_status → session_force_unlock (kills orphan) → ONE open. " +
      "Cursor cancel does NOT abort server-side Frida.",
    open: "session_open({ withSpringBoard: true }) or sb_ensure",
    prove: "dual_ping",
    close: "session_close closes both by default; closeSpringBoard:false keeps SB intentionally",
    recover:
      "session_force_unlock — resets locks + detach + kill orphan pid; clears orphanFridaOpPossible",
    photos:
      "photosLock side channel (Photos.app) independent of App/SB; photos_* does not destroy TikTok session",
  },
  sessions: {
    mcp_embedded: "Each MCP process has its own sessionStore (not shared with CLI)",
    cli: "CLI is another process — cannot see MCP session unless daemon mode",
    share: "Run daemon; set FRIDA_MCP_MODE=daemon on both MCP and CLI",
    stuck:
      "CLI can open while MCP is stuck because they are different Node processes / different locks",
  },
  search: {
    default: "substring",
    regex: "searchRegex:true or pattern containing | (auto-regex)",
    process_list: "substring only — not regex",
  },
  net: {
    sticky: false,
    quiet:
      "Default drops data: URLs and folds binary bodies; pass includeDataUrls/includeBinaryBodies true to expand",
  },
  hint: "After any UI act, refs from previous generation are invalid.",
};
