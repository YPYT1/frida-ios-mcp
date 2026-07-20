/**
 * Line-delimited JSON request/response between thin MCP and FridaMcpDaemon.
 *
 * → { id, method, params }
 * ← { id, ok: true, result } | { id, ok: false, error }
 */

export type DaemonRequest = {
  id: string;
  method: string;
  params?: Record<string, unknown>;
};

export type DaemonResponse = {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

export const DEFAULT_DAEMON_HOST = "127.0.0.1";
export const DEFAULT_DAEMON_PORT = 18765;

export function daemonEndpoint(): { host: string; port: number } {
  const raw = process.env.FRIDA_MCP_DAEMON;
  // "1" / "true" / "daemon" → default host:port
  if (!raw || raw === "1" || raw === "true" || raw === "daemon") {
    const port = Number(process.env.FRIDA_MCP_PORT || DEFAULT_DAEMON_PORT);
    return { host: DEFAULT_DAEMON_HOST, port };
  }
  if (raw.includes(":")) {
    const [host, p] = raw.split(":");
    return { host: host || DEFAULT_DAEMON_HOST, port: Number(p) || DEFAULT_DAEMON_PORT };
  }
  return { host: DEFAULT_DAEMON_HOST, port: Number(raw) || DEFAULT_DAEMON_PORT };
}

export function useDaemonMode(): boolean {
  const mode = (process.env.FRIDA_MCP_MODE || "").toLowerCase();
  if (mode === "daemon") return true;
  if (mode === "embedded" || mode === "local") return false;
  // FRIDA_MCP_DAEMON set (including "1") enables daemon mode
  return Boolean(process.env.FRIDA_MCP_DAEMON);
}
