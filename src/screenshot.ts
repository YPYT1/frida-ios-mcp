/**
 * Device screenshot via scripts/screenshot_tool.py (pymobiledevice3 ScreenshotService).
 * Lockdown pixels — not Accessibility, not Frida drawViewHierarchy.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StageError } from "./errors.js";
import { pythonBin } from "./afc.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PREFLIGHT_MS = 5_000;
const TAKE_MS = 45_000;

export function screenshotScriptPath(): string {
  const candidates = [
    path.resolve(__dirname, "..", "scripts", "screenshot_tool.py"),
    path.resolve(__dirname, "..", "..", "scripts", "screenshot_tool.py"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new StageError(
    "screenshot",
    `screenshot_tool.py not found (tried ${candidates.join(", ")})`,
    ["ensure scripts/screenshot_tool.py exists in frida-mcp repo"],
  );
}

const SHOT_RECOVERY = [
  "pip install pymobiledevice3  (into the SAME interpreter MCP uses)",
  "set FRIDA_MCP_PYTHON to that python.exe",
  "optional: pip install Pillow for JPEG compress",
  "unlock device; mount developer image if ScreenshotService fails",
];

function killChild(child: ChildProcess): void {
  try {
    child.kill();
  } catch {
    /* ignore */
  }
}

type ShotJson = Record<string, unknown> & {
  ok?: boolean;
  stage?: string;
  error?: string;
  recovery?: string[];
  base64?: string;
  mimeType?: string;
  bytes?: number;
};

function spawnShot(args: string[], timeoutMs: number): Promise<ShotJson> {
  const script = screenshotScriptPath();
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
          "screenshot",
          `screenshot_tool timed out after ${timeoutMs}ms (bin=${bin})`,
          SHOT_RECOVERY,
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
          "screenshot",
          `failed to spawn ${bin}: ${err.message}`,
          ["install Python 3", ...SHOT_RECOVERY],
        ),
      );
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || "";
      let parsed: ShotJson | null = null;
      try {
        parsed = line ? (JSON.parse(line) as ShotJson) : null;
      } catch {
        /* fall through */
      }
      if (parsed && parsed.ok === false) {
        reject(
          new StageError(
            String(parsed.stage || "screenshot"),
            String(parsed.error || "screenshot failed"),
            Array.isArray(parsed.recovery) && parsed.recovery.length
              ? (parsed.recovery as string[])
              : SHOT_RECOVERY,
            { detail: parsed },
          ),
        );
        return;
      }
      if (code !== 0 || !parsed) {
        reject(
          new StageError(
            "screenshot",
            `screenshot_tool exit=${code}: ${stderr.trim() || stdout.trim() || "no output"} (bin=${bin})`,
            SHOT_RECOVERY,
            { detail: { stdout, stderr, code, bin } },
          ),
        );
        return;
      }
      resolve(parsed);
    });
  });
}

let preflightCache: { bin: string; ok: true } | null = null;

export async function screenshotPreflight(): Promise<ShotJson> {
  const bin = pythonBin();
  if (preflightCache && preflightCache.bin === bin) {
    return { ok: true, preflight: true, cached: true, python: bin };
  }
  const r = await spawnShot(["preflight"], PREFLIGHT_MS);
  preflightCache = { bin, ok: true };
  return r;
}

export async function takeScreenshot(opts: {
  udid?: string;
  quality?: number;
}): Promise<{
  ok: true;
  mimeType: string;
  bytes: number;
  base64: string;
  note?: string;
}> {
  await screenshotPreflight();
  const args = ["take"];
  if (opts.udid) args.push("--udid", opts.udid);
  if (opts.quality != null) args.push("--quality", String(opts.quality));
  const r = await spawnShot(args, TAKE_MS);
  if (!r.base64 || !r.mimeType) {
    throw new StageError("screenshot", "screenshot response missing base64/mimeType", SHOT_RECOVERY);
  }
  return {
    ok: true,
    mimeType: String(r.mimeType),
    bytes: Number(r.bytes ?? 0),
    base64: String(r.base64),
    note: typeof r.note === "string" ? r.note : undefined,
  };
}
