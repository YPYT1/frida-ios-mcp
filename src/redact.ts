/**
 * Redact secrets from net_dump / tool output for open-source safety.
 * Never log real tokens from devices into repo samples.
 */

const SENSITIVE_HEADER =
  /^(authorization|cookie|set-cookie|proxy-authorization|x-.*auth.*|x-.*token.*|.*token.*|.*secret.*|.*api[-_]?key.*|.*session.*|.*csrf.*)$/i;

const SENSITIVE_QUERY =
  /(access_token|refresh_token|id_token|token|auth|password|passwd|secret|api_key|apikey|session|sig|sign|signature|jwt)/i;

function redactValue(v: string): string {
  if (!v) return v;
  if (v.length <= 8) return "[REDACTED]";
  return `${v.slice(0, 4)}…[REDACTED len=${v.length}]`;
}

function redactHeaders(
  headers: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  if (!headers || typeof headers !== "object") return headers ?? undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (SENSITIVE_HEADER.test(k)) {
      out[k] = typeof v === "string" ? redactValue(v) : "[REDACTED]";
    } else {
      out[k] = v;
    }
  }
  return out;
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (SENSITIVE_QUERY.test(key)) {
        u.searchParams.set(key, "[REDACTED]");
      }
    }
    return u.toString();
  } catch {
    return url;
  }
}

function redactBody(
  body: unknown,
): unknown {
  if (!body || typeof body !== "object") return body;
  const b = body as Record<string, unknown>;
  // Don't dump huge secrets in previews; keep structure
  if (typeof b.preview === "string") {
    const p = b.preview as string;
    if (
      /bearer\s+[a-z0-9._\-]+/i.test(p) ||
      /"access_token"\s*:/i.test(p) ||
      /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/i.test(p)
    ) {
      return {
        ...b,
        preview: "[REDACTED body preview — possible token/JWT]",
        redacted: true,
      };
    }
  }
  return body;
}

/** Redact one net_dump entry (request/response). */
export function redactNetEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...entry };
  if (typeof out.url === "string") out.url = redactUrl(out.url);
  if (out.headers && typeof out.headers === "object") {
    out.headers = redactHeaders(out.headers as Record<string, unknown>);
  }
  if (out.requestHeaders && typeof out.requestHeaders === "object") {
    out.requestHeaders = redactHeaders(out.requestHeaders as Record<string, unknown>);
  }
  if (out.responseHeaders && typeof out.responseHeaders === "object") {
    out.responseHeaders = redactHeaders(out.responseHeaders as Record<string, unknown>);
  }
  if (out.body) out.body = redactBody(out.body);
  if (out.requestBody) out.requestBody = redactBody(out.requestBody);
  if (out.responseBody) out.responseBody = redactBody(out.responseBody);
  return out;
}

export function redactNetDump(
  dump: Record<string, unknown>,
  redact = true,
): Record<string, unknown> {
  if (!redact) {
    return {
      ...dump,
      redacted: false,
      warning:
        "redact=false: output may contain secrets. Do not paste into issues/logs/PRs.",
    };
  }
  const entries = Array.isArray(dump.entries)
    ? (dump.entries as Record<string, unknown>[]).map(redactNetEntry)
    : dump.entries;
  return {
    ...dump,
    entries,
    redacted: true,
    note: "Sensitive headers/query/body previews redacted by default. Pass redact:false only on trusted local machines.",
  };
}

/** Aggregate hosts for low-noise summary. */
export function summarizeNetHosts(entries: unknown[]): {
  hosts: { host: string; count: number }[];
  total: number;
} {
  const map = new Map<string, number>();
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const url = String((e as { url?: string }).url ?? "");
    let host = "(unknown)";
    try {
      host = new URL(url).host || host;
    } catch {
      /* keep */
    }
    map.set(host, (map.get(host) ?? 0) + 1);
  }
  const hosts = [...map.entries()]
    .map(([host, count]) => ({ host, count }))
    .sort((a, b) => b.count - a.count);
  return { hosts, total: entries.length };
}
