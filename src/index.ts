#!/usr/bin/env node
/**
 * Thin stdio MCP entry.
 * - Default: embedded SessionStore in this process (dev-friendly).
 * - FRIDA_MCP_MODE=daemon or FRIDA_MCP_DAEMON=1: forward tools to TCP daemon.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";
import { useDaemonMode, daemonEndpoint } from "./protocol.js";

async function main(): Promise<void> {
  // Keep stdout clean for MCP — log only to stderr
  if (useDaemonMode()) {
    const ep = daemonEndpoint();
    console.error(`[frida-mcp] mode=daemon → ${ep.host}:${ep.port}`);
  } else {
    console.error("[frida-mcp] mode=embedded (in-process session)");
  }

  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("[frida-mcp] fatal:", err);
  process.exit(1);
});
