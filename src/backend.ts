/**
 * Unified method handlers used by both embedded MCP and TCP daemon.
 */
import { listApps, listDevices, listProcesses } from "./frida/device.js";
import { mapError, PROBE_HELP } from "./errors.js";
import {
  mediaUpload,
  photosChannel,
  photosClear,
  photosImportFile,
  photosList,
} from "./photos.js";
import { takeScreenshot } from "./screenshot.js";
import { sessionStore } from "./session.js";
import { TOOL_TIERS_HELP, toolsMode } from "./tool-tiers.js";

function textResult(text: string): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text }] };
}

function jsonResult(data: unknown): { content: { type: "text"; text: string }[] } {
  return textResult(typeof data === "string" ? data : JSON.stringify(data, null, 2));
}

function errorResult(err: unknown): {
  content: { type: "text"; text: string }[];
  isError?: boolean;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(mapError(err), null, 2) }],
    isError: true,
  };
}

function boolParam(v: unknown, defaultVal: boolean): boolean {
  if (v === undefined || v === null) return defaultVal;
  return Boolean(v);
}

export async function handleMethod(
  method: string,
  params: Record<string, unknown> = {},
): Promise<{
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
}> {
  try {
    switch (method) {
      case "device_list": {
        const all = await listDevices();
        const usbOnly = params.usbOnly !== false; // default true
        const usb = all.filter(
          (d) => d.type.toLowerCase() === "usb",
        );
        const devices = usbOnly && usb.length > 0 ? usb : all;
        return jsonResult({
          devices,
          allCount: all.length,
          note:
            usb.length === 0
              ? "No USB device found. Check cable + frida-server 17.x."
              : "USB frida-server. Match frida npm major (17.x).",
        });
      }
      case "app_list": {
        const runningOnly = Boolean(params.runningOnly);
        // Default userFacing=true cuts ~150 system services to a usable list.
        const userFacing = params.userFacing === false ? false : true;
        const query =
          typeof params.query === "string" && params.query.length > 0
            ? params.query
            : undefined;
        const list = await listApps({
          udid: params.udid as string | undefined,
          runningOnly,
          userFacing,
          query,
        });
        return jsonResult({
          count: list.length,
          apps: list,
          filters: { runningOnly, userFacing, query: query ?? null },
          ...(query && query.includes("|")
            ? {
                warn: "app_list query is substring only (not regex). Use query:\"TikTok\" or query:\"Ame\", not a|b.",
              }
            : {}),
        });
      }
      case "process_list": {
        const list = await listProcesses({
          udid: params.udid as string | undefined,
          query: typeof params.query === "string" ? params.query : undefined,
          limit: params.limit != null ? Number(params.limit) : undefined,
        });
        return jsonResult({
          count: list.length,
          processes: list,
          queryMode: "substring (not regex — do not pass a|b)",
        });
      }
      case "session_open": {
        const bundleId = String(params.bundleId ?? "");
        if (!bundleId) throw new Error("bundleId is required");
        const mode = params.mode as "spawn" | "attach" | undefined;
        const netOptions =
          params.netOptions && typeof params.netOptions === "object"
            ? (params.netOptions as {
                maxBody?: number;
                captureResponse?: boolean;
                urlFilter?: string;
              })
            : undefined;
        const r = await sessionStore.open({
          udid: params.udid as string | undefined,
          bundleId,
          mode,
          captureNet: Boolean(params.captureNet),
          netOptions,
          withSpringBoard: Boolean(params.withSpringBoard),
        });
        return jsonResult(r);
      }
      case "dual_ping": {
        const r = await sessionStore.dualPing();
        return jsonResult(r);
      }
      case "sb_ensure": {
        const r = await sessionStore.sbEnsure();
        return jsonResult(r);
      }
      case "session_status":
        return jsonResult(sessionStore.status());
      case "session_respawn": {
        const r = await sessionStore.respawn();
        return jsonResult(r);
      }
      case "session_close": {
        const closeSpringBoard = params.closeSpringBoard !== false;
        const closePhotos = params.closePhotos !== false;
        const r = await sessionStore.close({ closeSpringBoard, closePhotos });
        return jsonResult({
          open: false,
          message: closeSpringBoard
            ? "app + SpringBoard sessions closed"
            : "app session closed; SpringBoard kept intentionally",
          ...r,
          status: sessionStore.status(),
        });
      }
      case "session_force_unlock": {
        const r = await sessionStore.forceUnlock();
        return jsonResult(r);
      }
      case "sb_alert_trigger": {
        const r = await sessionStore.sbAlertTrigger({
          force: Boolean(params.force),
        });
        return jsonResult(r);
      }
      case "ping": {
        const pong = await sessionStore.ping();
        return textResult(pong);
      }
      case "screen_window": {
        const wf = await sessionStore.windowFrame();
        return jsonResult(wf);
      }
      case "probe_help": {
        return jsonResult({
          ...PROBE_HELP,
          tools: { ...TOOL_TIERS_HELP, activeMode: toolsMode() },
        });
      }
      case "screen_shot": {
        const shot = await takeScreenshot({
          udid: typeof params.udid === "string" ? params.udid : undefined,
          quality:
            params.quality != null ? Number(params.quality) : undefined,
        });
        // MCP image content for Cursor preview + compact JSON meta
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ok: true,
                  mimeType: shot.mimeType,
                  bytes: shot.bytes,
                  note: shot.note,
                  next: "Use for visual context only — tap/type still needs screen_snapshot refs",
                },
                null,
                2,
              ),
            },
            {
              type: "image" as const,
              data: shot.base64,
              mimeType: shot.mimeType,
            },
          ],
        };
      }
      case "screen_snapshot": {
        const mode = params.mode as "texts" | "tree" | undefined;
        const searchRegexRaw = params.searchRegex ?? params.regex;
        const { text } = await sessionStore.screenSnapshot({
          mode,
          onScreenOnly: boolParam(params.onScreenOnly, true),
          limit: params.limit != null ? Number(params.limit) : 40,
          search: typeof params.search === "string" ? params.search : undefined,
          // undefined = allow auto-regex on "|"; only pass true/false when caller set it
          searchRegex:
            searchRegexRaw === undefined || searchRegexRaw === null
              ? undefined
              : Boolean(searchRegexRaw),
          showDiff: Boolean(params.showDiff),
        });
        return textResult(text);
      }
      case "screen_search": {
        const query = String(params.query ?? "");
        if (!query) throw new Error("query is required");
        // Align with snapshot search: auto-regex when query contains |
        let useRegex = Boolean(params.regex);
        let autoRegex = false;
        if (params.regex === undefined && query.includes("|")) {
          useRegex = true;
          autoRegex = true;
        }
        const searched = sessionStore.screenSearch(query, useRegex);
        return jsonResult({
          count: searched.nodes.length,
          nodes: searched.nodes,
          best: searched.nodes[0] ?? null,
          refsValid: searched.refsValid,
          snapshotGeneration: searched.snapshotGeneration,
          searchMode: useRegex ? (autoRegex ? "regex(auto|)" : "regex") : "substring",
          hint: "Default is substring. Use regex:true or a|b for alternation. Prefer screen_snapshot({ search }). Do not search mid-swipe — wait for act or resnapshot.",
        });
      }
      case "tap": {
        const r = await sessionStore.tap({
          ref: params.ref as string | undefined,
          x: params.x != null ? Number(params.x) : undefined,
          y: params.y != null ? Number(params.y) : undefined,
          resnapshot: boolParam(params.resnapshot, true),
        });
        return jsonResult(r);
      }
      case "tiktok_open_search": {
        const r = await sessionStore.openTikTokSearch({
          maxTries:
            params.maxTries != null ? Number(params.maxTries) : undefined,
        });
        return jsonResult(r);
      }
      case "double_tap": {
        const r = await sessionStore.doubleTap({
          ref: params.ref as string | undefined,
          x: params.x != null ? Number(params.x) : undefined,
          y: params.y != null ? Number(params.y) : undefined,
          gapMs: params.gapMs != null ? Number(params.gapMs) : undefined,
          resnapshot: boolParam(params.resnapshot, true),
        });
        return jsonResult(r);
      }
      case "set_otp": {
        const code = String(params.code ?? params.text ?? "");
        const r = await sessionStore.setOtp({
          code,
          source: typeof params.source === "string" ? params.source : undefined,
        });
        return jsonResult({ action: "setOtpCode", result: r });
      }
      case "set_text_at_point": {
        const r = await sessionStore.setTextAtPoint({
          text: String(params.text ?? ""),
          ref: params.ref as string | undefined,
          x: params.x != null ? Number(params.x) : undefined,
          y: params.y != null ? Number(params.y) : undefined,
        });
        return jsonResult({
          action: "setTextAtPoint",
          result: r,
          debug: true,
          hint: "[DEBUG] Prefer type_text / smart_type_text for 拟人输入.",
        });
      }
      case "dump_modal": {
        const r = await sessionStore.dumpModal();
        return jsonResult({
          action: "dumpModalView",
          result: r,
          debug: true,
          hint: "[DEBUG] Blocked on TikTok. Daily probe: avoid.",
        });
      }
      case "rpc_call": {
        const name = String(params.name ?? params.rpc ?? "");
        if (!name) throw new Error("name is required");
        let args: unknown[] = [];
        if (Array.isArray(params.args)) args = params.args;
        else if (params.arg !== undefined) args = [params.arg];
        const r = await sessionStore.rpcCall(name, args);
        return jsonResult({
          rpc: name,
          result: r,
          debug: true,
          hint: "[DEBUG] Prefer first-class tools. See probe_help.",
        });
      }
      case "sb_alert_list": {
        const r = await sessionStore.sbAlertList();
        return jsonResult(r);
      }
      case "sb_alert_tap": {
        const title = String(params.title ?? "");
        const r = await sessionStore.sbAlertTap(title);
        return jsonResult(r);
      }
      case "sb_alert_dismiss": {
        const policy =
          typeof params.policy === "string" ? params.policy : undefined;
        const all = params.all === true;
        const maxRounds =
          params.maxRounds != null ? Number(params.maxRounds) : undefined;
        const r = await sessionStore.sbAlertDismiss({
          policy,
          all,
          maxRounds: Number.isFinite(maxRounds as number)
            ? (maxRounds as number)
            : undefined,
        });
        return jsonResult(r);
      }
      case "sb_close": {
        await sessionStore.sbClose();
        return jsonResult({ open: false, message: "SpringBoard session closed" });
      }
      case "swipe": {
        const r = await sessionStore.swipe({
          direction: params.direction as "up" | "down" | "left" | "right" | undefined,
          x0: params.x0 != null ? Number(params.x0) : undefined,
          y0: params.y0 != null ? Number(params.y0) : undefined,
          x1: params.x1 != null ? Number(params.x1) : undefined,
          y1: params.y1 != null ? Number(params.y1) : undefined,
          duration: params.duration != null ? Number(params.duration) : undefined,
          durationMs:
            params.durationMs != null ? Number(params.durationMs) : undefined,
          resnapshot: boolParam(params.resnapshot, true),
        });
        return jsonResult(r);
      }
      case "type_text":
      case "human_type": {
        // human_type is alias of type_text (not registered as separate MCP tool)
        const text = String(params.text ?? "");
        if (!text) throw new Error("text is required");
        const r = await sessionStore.typeText({
          text,
          perCharDelayMs:
            params.perCharDelayMs != null
              ? Number(params.perCharDelayMs)
              : params.per_char_delay_ms != null
                ? Number(params.per_char_delay_ms)
                : undefined,
          resnapshot: boolParam(params.resnapshot, true),
        });
        return jsonResult(r);
      }
      case "smart_type_text": {
        const text = String(params.text ?? "");
        if (!text) throw new Error("text is required");
        const r = await sessionStore.smartTypeText({
          text,
          ref: params.ref as string | undefined,
          x: params.x != null ? Number(params.x) : undefined,
          y: params.y != null ? Number(params.y) : undefined,
          perCharDelayMs:
            params.perCharDelayMs != null
              ? Number(params.perCharDelayMs)
              : params.per_char_delay_ms != null
                ? Number(params.per_char_delay_ms)
                : undefined,
          waitKeyboardMs:
            params.waitKeyboardMs != null
              ? Number(params.waitKeyboardMs)
              : params.wait_keyboard_ms != null
                ? Number(params.wait_keyboard_ms)
                : undefined,
          retryOnFail:
            params.retryOnFail != null
              ? Boolean(params.retryOnFail)
              : params.retry_on_fail != null
                ? Boolean(params.retry_on_fail)
                : false,
          resnapshot: boolParam(params.resnapshot, true),
        });
        return jsonResult(r);
      }
      case "clear_text": {
        const r = await sessionStore.clearText();
        return jsonResult({ action: "clearText", result: r });
      }
      case "human_pause": {
        const minMs = params.minMs != null ? Number(params.minMs) : 200;
        const maxMs = params.maxMs != null ? Number(params.maxMs) : 500;
        const r = await sessionStore.humanPause(minMs, maxMs);
        return jsonResult({ action: "human_pause", ...r });
      }
      case "first_responder": {
        const r = await sessionStore.firstResponder();
        return jsonResult({ firstResponder: r });
      }
      case "press_home": {
        const r = await sessionStore.pressHome();
        return jsonResult({ result: r });
      }
      case "net_enable": {
        const r = await sessionStore.netEnable({
          maxBody: params.maxBody != null ? Number(params.maxBody) : undefined,
          captureResponse:
            params.captureResponse != null ? Boolean(params.captureResponse) : undefined,
          urlFilter:
            typeof params.urlFilter === "string" ? params.urlFilter : undefined,
        });
        return jsonResult(r);
      }
      case "net_disable": {
        const r = await sessionStore.netDisable();
        return jsonResult(r);
      }
      case "net_clear": {
        const r = await sessionStore.netClear();
        return jsonResult(r);
      }
      case "net_status": {
        const r = await sessionStore.netStatus();
        return jsonResult(r);
      }
      case "net_dump": {
        const r = await sessionStore.netDump({
          limit: params.limit != null ? Number(params.limit) : undefined,
          query: typeof params.query === "string" ? params.query : undefined,
          redact: params.redact === false ? false : true,
          summaryOnly: Boolean(params.summaryOnly),
          includeDataUrls: Boolean(params.includeDataUrls),
          includeBinaryBodies: Boolean(params.includeBinaryBodies),
          dedupe: params.dedupe === false ? false : true,
        });
        return jsonResult(r);
      }
      case "wait": {
        const ms = Math.max(0, Number(params.ms ?? 1000));
        await new Promise((r) => setTimeout(r, ms));
        return textResult(`waited ${ms}ms`);
      }
      case "wait_until_texts": {
        const pattern =
          typeof params.pattern === "string" ? params.pattern : undefined;
        const preset =
          typeof params.preset === "string" ? params.preset : undefined;
        const r = await sessionStore.waitUntilTexts({
          pattern,
          preset,
          timeoutMs:
            params.timeoutMs != null ? Number(params.timeoutMs) : undefined,
          intervalMs:
            params.intervalMs != null ? Number(params.intervalMs) : undefined,
          searchRegex:
            params.searchRegex != null
              ? Boolean(params.searchRegex)
              : params.regex != null
                ? Boolean(params.regex)
                : undefined,
          onScreenOnly: params.onScreenOnly === false ? false : true,
        });
        return jsonResult(r);
      }
      case "photos_ensure": {
        const r = await photosChannel.ensure({
          udid: typeof params.udid === "string" ? params.udid : undefined,
          settleMs: params.settleMs != null ? Number(params.settleMs) : undefined,
        });
        return jsonResult(r);
      }
      case "photos_close": {
        const r = await photosChannel.close({
          kill: params.kill === false ? false : true,
        });
        return jsonResult(r);
      }
      case "media_upload": {
        const localPath = String(params.localPath ?? "");
        const mediaType = String(params.mediaType ?? "").toLowerCase();
        if (!localPath) throw new Error("localPath is required");
        if (mediaType !== "image" && mediaType !== "video") {
          throw new Error('mediaType must be "image" or "video"');
        }
        const r = await mediaUpload({
          udid: typeof params.udid === "string" ? params.udid : undefined,
          localPath,
          mediaType,
        });
        return jsonResult(r);
      }
      case "photos_import": {
        const mediaType = String(params.mediaType ?? "").toLowerCase();
        if (mediaType !== "image" && mediaType !== "video") {
          throw new Error('mediaType must be "image" or "video"');
        }
        let devicePath =
          typeof params.devicePath === "string" ? params.devicePath : "";
        if (!devicePath && typeof params.remotePath === "string") {
          const rp = params.remotePath;
          devicePath = rp.startsWith("/var/mobile/Media")
            ? rp
            : `/var/mobile/Media${rp.startsWith("/") ? "" : "/"}${rp}`;
        }
        if (!devicePath) throw new Error("devicePath or remotePath is required");
        const r = await photosChannel.importDevicePath({
          devicePath,
          mediaType,
          udid: typeof params.udid === "string" ? params.udid : undefined,
          terminateAfter: params.terminateAfter === false ? false : true,
        });
        return jsonResult(r);
      }
      case "photos_import_file": {
        const localPath = String(params.localPath ?? "");
        const mediaType = String(params.mediaType ?? "").toLowerCase();
        if (!localPath) throw new Error("localPath is required");
        if (mediaType !== "image" && mediaType !== "video") {
          throw new Error('mediaType must be "image" or "video"');
        }
        const r = await photosImportFile({
          udid: typeof params.udid === "string" ? params.udid : undefined,
          localPath,
          mediaType,
          verify: params.verify === false ? false : true,
        });
        return jsonResult(r);
      }
      case "photos_list": {
        const mediaType = String(params.mediaType ?? "").toLowerCase();
        const r = await photosList({
          udid: typeof params.udid === "string" ? params.udid : undefined,
          mediaType:
            mediaType === "image" || mediaType === "video" ? mediaType : undefined,
          idPrefix: typeof params.idPrefix === "string" ? params.idPrefix : undefined,
          localIdentifier:
            typeof params.localIdentifier === "string"
              ? params.localIdentifier
              : undefined,
        });
        return jsonResult(r);
      }
      case "photos_clear": {
        const r = await photosClear({
          udid: typeof params.udid === "string" ? params.udid : undefined,
          clearDcim: params.clearDcim === false ? false : true,
        });
        return jsonResult(r);
      }
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  } catch (e) {
    return errorResult(e);
  }
}
