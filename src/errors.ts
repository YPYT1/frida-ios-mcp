/**
 * Structured MCP errors so agents get actionable recovery steps.
 */

export type ErrorCode =
  | "NO_SESSION"
  | "SESSION_DEAD"
  | "SCRIPT_DESTROYED"
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
    "wait { ms: 3000-5000 }  // TikTok: always",
    "screen_snapshot { onScreenOnly: true, limit: 40 }",
    "tap | swipe | smart_type_text  // resnapshot defaults true; SERIAL on app channel",
    "screen_snapshot if resnapshot=false",
  ],
  prefer: {
    type: "smart_type_text when field needs focus; type_text only if already focused",
    read: "screen_snapshot(onScreenOnly=true, limit=40, search=optional)",
    system_alert:
      "sb_alert_trigger (force default false) → sb_alert_list (live+raw counts; raw may > live) → single dismiss post-settle | stacked/unsure: sb_alert_dismiss({all:true}) — do not trust actionViewCount===1 after force; never parallel tap+dismiss → app screen_snapshot",
    dead_session: "session_respawn → wait → screen_snapshot (login may reset)",
    media:
      "photos_import_file({localPath, mediaType:image|video}) → photos_list → photos_clear; pin FRIDA_MCP_PYTHON; Photos may steal foreground briefly",
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
    env: {
      FRIDA_MCP_PYTHON:
        "Absolute path to python.exe that has pymobiledevice3 (preferred over bare 'python' on PATH)",
      cursor_mcp_example:
        'env: { "FRIDA_MCP_PYTHON": "C:\\\\Users\\\\You\\\\AppData\\\\Local\\\\Programs\\\\Python\\\\Python312\\\\python.exe" }',
      windows_cli:
        "set FRIDA_MCP_PYTHON=C:\\Users\\You\\AppData\\Local\\Programs\\Python\\Python312\\python.exe",
    },
    note: "Delete = Recently Deleted (ZTRASHEDSTATE=1). Do not write Photos.sqlite or TCC.db. No auto pip install.",
  },
  typing: {
    steps: [
      "1) On Feed, tap search entry (region text varies: 搜尋 / 搜索 / Search — not 首頁/好友/nav)",
      "2) wait { ms: 1500-2500 }",
      '3) screen_snapshot({ search: "搜尋|搜索|Search|取消|Cancel" }) — pick INPUT box ref, not nav labels',
      "4) smart_type_text({ text: \"hello\", ref }) — retryOnFail default false",
      "5) If NOT_INPUT: switch ref; never retry-tap 有什麼好事/有什麼想法/發佈 chips or nav chrome",
      "6) Optional: first_responder — need canInsertText:true before type_text",
    ],
    note: "Device must be past safety/login walls; real search-box typing needs a live device — no guaranteed path on locked accounts.",
  },
  avoid: [
    "rpc_call / dump_modal / set_text_at_point — DEBUG only (set FRIDA_MCP_ALLOW_DEBUG_TOOLS=1)",
    "parallel app acts (tap+swipe together) — engine serializes but still wasteful",
    "human_type alias — use type_text",
  ],
  defaults: {
    session_mode: "spawn-only on this stack",
    snapshot_onScreenOnly: true,
    snapshot_limit: 40,
    act_resnapshot: true,
    type_perCharDelayMs: 90,
    dual_parallel: true,
    net_dump: "redact + drop data: URLs + fold binary bodies",
  },
  dual: {
    model: "App session (live) + SpringBoard session (sbLive) held together",
    locks: "appLock serializes ALL app acts; sbLock separate — App+SB concurrent OK",
    open: "session_open({ withSpringBoard: true }) or sb_ensure",
    prove: "dual_ping",
    close: "session_close closes both by default; closeSpringBoard:false keeps SB intentionally",
    photos:
      "photosLock side channel (Photos.app) independent of App/SB; photos_* does not destroy TikTok session",
  },
  sessions: {
    mcp_embedded: "Each MCP process has its own sessionStore (not shared with CLI)",
    cli: "CLI is another process — cannot see MCP session unless daemon mode",
    share: "Run daemon; set FRIDA_MCP_MODE=daemon on both MCP and CLI",
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
