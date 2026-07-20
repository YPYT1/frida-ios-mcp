import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import frida from "frida";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Repo root (parent of dist/ or src/). */
export function repoRoot(): string {
  // dist/frida/agent.js → ../../ ; src/frida/agent.ts via tsx → ../../
  return path.resolve(__dirname, "..", "..");
}

export function resolveAgentEntry(): string {
  const fromEnv = process.env.FRIDA_AGENT_ENTRY;
  if (fromEnv && fs.existsSync(fromEnv)) return path.resolve(fromEnv);
  const local = path.join(repoRoot(), "agent", "agent_main.js");
  if (fs.existsSync(local)) return local;
  throw new Error(
    `Agent entry not found. Set FRIDA_AGENT_ENTRY or place agent at ${local}`,
  );
}

/**
 * Compile agent_main.js + relative imports via frida.Compiler.
 * projectRoot must contain node_modules/frida-objc-bridge.
 */
export async function compileAgent(entryPath?: string): Promise<string> {
  const entry = entryPath ?? resolveAgentEntry();
  const root = repoRoot();
  const rel = path.relative(root, entry).split(path.sep).join("/");
  if (rel.startsWith("..")) {
    throw new Error(`Agent entry must be under repo root ${root}: got ${entry}`);
  }
  const compiler = new frida.Compiler();
  // Types mark build() as BuildOptions (empty); runtime accepts CompilerOptions.projectRoot.
  const source = await compiler.build(rel, {
    projectRoot: root,
  } as unknown as frida.BuildOptions);
  return source;
}

export async function waitForReady(
  script: frida.Script,
  timeoutMs = 5000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`frida agent did not signal ready within ${timeoutMs}ms`));
    }, timeoutMs);

    const onMessage = (message: frida.Message, _data: Buffer | null) => {
      if (message.type === "send") {
        const payload = message.payload as { type?: string } | undefined;
        if (payload && payload.type === "ready") {
          clearTimeout(timer);
          script.message.disconnect(onMessage);
          resolve();
        }
      }
    };
    script.message.connect(onMessage);
  });
}
