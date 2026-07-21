/**
 * Tool surface tiers — reduce AI misuse of ~40 tools.
 *
 * Default FRIDA_MCP_TOOLS=all → core + advanced + debug (debug annotated `[debug]`).
 * FRIDA_MCP_TOOLS=core → hide advanced + debug.
 * Opt out of debug only: FRIDA_MCP_ALLOW_DEBUG_TOOLS=0 (even when mode=all).
 * Legacy: FRIDA_MCP_ALLOW_DEBUG_TOOLS=1 is no longer required for default `all`.
 */

export type ToolTier = "core" | "advanced" | "debug";

/** Daily probe loop (session → land → read → act → SB dismiss). */
export const CORE_TOOLS = [
  "probe_help",
  "device_list",
  "app_list",
  "session_open",
  "session_status",
  "session_close",
  "session_force_unlock",
  "session_respawn",
  "ping",
  "wait",
  "wait_until_texts",
  "screen_window",
  "screen_snapshot",
  "screen_search",
  "screen_shot",
  "tap",
  "double_tap",
  "swipe",
  "press_home",
  "type_text",
  "smart_type_text",
  "clear_text",
  "first_responder",
  "set_otp",
  "human_pause",
  "tiktok_open_search",
  "sb_alert_list",
  "sb_alert_dismiss",
  "sb_close",
] as const;

/** Net / Photos / dual extras — register unless FRIDA_MCP_TOOLS=core. */
export const ADVANCED_TOOLS = [
  "process_list",
  "dual_ping",
  "sb_ensure",
  "sb_alert_trigger",
  "sb_alert_tap",
  "net_enable",
  "net_disable",
  "net_clear",
  "net_status",
  "net_dump",
  "photos_ensure",
  "media_upload",
  "photos_import",
  "photos_import_file",
  "photos_list",
  "photos_clear",
] as const;

export const DEBUG_TOOLS = [
  "set_text_at_point",
  "dump_modal",
  "rpc_call",
] as const;

const CORE_SET = new Set<string>(CORE_TOOLS);
const ADVANCED_SET = new Set<string>(ADVANCED_TOOLS);
const DEBUG_SET = new Set<string>(DEBUG_TOOLS);

export function toolTier(name: string): ToolTier {
  if (DEBUG_SET.has(name)) return "debug";
  if (ADVANCED_SET.has(name)) return "advanced";
  return "core";
}

/** FRIDA_MCP_TOOLS=core | all (default all). */
export function toolsMode(): "core" | "all" {
  const v = (process.env.FRIDA_MCP_TOOLS || "all").trim().toLowerCase();
  return v === "core" ? "core" : "all";
}

/** Debug tools on by default in `all`; set FRIDA_MCP_ALLOW_DEBUG_TOOLS=0 to hide. */
export function debugToolsAllowed(): boolean {
  const v = (process.env.FRIDA_MCP_ALLOW_DEBUG_TOOLS || "").trim();
  if (v === "0" || v.toLowerCase() === "false" || v.toLowerCase() === "off") {
    return false;
  }
  // Legacy: explicit 1 still means on; empty/`all` mode → on
  return true;
}

export function shouldRegisterTool(name: string): boolean {
  const tier = toolTier(name);
  if (tier === "debug") {
    if (toolsMode() === "core") return false;
    return debugToolsAllowed();
  }
  if (toolsMode() === "core") {
    return CORE_SET.has(name);
  }
  return true;
}

export function annotateToolDesc(name: string, description: string): string {
  const tier = toolTier(name);
  if (tier === "advanced") return `[advanced] ${description}`;
  if (tier === "debug") return `[debug] ${description}`;
  return description;
}

export const TOOL_TIERS_HELP = {
  mode: "FRIDA_MCP_TOOLS=all (default) | core",
  core: [...CORE_TOOLS],
  advanced: [...ADVANCED_TOOLS],
  debug: [...DEBUG_TOOLS],
  note:
    "Default `all` registers debug tools (`rpc_call` / `dump_modal` / `set_text_at_point`) with a [debug] prefix. " +
    "Set FRIDA_MCP_TOOLS=core to hide advanced+debug. Set FRIDA_MCP_ALLOW_DEBUG_TOOLS=0 to hide debug only. " +
    "screen_shot = lockdown pixel assist (not Accessibility); screen_snapshot remains primary for refs.",
};
