/**
 * AFC side channel via scripts/afc_tool.py (pymobiledevice3).
 * No fleetcontrol HTTP. Fail loudly + fast if Python/pymobiledevice3 missing.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StageError } from "./errors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Preflight (import pymobiledevice3 only) — must fail within this window */
const PREFLIGHT_MS = 5_000;
/** USB AFC ops (push/list/rm) */
const AFC_OP_MS = 120_000;

export function afcScriptPath(): string {
  // dist/afc.js → ../scripts ; src via tsx → ../scripts
  const candidates = [
    path.resolve(__dirname, "..", "scripts", "afc_tool.py"),
    path.resolve(__dirname, "..", "..", "scripts", "afc_tool.py"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new StageError("afc", `afc_tool.py not found (tried ${candidates.join(", ")})`, [
    "ensure scripts/afc_tool.py exists in frida-mcp repo",
  ]);
}

export type AfcJson = Record<string, unknown> & {
  ok?: boolean;
  stage?: string;
  error?: string;
  recovery?: string[];
};

export function pythonBin(): string {
  return process.env.FRIDA_MCP_PYTHON || process.env.PYTHON || "python";
}

const AFC_RECOVERY = [
  "pip install pymobiledevice3  (into the SAME interpreter MCP uses)",
  "set FRIDA_MCP_PYTHON to that python.exe (do not rely on PATH alone)",
  "Windows example: FRIDA_MCP_PYTHON=C:\\Users\\You\\AppData\\Local\\Programs\\Python\\Python312\\python.exe",
  "Cursor MCP env: { \"FRIDA_MCP_PYTHON\": \"C:\\\\…\\\\python.exe\" }",
  "MCP will NOT auto pip-install",
];

function killChild(child: ChildProcess): void {
  try {
    child.kill();
  } catch {
    /* ignore */
  }
}

function spawnAfc(
  args: string[],
  timeoutMs: number,
): Promise<AfcJson> {
  const script = afcScriptPath();
  const bin = pythonBin();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [script, ...args], {
      windowsHide: true,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killChild(child);
      reject(
        new StageError(
          "afc",
          `afc_tool timed out after ${timeoutMs}ms (bin=${bin}, args=${args[0] ?? ""})`,
          [
            ...AFC_RECOVERY,
            timeoutMs <= PREFLIGHT_MS
              ? "preflight hung — wrong/broken python binary?"
              : "USB/AFC may be stuck — unplug/replug or unlock device",
          ],
        ),
      );
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new StageError(
          "afc",
          `failed to spawn ${bin}: ${err.message}`,
          ["install Python 3", ...AFC_RECOVERY],
        ),
      );
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || "";
      let parsed: AfcJson | null = null;
      try {
        parsed = line ? (JSON.parse(line) as AfcJson) : null;
      } catch {
        /* fall through */
      }
      if (parsed && parsed.ok === false) {
        reject(
          new StageError(
            String(parsed.stage || "afc"),
            String(parsed.error || "AFC tool failed"),
            Array.isArray(parsed.recovery) && parsed.recovery.length
              ? (parsed.recovery as string[])
              : AFC_RECOVERY,
            { detail: parsed },
          ),
        );
        return;
      }
      if (code !== 0 || !parsed) {
        reject(
          new StageError(
            "afc",
            `afc_tool exit=${code}: ${stderr.trim() || stdout.trim() || "no output"} (bin=${bin})`,
            AFC_RECOVERY,
            { detail: { stdout, stderr, code, bin } },
          ),
        );
        return;
      }
      resolve(parsed);
    });
  });
}

/** Cached preflight: only re-run after hard failure or process restart */
let preflightCache: { bin: string; ok: true } | null = null;

/**
 * Verify python + pymobiledevice3 within PREFLIGHT_MS (default 5s).
 * Does not touch USB. MCP never auto pip-installs.
 */
export async function afcPreflight(): Promise<AfcJson> {
  const bin = pythonBin();
  if (preflightCache && preflightCache.bin === bin) {
    return { ok: true, preflight: true, cached: true, python: bin };
  }
  try {
    const r = await spawnAfc(["preflight"], PREFLIGHT_MS);
    preflightCache = { bin, ok: true };
    return r;
  } catch (e) {
    preflightCache = null;
    throw e;
  }
}

/** @internal test helper — clear preflight cache */
export function resetAfcPreflightCache(): void {
  preflightCache = null;
}

export async function runAfcTool(
  args: string[],
  timeoutMs = AFC_OP_MS,
): Promise<AfcJson> {
  // Always preflight first so missing pymobiledevice3 fails in ≤5s, not 120s
  if (args[0] !== "preflight") {
    await afcPreflight();
  }
  return spawnAfc(args, timeoutMs);
}

export async function afcPush(opts: {
  udid: string;
  localPath: string;
  mediaType: "image" | "video";
}): Promise<{
  remotePath: string;
  devicePath: string;
  sizeBytes: number;
  mediaType: string;
  localPath: string;
  udid: string;
}> {
  const r = await runAfcTool([
    "push",
    "--udid",
    opts.udid,
    "--local",
    opts.localPath,
    "--media-type",
    opts.mediaType,
  ]);
  return {
    remotePath: String(r.remotePath),
    devicePath: String(r.devicePath),
    sizeBytes: Number(r.sizeBytes ?? 0),
    mediaType: String(r.mediaType),
    localPath: String(r.localPath),
    udid: String(r.udid ?? opts.udid),
  };
}

export type PhotosListAsset = {
  localIdentifier: string;
  filename?: string | null;
  mediaType?: string;
  uuid?: string;
  directory?: string | null;
  pk?: number;
};

export async function afcListUntrashed(udid: string): Promise<{
  count: number;
  assets: PhotosListAsset[];
  udid: string;
}> {
  const r = await runAfcTool(["list-untrashed", "--udid", udid]);
  return {
    count: Number(r.count ?? 0),
    assets: Array.isArray(r.assets) ? (r.assets as PhotosListAsset[]) : [],
    udid: String(r.udid ?? udid),
  };
}

export async function afcRmDcim(udid: string): Promise<{
  deletedCount: number;
  deleted: string[];
}> {
  const r = await runAfcTool(["rm-dcim", "--udid", udid]);
  return {
    deletedCount: Number(r.deletedCount ?? 0),
    deleted: Array.isArray(r.deleted) ? (r.deleted as string[]) : [],
  };
}
