import net from "node:net";
import { daemonEndpoint, type DaemonRequest, type DaemonResponse } from "./protocol.js";

let seq = 0;

export async function daemonCall(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 120_000,
): Promise<unknown> {
  const { host, port } = daemonEndpoint();
  const id = `r${++seq}_${Date.now()}`;
  const req: DaemonRequest = { id, method, params };

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port }, () => {
      socket.write(`${JSON.stringify(req)}\n`);
    });

    let buf = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new Error(
          `Daemon timeout ${timeoutMs}ms (${host}:${port}). Is FridaMcpDaemon running?`,
        ),
      );
    }, timeoutMs);

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl).trim();
      clearTimeout(timer);
      socket.end();
      try {
        const resp = JSON.parse(line) as DaemonResponse;
        if (!resp.ok) {
          reject(new Error(resp.error || "daemon error"));
        } else {
          resolve(resp.result);
        }
      } catch (e) {
        reject(e);
      }
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Daemon unreachable at ${host}:${port}: ${err.message}. ` +
            `Start with: pnpm start:daemon  or  nssm start FridaMcpDaemon. ` +
            `Or unset FRIDA_MCP_DAEMON / FRIDA_MCP_MODE for embedded mode.`,
        ),
      );
    });
  });
}
