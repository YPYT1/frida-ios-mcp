#!/usr/bin/env node
/**
 * Thin CLI over the same handleMethod backend as MCP.
 * Usage:
 *   node cli/frida-ios.mjs help
 *   node cli/frida-ios.mjs call probe_help
 *   node cli/frida-ios.mjs call session_open --bundleId com.ss.iphone.ugc.Ame --withSpringBoard
 *   node cli/frida-ios.mjs call screen_snapshot --limit 20
 *   node cli/frida-ios.mjs call net_dump --summaryOnly
 *
 * Secrets: net_dump redacts by default. Never commit raw dumps.
 */
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const backendUrl = pathToFileURL(path.join(root, "dist", "backend.js")).href;

const { handleMethod } = await import(backendUrl);

function print(obj) {
  const text =
    typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  process.stdout.write(text.endsWith("\n") ? text : text + "\n");
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") continue;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function coerce(v) {
  if (v === true || v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (typeof v === "string" && (v.startsWith("{") || v.startsWith("["))) {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

function toParams(parsed) {
  const params = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (k === "_") continue;
    // camelCase flags: --withSpringBoard, --summaryOnly, --resnapshot false
    params[k] = coerce(v);
  }
  return params;
}

const SESSION_BANNER = `
=== Sessions (read first) ===
1) CLI ≠ MCP: this process has its OWN session (Cursor cannot see it).
2) Share one Frida session → run daemon + FRIDA_MCP_MODE=daemon on both sides.
3) Without daemon: open/close here only affects this CLI.
=============================
`.trim();

const SESSION_HINT = SESSION_BANNER;

const HELP = `
frida-ios CLI (same handleMethod as MCP; separate process session by default)

  help                         Show this help
  call <method> [flags]        Invoke any backend method
  probe                        probe_help
  open --bundleId <id> [--withSpringBoard] [--captureNet]
  status | dual-ping | close
  snap [--limit N] [--search S] [--showDiff]
  tap --ref g1t1 | --x N --y N
  swipe --direction up
  net-dump [--summaryOnly] [--redact false]
  sb-list | sb-ensure | sb-trigger | sb-close

Examples:
  node cli/frida-ios.mjs open --bundleId com.ss.iphone.ugc.Ame --withSpringBoard
  node cli/frida-ios.mjs call wait --ms 4000
  node cli/frida-ios.mjs snap --limit 20 --search 個人
  node cli/frida-ios.mjs call net_dump --summaryOnly
  node cli/frida-ios.mjs close

${SESSION_HINT}

Notes:
  - net_dump: redact + drop data: URLs + fold binary by default.
  - App acts are serialized in-process; App+SB dual parallel is OK.
  - Requires: pnpm build  (uses dist/backend.js)
`.trim();

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "-h" || argv[0] === "--help") {
    print(HELP);
    return;
  }

  const cmd = argv[0];
  const rest = parseArgs(argv.slice(1));

  /** @type {string} */
  let method;
  /** @type {Record<string, unknown>} */
  let params = toParams(rest);

  switch (cmd) {
    case "call": {
      method = rest._[0];
      if (!method) {
        print("usage: call <method> [--flags]");
        process.exit(2);
      }
      // drop positional method name from _
      params = toParams(parseArgs(argv.slice(2)));
      // first remaining positional after method is unused
      const p2 = parseArgs(argv.slice(2));
      method = p2._[0] || method;
      params = toParams(p2);
      delete params._;
      // remove method name if it leaked as flag-less
      break;
    }
    case "probe":
      method = "probe_help";
      params = {};
      break;
    case "open":
      method = "session_open";
      if (!params.bundleId && rest._[0]) params.bundleId = rest._[0];
      break;
    case "status":
      method = "session_status";
      params = {};
      {
        const result = await handleMethod(method, params);
        const text = result.content?.[0]?.text ?? JSON.stringify(result);
        try {
          const j = JSON.parse(text);
          if (!j.open && !j.alive) {
            // Banner FIRST so first-time users see it before JSON
            print(SESSION_BANNER + "\n");
          }
        } catch {
          /* ignore */
        }
        print(text);
        if (result.isError) process.exitCode = 1;
        return;
      }
    case "dual-ping":
    case "dual_ping":
      method = "dual_ping";
      params = {};
      break;
    case "close":
      method = "session_close";
      break;
    case "snap":
    case "snapshot":
      method = "screen_snapshot";
      break;
    case "tap":
      method = "tap";
      break;
    case "swipe":
      method = "swipe";
      break;
    case "net-dump":
    case "net_dump":
      method = "net_dump";
      break;
    case "sb-list":
    case "sb_alert_list":
      method = "sb_alert_list";
      params = {};
      break;
    case "sb-ensure":
      method = "sb_ensure";
      params = {};
      break;
    case "sb-trigger":
    case "sb_alert_trigger":
      method = "sb_alert_trigger";
      params = {};
      break;
    case "sb-close":
      method = "sb_close";
      params = {};
      break;
    default:
      // treat as method name: frida-ios session_open --bundleId ...
      method = cmd;
      params = toParams(rest);
      break;
  }

  // Clean positional array
  if ("_" in params) delete params._;

  // Map common CLI aliases
  if (params.bundle && !params.bundleId) params.bundleId = params.bundle;
  if (params.ms != null && method === "wait") params.ms = Number(params.ms);

  const result = await handleMethod(method, params);
  const text = result.content?.[0]?.text ?? JSON.stringify(result);
  print(text);
  if (result.isError) process.exitCode = 1;
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: String(e.message || e) }, null, 2));
  process.exit(1);
});
