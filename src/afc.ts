/**
 * AFC side channel via scripts/afc_tool.py (pymobiledevice3).
 * No fleetcontrol HTTP. Fail loudly if Python/pymobiledevice3 missing.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StageError } from "./errors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

export type AfcJson = Record<string, unknown> & { ok?: boolean; stage?: string; error?: string };

function pythonBin(): string {
  return process.env.FRIDA_MCP_PYTHON || process.env.PYTHON || "python";
}

export async function runAfcTool(
  args: string[],
  timeoutMs = 120_000,
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
    const timer = setTimeout(() => {
      child.kill();
      reject(
        new StageError("afc", `afc_tool timed out after ${timeoutMs}ms`, [
          "check USB / pymobiledevice3",
          "retry media_upload or photos_list",
        ]),
      );
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new StageError(
          "afc",
          `failed to spawn ${bin}: ${err.message}`,
          [
            "install Python 3",
            "pip install pymobiledevice3",
            "set FRIDA_MCP_PYTHON if python is not on PATH",
          ],
        ),
      );
    });
    child.on("close", (code) => {
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
            Array.isArray(parsed.recovery)
              ? (parsed.recovery as string[])
              : ["pip install pymobiledevice3", "check USB trust", "retry"],
            { detail: parsed },
          ),
        );
        return;
      }
      if (code !== 0 || !parsed) {
        reject(
          new StageError(
            "afc",
            `afc_tool exit=${code}: ${stderr.trim() || stdout.trim() || "no output"}`,
            [
              "pip install pymobiledevice3",
              "python scripts/afc_tool.py push --help",
              "check device USB + trust dialog",
            ],
            { detail: { stdout, stderr, code } },
          ),
        );
        return;
      }
      resolve(parsed);
    });
  });
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

export async function afcListUntrashed(udid: string): Promise<{
  count: number;
  assets: Array<{
    localIdentifier: string;
    filename?: string | null;
    mediaType?: string;
    uuid?: string;
  }>;
  udid: string;
}> {
  const r = await runAfcTool(["list-untrashed", "--udid", udid]);
  return {
    count: Number(r.count ?? 0),
    assets: Array.isArray(r.assets) ? (r.assets as never[]) : [],
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
