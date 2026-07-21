/** TikTok safe-UI gates. Dangerous RPCs use Accessibility / UIButton title APIs. */

const TIKTOK_BUNDLE_HINTS = [
  "com.ss.iphone",
  "com.zhiliaoapp.musically",
  "ugc.ame",
  ".ame",
];

/** RPCs forbidden on TikTok (MCP must refuse even if agent exports them). */
export const TIKTOK_BLOCKED_RPCS = new Set([
  "dumpTree",
  "dump_tree",
  "findView",
  "find_view",
  "findViews",
  "find_views",
  "findButtons",
  "find_buttons",
  "dumpLoginGate",
  "dump_login_gate",
  "dumpModalView",
  "dump_modal_view",
  "dumpAllViewStates",
  "dump_all_view_states",
]);

export function isTikTokBundle(bundleId: string): boolean {
  const id = bundleId.toLowerCase();
  return TIKTOK_BUNDLE_HINTS.some((h) => id.includes(h.toLowerCase()));
}

export function assertSafeRpc(bundleId: string, rpcName: string): void {
  if (!isTikTokBundle(bundleId)) return;
  if (TIKTOK_BLOCKED_RPCS.has(rpcName)) {
    throw new Error(
      `TikTok safeUi blocked RPC "${rpcName}". ` +
        `Use collectTexts / collectTextsWithFrames + windowFrame only. ` +
        `Do not call dump_tree / find_view / find_buttons / dump_login_gate.`,
    );
  }
}

export function snapshotModeFor(bundleId: string, requested?: "texts" | "tree"): "texts" | "tree" {
  if (isTikTokBundle(bundleId)) {
    if (requested === "tree") {
      throw new Error(
        "TikTok forces screen_snapshot mode=texts. tree/dump is blocked (anti-debug).",
      );
    }
    return "texts";
  }
  return requested ?? "texts";
}

export const TIKTOK_WAIT_HINT =
  "After session_open on TikTok, wait 3–5s before screen_snapshot. " +
  "Do not read UI immediately after spawn. Refs expire after UI changes — re-snapshot before tap.";

/**
 * This fleet (RootHide / TikTok / many jailbreak stacks) only supports reliable
 * Frida inject via spawn+suspend+inject+resume. Running attach is broken or
 * leaves _touchesEvent null.
 *
 * Escape hatch: FRIDA_MCP_ALLOW_ATTACH=1
 */
export function attachAllowed(): boolean {
  return process.env.FRIDA_MCP_ALLOW_ATTACH === "1";
}

export const SPAWN_ONLY_HINT =
  "This environment is spawn-only: session_open always uses mode=spawn " +
  "(kill → spawn suspended → inject → resume). attach is disabled unless " +
  "FRIDA_MCP_ALLOW_ATTACH=1. Touch + net hooks require spawn.";

/**
 * Whitelist for mcp rpc_call — only safe/common agent exports.
 * TikTok still goes through assertSafeRpc for blocked dump/find*.
 */
export const RPC_CALL_WHITELIST = new Set([
  "ping",
  "windowFrame",
  "window_frame",
  "collectTexts",
  "collect_texts",
  "collectTextsWithFrames",
  "collect_texts_with_frames",
  "tap",
  "swipe",
  "swipePath",
  "swipe_path",
  "doubleTap",
  "double_tap",
  "inputText",
  "input_text",
  "firstResponderInfo",
  "first_responder_info",
  "clearText",
  "clear_text",
  "pressHome",
  "press_home",
  "setOtpCode",
  "set_otp_code",
  "setTextAtPoint",
  "set_text_at_point",
  "netEnable",
  "net_enable",
  "netDisable",
  "net_disable",
  "netClear",
  "net_clear",
  "netDump",
  "net_dump",
  "netStatus",
  "net_status",
  "signLast",
  "sign_last",
  "ttnetStatus",
  "ttnet_status",
  "ttnetRequest",
  "ttnet_request",
  "imStatus",
  "im_status",
  "imListConversations",
  "im_list_conversations",
  "imInboxMessages",
  "im_inbox_messages",
  "imSendText",
  "im_send_text",
  "imListMessages",
  "im_list_messages",
  "imOpenChat",
  "im_open_chat",
  "imOpenChatByPeerUid",
  "im_open_chat_by_peer_uid",
  "imConversationIdForPeer",
  "im_conversation_id_for_peer",
  "userPhoneBindStatus",
  "user_phone_bind_status",
  "postsListSelf",
  "posts_list_self",
  "dumpModalView",
  "dump_modal_view",
  "sbAlertList",
  "sb_alert_list",
  "sbAlertTap",
  "sb_alert_tap",
  "sbAlertDismiss",
  "sb_alert_dismiss",
  "sbAlertTrigger",
  "sb_alert_trigger",
]);

export function assertWhitelistedRpc(name: string): void {
  if (!RPC_CALL_WHITELIST.has(name)) {
    throw new Error(
      `rpc_call blocked: "${name}" is not on the whitelist. ` +
        `Allowed examples: ping, windowFrame, doubleTap, setOtpCode, setTextAtPoint, dumpModalView (non-TikTok).`,
    );
  }
}

