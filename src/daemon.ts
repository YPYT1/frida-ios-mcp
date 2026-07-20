#!/usr/bin/env node
/**
 * Frida session daemon — holds long-lived Frida session; line-delimited JSON on TCP.
 * NSSM service name: FridaMcpDaemon
 */
import net from "node:net";
import { handleMethod } from "./backend.js";
import {
  DEFAULT_DAEMON_HOST,
  DEFAULT_DAEMON_PORT,
  type DaemonRequest,
  type DaemonResponse,
} from "./protocol.js";

const host = process.env.FRIDA_MCP_HOST || DEFAULT_DAEMON_HOST;
const port = Number(process.env.FRIDA_MCP_PORT || DEFAULT_DAEMON_PORT);

function respond(socket: net.Socket, resp: DaemonResponse): void {
  socket.write(`${JSON.stringify(resp)}\n`);
}

const server = net.createServer((socket) => {
  let buf = "";
  socket.setEncoding("utf8");
  socket.on("data", async (chunk: string) => {
    buf += chunk;
    while (true) {
      const nl = buf.indexOf("\n");
      if (nl < 0) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let req: DaemonRequest;
      try {
        req = JSON.parse(line) as DaemonRequest;
      } catch (e) {
        respond(socket, {
          id: "?",
          ok: false,
          error: `invalid json: ${e instanceof Error ? e.message : String(e)}`,
        });
        continue;
      }
      try {
        const result = await handleMethod(req.method, req.params ?? {});
        respond(socket, { id: req.id, ok: true, result });
      } catch (e) {
        respond(socket, {
          id: req.id,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  });
});

server.listen(port, host, () => {
  console.error(`[frida-mcp-daemon] listening ${host}:${port}`);
});

server.on("error", (err) => {
  console.error("[frida-mcp-daemon] error:", err);
  process.exit(1);
});

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
