/**
 * Tool surface tiers — reduce AI misuse of ~40 tools.
 *
 * Default: register ALL (backward compatible).
 * FRIDA_MCP_TOOLS=core → only core + probe_help (net/photos/debug extras hidden).
 * FRIDA_MCP_ALLOW_DEBUG_TOOLS=1 → still required for rpc_call / dump_modal / set_text_at_point.
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

export function shouldRegisterTool(name: string): boolean {
  const tier = toolTier(name);
  if (tier === "debug") {
    return process.env.FRIDA_MCP_ALLOW_DEBUG_TOOLS === "1";
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
    "Set FRIDA_MCP_TOOLS=core to hide net/photos/dual extras from the MCP tool list. " +
    "Debug tools still need FRIDA_MCP_ALLOW_DEBUG_TOOLS=1. " +
    "screen_shot = lockdown pixel assist (not Accessibility); screen_snapshot remains primary for refs.",
};
