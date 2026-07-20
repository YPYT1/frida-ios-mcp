import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { handleMethod } from "./backend.js";
import { daemonCall } from "./daemon-client.js";
import { useDaemonMode } from "./protocol.js";

async function run(
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ content: { type: "text"; text: string }[] }> {
  if (useDaemonMode()) {
    const result = await daemonCall(method, params);
    // daemon returns same shape
    return result as { content: { type: "text"; text: string }[] };
  }
  return handleMethod(method, params);
}

function toolResult(r: { content: { type: "text"; text: string }[] }) {
  return r;
}

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "frida-ios",
    version: "0.1.0",
  });

  server.tool(
    "device_list",
    "List Frida devices. Default USB-only. Need matching frida-server on phone (17.x with this package).",
    {
      usbOnly: z
        .boolean()
        .optional()
        .describe("Default true: only USB devices. Set false to include local/socket."),
    },
    async ({ usbOnly }) => toolResult(await run("device_list", { usbOnly })),
  );

  server.tool(
    "app_list",
    "Enumerate apps: identifier, name, pid. Default userFacing=true filters noisy Apple services. Use runningOnly for live apps, query for name/id substring.",
    {
      udid: z.string().optional().describe("Device id; default USB"),
      runningOnly: z.boolean().optional().describe("Only apps with pid>0"),
      userFacing: z
        .boolean()
        .optional()
        .describe("Default true: drop idle Apple system services"),
      query: z.string().optional().describe("Filter by identifier or name substring"),
    },
    async ({ udid, runningOnly, userFacing, query }) =>
      toolResult(await run("app_list", { udid, runningOnly, userFacing, query })),
  );

  server.tool(
    "session_open",
    [
      "Open long-lived Frida session (spawn-only on this stack).",
      "ALWAYS uses mode=spawn: kill → spawn suspended → inject agent → resume.",
      "mode=attach is ignored/forced to spawn unless FRIDA_MCP_ALLOW_ATTACH=1 (unreliable: touch/net).",
      "TikTok: after open, wait 3–5s before screen_snapshot. Never dump_tree/find_view.",
      "spawn restarts the process (login UI state may reset).",
      "captureNet=true installs NSURLSession hooks before resume (launch traffic).",
      "withSpringBoard=true attaches SpringBoard in parallel (dual inject; App+SB concurrent RPCs).",
    ].join(" "),
    {
      bundleId: z.string().describe("App bundle id, e.g. com.ss.iphone.ugc.Ame"),
      udid: z.string().optional(),
      mode: z
        .enum(["spawn", "attach"])
        .optional()
        .describe("Ignored: always spawn unless FRIDA_MCP_ALLOW_ATTACH=1"),
      captureNet: z
        .boolean()
        .optional()
        .describe("If true, enable NSURLSession capture before resume (spawn)"),
      withSpringBoard: z
        .boolean()
        .optional()
        .describe("Attach SpringBoard in parallel with app open (dual session)"),
      netOptions: z
        .object({
          maxBody: z.number().optional(),
          captureResponse: z.boolean().optional(),
          urlFilter: z.string().optional(),
        })
        .optional(),
    },
    async ({ bundleId, udid, mode, captureNet, withSpringBoard, netOptions }) =>
      toolResult(
        await run("session_open", {
          bundleId,
          udid,
          mode,
          captureNet,
          withSpringBoard,
          netOptions,
        }),
      ),
  );

  server.tool(
    "dual_ping",
    "Parallel health: app ping + SpringBoard ping at the same time (proves dual inject + concurrent locks).",
    {},
    async () => toolResult(await run("dual_ping")),
  );

  server.tool(
    "sb_ensure",
    "Attach SpringBoard now without listing alerts. Use to warm dual session; then app tools + sb_* can run in parallel.",
    {},
    async () => toolResult(await run("sb_ensure")),
  );

  server.tool(
    "probe_help",
    "Recommended probe loop and which tools to prefer/avoid. Call first in a new session.",
    {},
    async () => toolResult(await run("probe_help")),
  );

  server.tool(
    "session_status",
    "Session health: alive, touchReliable, deadReason, recovery[], loginStateRisk, springboardAlive, snapshotGeneration, appLockBusy/waiters (diagnose stuck open).",
    {},
    async () => toolResult(await run("session_status")),
  );

  server.tool(
    "session_respawn",
    "Force spawn+inject+resume for current bundle. Kills the app process. Prefer only when session is dead.",
    {},
    async () => toolResult(await run("session_respawn")),
  );

  server.tool(
    "session_close",
    "Close app session. Default also closes SpringBoard. closeSpringBoard=false keeps SB intentionally (springboardKept).",
    {
      closeSpringBoard: z
        .boolean()
        .optional()
        .describe("Default true. false = keep SpringBoard for later (intentional, not an error)."),
    },
    async ({ closeSpringBoard }) =>
      toolResult(await run("session_close", { closeSpringBoard })),
  );

  server.tool(
    "session_force_unlock",
    "Emergency: reset stuck appLock/sbLock and best-effort detach sessions. Use when device_list works but session_open/ping hang (Cursor cancel does not abort server Frida). May leave orphanFridaOpPossible.",
    {},
    async () => toolResult(await run("session_force_unlock")),
  );

  server.tool(
    "ping",
    "Agent liveness probe (returns pong). Do not use wrong RPC names as probes.",
    {},
    async () => toolResult(await run("ping")),
  );

  server.tool(
    "screen_window",
    "Key window size: {width,height,x,y,cx,cy,className}. Safe on TikTok.",
    {},
    async () => toolResult(await run("screen_window")),
  );

  server.tool(
    "screen_snapshot",
    [
      "Read screen → generation-scoped refs (g3t8). PRIMARY read tool.",
      "Defaults: onScreenOnly=true, limit=40 (token-safe).",
      "TikTok: texts only (tree blocked). search= substring by default; a|b auto-enables regex.",
      "showDiff=true compares to previous snapshot. Do not parallelize app acts (tap/swipe/type).",
    ].join(" "),
    {
      mode: z.enum(["texts", "tree"]).optional().describe("TikTok forced to texts"),
      onScreenOnly: z
        .boolean()
        .optional()
        .describe("Default true: hide off-screen nodes from output"),
      limit: z.number().optional().describe("Max nodes printed, default 40"),
      search: z
        .string()
        .optional()
        .describe("Substring filter; use searchRegex:true or a|b for regex alternation"),
      searchRegex: z
        .boolean()
        .optional()
        .describe("Force regex (default auto if search contains |)"),
      showDiff: z.boolean().optional().describe("Summarize +/− vs previous snapshot"),
    },
    async (args) => toolResult(await run("screen_snapshot", args)),
  );

  server.tool(
    "screen_search",
    "Filter last snapshot. query default SUBSTRING; regex:true or a|b for regex. Does not touch device.",
    {
      query: z.string().describe("Substring unless regex/auto |"),
      regex: z.boolean().optional().describe("Force regex mode"),
    },
    async ({ query, regex }) => toolResult(await run("screen_search", { query, regex })),
  );

  server.tool(
    "process_list",
    "List device processes (pid, name). query is LITERAL substring only (not regex; SpringBoard ok, a|b is wrong).",
    {
      udid: z.string().optional(),
      query: z.string().optional().describe("Case-insensitive substring, NOT regex"),
      limit: z.number().optional().describe("Max rows, default 200"),
    },
    async ({ udid, query, limit }) =>
      toolResult(await run("process_list", { udid, query, limit })),
  );

  server.tool(
    "tap",
    [
      "Tap by ref (gNtM) or x,y. Default resnapshot=true returns new screen_snapshot in result.snapshot.",
      "Set resnapshot=false only when chaining many acts then one snapshot.",
    ].join(" "),
    {
      ref: z.string().optional().describe("e.g. g2t3 from latest snapshot"),
      x: z.number().optional(),
      y: z.number().optional(),
      resnapshot: z
        .boolean()
        .optional()
        .describe("Default true: auto screen_snapshot after tap"),
    },
    async ({ ref, x, y, resnapshot }) =>
      toolResult(await run("tap", { ref, x, y, resnapshot })),
  );

  server.tool(
    "double_tap",
    "Double-tap (like) at ref or x,y. gapMs default 140. resnapshot default true.",
    {
      ref: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      gapMs: z.number().optional().describe("Default 140"),
      resnapshot: z.boolean().optional().describe("Default true"),
    },
    async ({ ref, x, y, gapMs, resnapshot }) =>
      toolResult(await run("double_tap", { ref, x, y, gapMs, resnapshot })),
  );

  server.tool(
    "swipe",
    "Swipe direction or path. resnapshot default true (feed browse: set false then one snapshot).",
    {
      direction: z.enum(["up", "down", "left", "right"]).optional(),
      x0: z.number().optional(),
      y0: z.number().optional(),
      x1: z.number().optional(),
      y1: z.number().optional(),
      duration: z.number().optional(),
      resnapshot: z.boolean().optional().describe("Default true"),
    },
    async (args) => toolResult(await run("swipe", args)),
  );

  server.tool(
    "set_otp",
    "Fill TikTok OTP (TMVerificationCodeInputView / TUXPinField). Pass full code string e.g. 123456.",
    {
      code: z.string().describe("OTP digits"),
      source: z.string().optional().describe("Debug tag, default mcp"),
    },
    async ({ code, source }) => toolResult(await run("set_otp", { code, source })),
  );

  // Debug tools: set FRIDA_MCP_ALLOW_DEBUG_TOOLS=1 to register (reduces AI misuse)
  if (process.env.FRIDA_MCP_ALLOW_DEBUG_TOOLS === "1") {
    server.tool(
      "set_text_at_point",
      "[DEBUG] setText at point — NOT 拟人. Prefer type_text / smart_type_text.",
      {
        text: z.string(),
        ref: z.string().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
      },
      async ({ text, ref, x, y }) =>
        toolResult(await run("set_text_at_point", { text, ref, x, y })),
    );

    server.tool(
      "dump_modal",
      "[DEBUG] dumpModalView. BLOCKED on TikTok. Daily probe: do not use.",
      {},
      async () => toolResult(await run("dump_modal")),
    );

    server.tool(
      "rpc_call",
      "[DEBUG] Whitelisted agent RPC. Prefer first-class tools + probe_help.",
      {
        name: z.string().describe("RPC name e.g. windowFrame"),
        args: z.array(z.unknown()).optional(),
      },
      async ({ name, args }) => toolResult(await run("rpc_call", { name, args })),
    );
  }

  server.tool(
    "sb_alert_list",
    [
      "List SpringBoard alerts. Live actionViewCount + actionViewCountRaw (raw may be higher; live can undercount stacks).",
      "hasAlert if either count path shows UI. After force: do not trust actionViewCount===1 — use sb_alert_dismiss({all:true}).",
      "After dismiss → app screen_snapshot.",
    ].join(" "),
    {},
    async () => toolResult(await run("sb_alert_list")),
  );

  server.tool(
    "sb_alert_trigger",
    [
      "Create a test system alert (SBAlertItemTestRecipe). Default force=false: skip if alert already present (no stack).",
      "force:true stacks another. Next: sb_alert_list → sb_alert_dismiss({all:true}) or sb_alert_tap.",
    ].join(" "),
    {
      force: z
        .boolean()
        .optional()
        .describe("Default false — do not stack if actionViews/alerts already exist"),
    },
    async ({ force }) => toolResult(await run("sb_alert_trigger", { force })),
  );

  server.tool(
    "sb_alert_tap",
    "Tap SpringBoard alert button by title. Then call app screen_snapshot. Do not parallel with dismiss.",
    { title: z.string().describe("Button title to match") },
    async ({ title }) => toolResult(await run("sb_alert_tap", { title })),
  );

  server.tool(
    "sb_alert_dismiss",
    [
      "Dismiss SB alert. Default policy=deny. all=false: one layer after ~300ms settle (trust cleared; empty → cleared:true rounds:0).",
      "Stacked: all=true (loop until clear or maxRounds=5). Returns cleared/remaining/rounds/needsRetry.",
      "If needsRetry or cleared=false after settle → re-list or all:true again. Do not parallel tap+dismiss.",
    ].join(" "),
    {
      policy: z.enum(["deny", "default", "first"]).optional().describe("Default deny"),
      all: z
        .boolean()
        .optional()
        .describe("Default false. true = clear all stacked alerts (idempotent)"),
      maxRounds: z
        .number()
        .optional()
        .describe("Only with all=true; default 5"),
    },
    async ({ policy, all, maxRounds }) =>
      toolResult(await run("sb_alert_dismiss", { policy, all, maxRounds })),
  );

  server.tool(
    "sb_close",
    "Detach SpringBoard Frida session (app session_open stays open).",
    {},
    async () => toolResult(await run("sb_close")),
  );

  server.tool(
    "type_text",
    [
      "拟人逐字 into ALREADY-FOCUSED field (TypeTextAction). Default perCharDelayMs=90 + jitter.",
      "If field not focused → use smart_type_text instead. resnapshot default true.",
    ].join(" "),
    {
      text: z.string().describe("Text to type (CJK/Emoji OK)"),
      perCharDelayMs: z.number().optional().describe("Default 90"),
      resnapshot: z.boolean().optional().describe("Default true"),
    },
    async ({ text, perCharDelayMs, resnapshot }) =>
      toolResult(await run("type_text", { text, perCharDelayMs, resnapshot })),
  );

  server.tool(
    "smart_type_text",
    [
      "PREFERRED typing: tap real input (ref|x,y) → wait canInsertText → 拟人逐字.",
      "Rejects chrome/chips (e.g. 有什麼好事). retryOnFail default false (safer on TikTok).",
      "resnapshot default true. Do not use on nav tabs.",
    ].join(" "),
    {
      text: z.string(),
      ref: z.string().optional().describe("Real text field ref only"),
      x: z.number().optional(),
      y: z.number().optional(),
      perCharDelayMs: z.number().optional().describe("Default 90"),
      waitKeyboardMs: z.number().optional().describe("Default 2000"),
      retryOnFail: z
        .boolean()
        .optional()
        .describe("Default false — avoid kill-session retry storms"),
      resnapshot: z.boolean().optional().describe("Default true"),
    },
    async (args) => toolResult(await run("smart_type_text", args)),
  );

  server.tool(
    "clear_text",
    "Clear current firstResponder text field (setText empty).",
    {},
    async () => toolResult(await run("clear_text")),
  );

  server.tool(
    "human_pause",
    "Random step gap sleep (fleetcontrol human_pause). Not typing delay — use between actions.",
    {
      minMs: z.number().optional().describe("Default 200"),
      maxMs: z.number().optional().describe("Default 500"),
    },
    async ({ minMs, maxMs }) => toolResult(await run("human_pause", { minMs, maxMs })),
  );

  server.tool(
    "first_responder",
    "Current firstResponder info (className/frame/canInsertText). Check focus before type_text.",
    {},
    async () => toolResult(await run("first_responder")),
  );

  server.tool(
    "press_home",
    "Background current app (suspend) so SpringBoard shows. Session may remain attached to previous app.",
    {},
    async () => toolResult(await run("press_home")),
  );

  server.tool(
    "wait",
    "Sleep N milliseconds for app settle (use 3000–5000 after TikTok session_open).",
    { ms: z.number().describe("milliseconds") },
    async ({ ms }) => toolResult(await run("wait", { ms })),
  );

  server.tool(
    "net_enable",
    [
      "Start NSURLSession capture in current app (TLS plaintext after app decrypt).",
      "Each call RESETS opts (urlFilter defaults empty — pass urlFilter every time you need it).",
      "Needs device network for real traffic. Typical: enable → wait/use app → net_dump.",
    ].join(" "),
    {
      maxBody: z.number().optional().describe("Max body preview bytes, default 4096"),
      captureResponse: z
        .boolean()
        .optional()
        .describe("Default false (more stable)"),
      urlFilter: z
        .string()
        .optional()
        .describe("URL regex; omitted/empty = capture all. Not sticky across enables."),
    },
    async ({ maxBody, captureResponse, urlFilter }) =>
      toolResult(await run("net_enable", { maxBody, captureResponse, urlFilter })),
  );

  server.tool(
    "net_disable",
    "Stop recording new network entries (buffer retained until net_clear).",
    {},
    async () => toolResult(await run("net_disable")),
  );

  server.tool(
    "net_clear",
    "Clear captured network buffer.",
    {},
    async () => toolResult(await run("net_clear")),
  );

  server.tool(
    "net_status",
    "Network capture status: enabled, hooksInstalled, count, options.",
    {},
    async () => toolResult(await run("net_status")),
  );

  server.tool(
    "net_dump",
    [
      "Quiet HTTP dump. rawCount=buffer; returned(=count)=entries after filter; droppedDataUrls/foldedBinaryBodies/deduped=stats.",
      "Default: redact, DROP data: URLs, FOLD binary, dedupe method+url (keep first; dedupe:false for retry/replay debug). summaryOnly=host counts.",
    ].join(" "),
    {
      limit: z.number().optional().describe("Max entries, default 50"),
      query: z.string().optional().describe("Filter substring on url/method/status"),
      redact: z
        .boolean()
        .optional()
        .describe("Default true. false = raw secrets (never for issues/PRs)"),
      summaryOnly: z.boolean().optional().describe("Host aggregation only"),
      includeDataUrls: z
        .boolean()
        .optional()
        .describe("Default false — drop data:image base64 URLs"),
      includeBinaryBodies: z
        .boolean()
        .optional()
        .describe("Default false — fold octet-stream / binary previews"),
      dedupe: z
        .boolean()
        .optional()
        .describe("Default true — keep first entry per method+url"),
    },
    async (args) => toolResult(await run("net_dump", args)),
  );

  // --- Photos album import/clear (side channel; requires Python + pymobiledevice3) ---
  server.tool(
    "photos_ensure",
    "Spawn+resume Photos.app (com.apple.mobileslideshow), settle ~4s, inject photos agent. Does not close TikTok/app session. May steal foreground briefly.",
    {
      udid: z.string().optional(),
      settleMs: z.number().optional().describe("Default 4000"),
    },
    async (args) => toolResult(await run("photos_ensure", args)),
  );

  server.tool(
    "media_upload",
    "AFC upload PC file to /DCIM/100APPLE/{IMG|VID}_XXXX.ext. Needs Python + pymobiledevice3. stage=upload on failure.",
    {
      udid: z.string().optional(),
      localPath: z.string().describe("Absolute path on this PC"),
      mediaType: z.enum(["image", "video"]),
    },
    async (args) => toolResult(await run("media_upload", args)),
  );

  server.tool(
    "photos_import",
    "PhotoKit import already-on-device file (devicePath or remotePath under /DCIM). Host=Photos.app only. Returns localIdentifier.",
    {
      udid: z.string().optional(),
      devicePath: z.string().optional().describe("/var/mobile/Media/DCIM/..."),
      remotePath: z.string().optional().describe("/DCIM/100APPLE/..."),
      mediaType: z.enum(["image", "video"]),
      terminateAfter: z
        .boolean()
        .optional()
        .describe("Default true — kill Photos after import (sqlite friendly)"),
    },
    async (args) => toolResult(await run("photos_import", args)),
  );

  server.tool(
    "photos_import_file",
    [
      "One-shot: AFC upload + Photos ensure + PhotoKit import + optional sqlite verify. Preferred for AI.",
      "Needs FRIDA_MCP_PYTHON with pymobiledevice3 (no auto pip). Missing deps → stage=afc in ≤5s.",
      "Accepts image or small mp4 (mediaType=video). Video: avoid parallel session_open other apps or expect needsRetry + photos_list.",
    ].join(" "),
    {
      udid: z.string().optional(),
      localPath: z.string().describe("PC file path"),
      mediaType: z.enum(["image", "video"]),
      verify: z
        .boolean()
        .optional()
        .describe("Default true — confirm localIdentifier in Photos.sqlite"),
    },
    async (args) => toolResult(await run("photos_import_file", args)),
  );

  server.tool(
    "photos_list",
    [
      "Pull Photos.sqlite via AFC; list untrashed assets (not Recently Deleted).",
      "Optional mediaType=image|video and idPrefix/localIdentifier filter. Default = all untrashed.",
      "Needs FRIDA_MCP_PYTHON with pymobiledevice3 (fast-fail stage=afc if missing).",
    ].join(" "),
    {
      udid: z.string().optional(),
      mediaType: z.enum(["image", "video"]).optional(),
      idPrefix: z
        .string()
        .optional()
        .describe("Match uuid or localIdentifier prefix/substring"),
      localIdentifier: z.string().optional().describe("Same as idPrefix match"),
    },
    async (args) => toolResult(await run("photos_list", args)),
  );

  server.tool(
    "photos_clear",
    "PhotoKit trash all untrashed image/video (Recently Deleted), verify count=0, optional DCIM source cleanup. needsRetry if leftover.",
    {
      udid: z.string().optional(),
      clearDcim: z
        .boolean()
        .optional()
        .describe("Default true — also rm AFC upload sources under /DCIM/100APPLE"),
    },
    async (args) => toolResult(await run("photos_clear", args)),
  );

  return server;
}
