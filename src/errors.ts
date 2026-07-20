/**
 * Structured MCP errors so agents get actionable recovery steps.
 */

export type ErrorCode =
  | "NO_SESSION"
  | "SESSION_DEAD"
  | "SCRIPT_DESTROYED"
  | "STALE_REF"
  | "NO_FOCUS"
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

export function mapError(err: unknown): {
  ok: false;
  code: ErrorCode;
  error: string;
  recovery: string[];
} {
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
      recovery: ["screen_snapshot", "use new ref from THIS generation only"],
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
    "session_open { bundleId }",
    "wait { ms: 3000-5000 }  // TikTok: always",
    "screen_snapshot { onScreenOnly: true, limit: 40 }",
    "tap | swipe | smart_type_text  // resnapshot defaults true",
    "screen_snapshot if resnapshot=false",
  ],
  prefer: {
    type: "smart_type_text when field needs focus; type_text only if already focused",
    read: "screen_snapshot(onScreenOnly=true, limit=40, search=optional)",
    system_alert:
      "sb_alert_list → sb_alert_tap/dismiss(policy=deny for location) → screen_snapshot",
    dead_session: "session_respawn → wait → screen_snapshot (login may reset)",
  },
  avoid: [
    "rpc_call (debug only)",
    "dump_modal (debug; blocked on TikTok)",
    "set_text_at_point (not humanized; use type_text/smart_type_text)",
    "human_type (alias of type_text — use type_text)",
  ],
  defaults: {
    session_mode: "spawn-only on this stack",
    snapshot_onScreenOnly: true,
    snapshot_limit: 40,
    act_resnapshot: true,
    type_perCharDelayMs: 90,
    dual_parallel: true,
  },
  dual: {
    model: "App session (live) + SpringBoard session (sbLive) held together",
    locks: "Separate appLock / sbLock — App+SB concurrent OK; do NOT parallelize app acts",
    open: "session_open({ withSpringBoard: true }) or sb_ensure / first sb_alert_list",
    prove: "dual_ping",
    close: "session_close closes App+SB by default (no orphan SB)",
    note: "Only App↔SB dual is parallel-safe. Never parallel tap+swipe on the same app session.",
  },
  search: {
    default: "substring",
    regex: "searchRegex:true or pattern containing | (auto-regex)",
    process_list: "substring only — not regex",
  },
  net: {
    sticky: false,
    note: "Each net_enable resets urlFilter to empty unless you pass urlFilter again",
  },
  hint: "After any UI act, refs from previous generation are invalid.",
};
