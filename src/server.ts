import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { handleMethod } from "./backend.js";
import { daemonCall } from "./daemon-client.js";
import { useDaemonMode } from "./protocol.js";
import {
  annotateToolDesc,
  shouldRegisterTool,
  toolsMode,
} from "./tool-tiers.js";

async function run(
  method: string,
  params: Record<string, unknown> = {},
): Promise<{
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
}> {
  if (useDaemonMode()) {
    const result = await daemonCall(method, params);
    // daemon returns same shape
    return result as {
      content: Array<
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string }
      >;
      isError?: boolean;
    };
  }
  return handleMethod(method, params);
}

function toolResult(r: {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
}) {
  return r;
}

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "frida-ios",
    version: "0.1.0",
  });

  // Tiered registration: FRIDA_MCP_TOOLS=core hides advanced+debug; debug on by default in all
  const reg = ((
    name: string,
    description: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...rest: any[]
  ) => {
    if (!shouldRegisterTool(name)) return server;
    return (server.tool as (...a: unknown[]) => unknown)(
      name,
      annotateToolDesc(name, description),
      ...rest,
    );
  }) as typeof server.tool;

  console.error(
    `[frida-mcp] tools mode=${toolsMode()} (FRIDA_MCP_TOOLS=core hides advanced+debug; ALLOW_DEBUG_TOOLS=0 hides debug only)`,
  );

  reg(
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

  reg(
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

  reg(
    "session_open",
    [
      "Open long-lived Frida session (spawn-only on this stack).",
      "ALWAYS uses mode=spawn: kill → spawn suspended → inject agent → resume.",
      "mode=attach is ignored/forced to spawn unless FRIDA_MCP_ALLOW_ATTACH=1 (unreliable: touch/net).",
      "TikTok: after open, wait 3–5s before screen_snapshot. Never dump_tree/find_view.",
      "spawn restarts the process (login UI state may reset).",
      "captureNet=true installs NSURLSession + TTNet hooks before resume (launch traffic).",
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
        .describe("If true, enable NSURLSession+TTNet capture before resume (spawn)"),
      withSpringBoard: z
        .boolean()
        .optional()
        .describe("Attach SpringBoard in parallel with app open (dual session)"),
      netOptions: z
        .object({
          maxBody: z.number().optional(),
          captureResponse: z.boolean().optional(),
          urlFilter: z.string().optional(),
          captureMode: z
            .enum(["nsurl", "ttnet", "all"])
            .optional()
            .describe("nsurl | ttnet | all (default all)"),
          signTrace: z
            .boolean()
            .optional()
            .describe("Backtrace on MetaSec sign_header writes"),
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

  reg(
    "dual_ping",
    "Parallel health: app ping + SpringBoard ping at the same time (proves dual inject + concurrent locks).",
    {},
    async () => toolResult(await run("dual_ping")),
  );

  reg(
    "sb_ensure",
    "Attach SpringBoard now without listing alerts. Use to warm dual session; then app tools + sb_* can run in parallel.",
    {},
    async () => toolResult(await run("sb_ensure")),
  );

  reg(
    "probe_help",
    "Recommended probe loop and which tools to prefer/avoid. Call first in a new session.",
    {},
    async () => toolResult(await run("probe_help")),
  );

  reg(
    "session_status",
    "Session health: alive, refsValid/hasSnapshot, lastSnapshotGeneration, openInFlight, appLockBusy/waiters, recovery[].",
    {},
    async () => toolResult(await run("session_status")),
  );

  reg(
    "session_respawn",
    "Force spawn+inject+resume for current bundle. Kills the app process. Prefer only when session is dead.",
    {},
    async () => toolResult(await run("session_respawn")),
  );

  reg(
    "session_close",
    "Close app session. Default also closes SpringBoard and clears Photos side channel (photosAlive). closeSpringBoard=false keeps SB; closePhotos=false keeps Photos.",
    {
      closeSpringBoard: z
        .boolean()
        .optional()
        .describe("Default true. false = keep SpringBoard for later (intentional, not an error)."),
      closePhotos: z
        .boolean()
        .optional()
        .describe("Default true. false = leave Photos.app channel alive."),
    },
    async ({ closeSpringBoard, closePhotos }) =>
      toolResult(await run("session_close", { closeSpringBoard, closePhotos })),
  );

  reg(
    "session_force_unlock",
    "Emergency: reset stuck locks, detach sessions, kill in-flight/last app pid. Use when orphanFridaOpPossible or open hangs. Then ONE session_open.",
    {},
    async () => toolResult(await run("session_force_unlock")),
  );

  reg(
    "ping",
    "Agent liveness probe (returns pong). Do not use wrong RPC names as probes.",
    {},
    async () => toolResult(await run("ping")),
  );

  reg(
    "screen_window",
    "Key window size: {width,height,x,y,cx,cy,className}. Safe on TikTok.",
    {},
    async () => toolResult(await run("screen_window")),
  );

  reg(
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

  reg(
    "screen_search",
    "Filter last snapshot. query default SUBSTRING; regex:true or a|b for regex. Does not touch device.",
    {
      query: z.string().describe("Substring unless regex/auto |"),
      regex: z.boolean().optional().describe("Force regex mode"),
    },
    async ({ query, regex }) => toolResult(await run("screen_search", { query, regex })),
  );

  reg(
    "screen_shot",
    [
      "Pixel screenshot via lockdown ScreenshotService (pymobiledevice3) — NOT Accessibility, not Frida UI dump.",
      "Use when texts are sparse / visual layout unclear. Still prefer screen_snapshot for tap refs.",
      "Needs FRIDA_MCP_PYTHON + pymobiledevice3 (+ optional Pillow for JPEG). Returns image + meta.",
    ].join(" "),
    {
      udid: z.string().optional(),
      quality: z
        .number()
        .optional()
        .describe("JPEG quality 1-95 when Pillow available, default 70"),
    },
    async ({ udid, quality }) => toolResult(await run("screen_shot", { udid, quality })),
  );

  reg(
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

  reg(
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

  reg(
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

  reg(
    "swipe",
    [
      "Swipe direction or path. Prefer durationMs (e.g. 280). Agent uses seconds;",
      "duration>10 is treated as ms (avoids 280→280s lock traps). Clamped ~0.15–2.5s.",
      "resnapshot default true (feed browse: set false then one snapshot).",
    ].join(" "),
    {
      direction: z.enum(["up", "down", "left", "right"]).optional(),
      x0: z.number().optional(),
      y0: z.number().optional(),
      x1: z.number().optional(),
      y1: z.number().optional(),
      durationMs: z
        .number()
        .optional()
        .describe("Preferred: milliseconds, e.g. 280 → ~0.28s"),
      duration: z
        .number()
        .optional()
        .describe("Seconds if ≤10; values >10 treated as ms. Prefer durationMs."),
      resnapshot: z.boolean().optional().describe("Default true"),
    },
    async (args) => toolResult(await run("swipe", args)),
  );

  reg(
    "set_otp",
    "Fill TikTok OTP (TMVerificationCodeInputView / TUXPinField). Pass full code string e.g. 123456.",
    {
      code: z.string().describe("OTP digits"),
      source: z.string().optional().describe("Debug tag, default mcp"),
    },
    async ({ code, source }) => toolResult(await run("set_otp", { code, source })),
  );

  reg(
    "tiktok_open_search",
    "From For You feed, open TikTok search landing by tapping the top-right magnifier (retries a few points). Not the narrow 搜尋 submit button. Then smart_type on wide [input], then tap 搜尋 to submit.",
    {
      maxTries: z
        .number()
        .optional()
        .describe("Max magnifier tap attempts (default all candidates)"),
    },
    async ({ maxTries }) =>
      toolResult(await run("tiktok_open_search", { maxTries })),
  );

  // Debug tools: on by default when FRIDA_MCP_TOOLS=all; hide with ALLOW_DEBUG_TOOLS=0 or TOOLS=core
  reg(
    "set_text_at_point",
    "setText at point — NOT 拟人. Prefer type_text / smart_type_text. Prefer first-class tools for daily probes.",
    {
      text: z.string(),
      ref: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
    },
    async ({ text, ref, x, y }) =>
      toolResult(await run("set_text_at_point", { text, ref, x, y })),
  );

  reg(
    "dump_modal",
    "dumpModalView. BLOCKED on TikTok. Daily probe: do not use.",
    {},
    async () => toolResult(await run("dump_modal")),
  );

  reg(
    "rpc_call",
    "Whitelisted agent RPC. Prefer first-class tools + probe_help.",
    {
      name: z.string().describe("RPC name e.g. windowFrame"),
      args: z.array(z.unknown()).optional(),
    },
    async ({ name, args }) => toolResult(await run("rpc_call", { name, args })),
  );

  reg(
    "sb_alert_list",
    [
      "List SpringBoard alerts. Live actionViewCount + actionViewCountRaw (raw may be higher; live can undercount stacks).",
      "hasAlert if either count path shows UI. After force: do not trust actionViewCount===1 — use sb_alert_dismiss({all:true}).",
      "After dismiss → app screen_snapshot.",
    ].join(" "),
    {},
    async () => toolResult(await run("sb_alert_list")),
  );

  reg(
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

  reg(
    "sb_alert_tap",
    "Tap SpringBoard alert button by title. Then call app screen_snapshot. Do not parallel with dismiss.",
    { title: z.string().describe("Button title to match") },
    async ({ title }) => toolResult(await run("sb_alert_tap", { title })),
  );

  reg(
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

  reg(
    "sb_close",
    "Detach SpringBoard Frida session (app session_open stays open).",
    {},
    async () => toolResult(await run("sb_close")),
  );

  reg(
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

  reg(
    "smart_type_text",
    [
      "PREFERRED typing: tap real input (ref|x,y) → wait typable FR → 拟人逐字.",
      "Rejects chrome/chips (好友/有什麼好事). TikTok AWESearchBar may canInsertText=false but still types.",
      "Prefer wide search-bar [input]; avoid hot-search chips. retryOnFail default false. resnapshot default true.",
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

  reg(
    "clear_text",
    "Clear current firstResponder text field (setText empty).",
    {},
    async () => toolResult(await run("clear_text")),
  );

  reg(
    "human_pause",
    "Random step gap sleep (fleetcontrol human_pause). Not typing delay — use between actions.",
    {
      minMs: z.number().optional().describe("Default 200"),
      maxMs: z.number().optional().describe("Default 500"),
    },
    async ({ minMs, maxMs }) => toolResult(await run("human_pause", { minMs, maxMs })),
  );

  reg(
    "first_responder",
    "Current firstResponder info (className/frame/canInsertText). Check focus before type_text.",
    {},
    async () => toolResult(await run("first_responder")),
  );

  reg(
    "press_home",
    "Background current app (suspend) so SpringBoard shows. Session may remain attached to previous app.",
    {},
    async () => toolResult(await run("press_home")),
  );

  reg(
    "wait",
    "Sleep N milliseconds. Prefer wait_until_texts after TikTok session_open instead of blind wait.",
    { ms: z.number().describe("milliseconds") },
    async ({ ms }) => toolResult(await run("wait", { ms })),
  );

  reg(
    "wait_until_texts",
    [
      "Poll screen_snapshot until on-screen text matches pattern or preset (or timeout).",
      'TikTok: prefer preset "tiktok_feed" (EN/ZH-Hant/ZH-Hans/JA/KO) — do not hardcode one language.',
      "Custom pattern still allowed for page-specific probes.",
    ].join(" "),
    {
      pattern: z
        .string()
        .optional()
        .describe('Custom text; "|" auto-regex. Prefer preset for TikTok land.'),
      preset: z
        .string()
        .optional()
        .describe('Built-in multi-locale set, e.g. "tiktok_feed"'),
      timeoutMs: z.number().optional().describe("Default 15000"),
      intervalMs: z.number().optional().describe("Poll interval, default 800"),
      searchRegex: z
        .boolean()
        .optional()
        .describe("Force regex; default auto when pattern contains |"),
      onScreenOnly: z.boolean().optional().describe("Default true"),
    },
    async ({ pattern, preset, timeoutMs, intervalMs, searchRegex, onScreenOnly }) =>
      toolResult(
        await run("wait_until_texts", {
          pattern,
          preset,
          timeoutMs,
          intervalMs,
          searchRegex,
          onScreenOnly,
        }),
      ),
  );

  reg(
    "net_enable",
    [
      "Start in-process HTTP capture. captureMode: nsurl | ttnet | all (default all).",
      "ttnet hooks TikTok TTHttpTaskChromium AFTER request filters (api.tiktokv.com + headers/sign fields).",
      "signTrace:true attaches module+offset backtrace on sign_header writes (MetaSec RE).",
      "captureResponse wraps TTNet onReadResponseData+setIsCompleted (stable). NSURLSession wrap skipped when TTHttpTaskChromium present.",
      "Each call RESETS opts. Typical RE: session_open({captureNet:true, netOptions:{signTrace:true}}) → use app → net_dump / tiktok_sign.",
    ].join(" "),
    {
      maxBody: z.number().optional().describe("Max body preview bytes, default 4096"),
      captureResponse: z
        .boolean()
        .optional()
        .describe(
          "Capture response bodies. TTNet: onReadResponseData+setIsCompleted. Default false.",
        ),
      urlFilter: z
        .string()
        .optional()
        .describe("URL regex; omitted/empty = capture all. Not sticky across enables."),
      captureMode: z
        .enum(["nsurl", "ttnet", "all"])
        .optional()
        .describe("nsurl | ttnet | all (default all)"),
      signTrace: z
        .boolean()
        .optional()
        .describe("Attach compact backtrace on MetaSec sign_header writes"),
    },
    async ({ maxBody, captureResponse, urlFilter, captureMode, signTrace }) =>
      toolResult(
        await run("net_enable", {
          maxBody,
          captureResponse,
          urlFilter,
          captureMode,
          signTrace,
        }),
      ),
  );

  reg(
    "net_disable",
    "Stop recording new network entries (buffer retained until net_clear).",
    {},
    async () => toolResult(await run("net_disable")),
  );

  reg(
    "net_clear",
    "Clear captured network buffer.",
    {},
    async () => toolResult(await run("net_clear")),
  );

  reg(
    "net_status",
    "Network capture status: enabled, hooksInstalled, count, options.",
    {},
    async () => toolResult(await run("net_status")),
  );

  reg(
    "net_dump",
    [
      "Quiet HTTP dump. Entries may include stack=nsurl|ttnet, signHeaders, query, backtrace (if signTrace).",
      "rawCount=buffer; returned(=count)=entries after filter. Default: redact, DROP data: URLs, FOLD binary, dedupe method+url.",
      "RE tip: redact:false dedupe:false query:\"tiktokv\" or query:\"sign_header\". Add Phone: query:\"phone|bind|mobile|passport|verify\".",
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

  reg(
    "tiktok_im",
    [
      "In-process TikTok IM. action: status | conversations | send_text | phone_status.",
      "send_text defaults dryRun:true (constructs message+conversation only). Pass dryRun:false to really send.",
      "conversationId from conversations or net_dump query:imapi|inbox. phone_status = AWEUserModel bind flags vs Add Phone popup.",
    ].join(" "),
    {
      action: z
        .enum(["status", "conversations", "send_text", "phone_status"])
        .describe("IM action"),
      conversationId: z.string().optional().describe("Required for send_text"),
      text: z.string().optional().describe("Message text for send_text"),
      dryRun: z
        .boolean()
        .optional()
        .describe("Default true — do not call sendMessage unless false"),
      limit: z.number().optional().describe("conversations limit, default 20"),
    },
    async (args) => toolResult(await run("tiktok_im", args)),
  );

  reg(
    "tiktok_posts",
    [
      "List current user's posts via in-process TTNet (App MetaSec signs). Returns awemeId/desc/createTime/stats.",
      "Override url/userId if path differs; calibrate with net_dump query:aweme/post.",
    ].join(" "),
    {
      count: z.number().optional().describe("Page size, default 12"),
      cursor: z.string().optional().describe("max_cursor, default 0"),
      userId: z.string().optional().describe("Override user_id if auto-detect fails"),
      url: z
        .string()
        .optional()
        .describe("Override endpoint (default api.tiktokv.com/aweme/v1/aweme/post/)"),
    },
    async (args) => toolResult(await run("tiktok_posts", args)),
  );

  reg(
    "tiktok_sign",
    [
      "MetaSec sign observability (NOT offline Argus recompute). action: last | enable_trace.",
      "last → recent sign_header / signHeaders entries (x-security-argus, x-Tt-Token, …).",
      "enable_trace → net_enable({signTrace:true, captureMode:ttnet}). Prefer session_open captureNet+signTrace.",
    ].join(" "),
    {
      action: z
        .enum(["last", "enable_trace"])
        .optional()
        .describe("Default last"),
      limit: z.number().optional().describe("For action=last, default 20"),
    },
    async (args) => toolResult(await run("tiktok_sign", args)),
  );

  // --- Photos album import/clear (side channel; requires Python + pymobiledevice3) ---
  reg(
    "photos_ensure",
    "Spawn+resume Photos.app (com.apple.mobileslideshow), settle ~4s, inject photos agent. Does not close TikTok/app session. May steal foreground briefly.",
    {
      udid: z.string().optional(),
      settleMs: z.number().optional().describe("Default 4000"),
    },
    async (args) => toolResult(await run("photos_ensure", args)),
  );

  reg(
    "media_upload",
    "AFC upload PC file to /DCIM/100APPLE/{IMG|VID}_XXXX.ext. Needs Python + pymobiledevice3. stage=upload on failure.",
    {
      udid: z.string().optional(),
      localPath: z.string().describe("Absolute path on this PC"),
      mediaType: z.enum(["image", "video"]),
    },
    async (args) => toolResult(await run("media_upload", args)),
  );

  reg(
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

  reg(
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

  reg(
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

  reg(
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
