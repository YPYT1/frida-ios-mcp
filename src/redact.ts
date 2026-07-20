/**
 * Redact secrets and fold noisy payloads from net_dump for open-source safety.
 * Never embed real device tokens in repo samples.
 */

const SENSITIVE_HEADER =
  /^(authorization|cookie|set-cookie|proxy-authorization|x-.*auth.*|x-.*token.*|.*token.*|.*secret.*|.*api[-_]?key.*|.*session.*|.*csrf.*)$/i;

const SENSITIVE_QUERY =
  /(access_token|refresh_token|id_token|token|auth|password|passwd|secret|api_key|apikey|session|sig|sign|signature|jwt)/i;

export type NetQuietOpts = {
  /** Default true */
  redact?: boolean;
  /** Include data: URLs (often huge base64 images). Default false. */
  includeDataUrls?: boolean;
  /** Include binary / octet-stream body previews. Default false. */
  includeBinaryBodies?: boolean;
};

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

function isDataUrl(url: unknown): boolean {
  return typeof url === "string" && /^data:/i.test(url.trim());
}

function isBinaryBody(body: unknown, headers?: Record<string, unknown>): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  const enc = String(b.encoding ?? "").toLowerCase();
  if (enc === "base64" || enc === "raw") return true;
  const ct = String(
    headers?.["Content-Type"] ??
      headers?.["content-type"] ??
      headers?.["Content-type"] ??
      "",
  ).toLowerCase();
  if (ct.includes("octet-stream") || ct.includes("protobuf") || ct.includes("grpc")) {
    return true;
  }
  if (typeof b.preview === "string") {
    const p = b.preview;
    // high non-printable ratio in short sample
    let bad = 0;
    const n = Math.min(p.length, 64);
    for (let i = 0; i < n; i++) {
      const c = p.charCodeAt(i);
      if (c < 9 || (c > 13 && c < 32)) bad++;
    }
    if (n > 0 && bad / n > 0.15) return true;
  }
  return false;
}

function foldBody(
  body: unknown,
  headers: Record<string, unknown> | undefined,
  includeBinary: boolean,
): unknown {
  if (!body || typeof body !== "object") return body;
  const b = body as Record<string, unknown>;
  if (!includeBinary && isBinaryBody(body, headers)) {
    const len = b.length ?? (typeof b.preview === "string" ? b.preview.length : undefined);
    return {
      encoding: b.encoding ?? "binary",
      length: len,
      preview: "[FOLDED binary/octet-stream body]",
      folded: true,
    };
  }
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
    // Cap very long previews even when "text"
    if (p.length > 800) {
      return {
        ...b,
        preview: `${p.slice(0, 200)}…[TRUNCATED len=${p.length}]`,
        truncated: true,
      };
    }
  }
  return body;
}

/** Quiet + redact one net entry. */
export function quietNetEntry(
  entry: Record<string, unknown>,
  opts: NetQuietOpts = {},
): Record<string, unknown> | null {
  const includeDataUrls = opts.includeDataUrls === true;
  const includeBinary = opts.includeBinaryBodies === true;
  const redact = opts.redact !== false;

  const url = typeof entry.url === "string" ? entry.url : "";
  if (!includeDataUrls && isDataUrl(url)) {
    return null; // drop entirely from dump
  }

  const out: Record<string, unknown> = { ...entry };
  if (typeof out.url === "string") {
    if (isDataUrl(out.url)) {
      const m = /^data:([^;,]+)/i.exec(out.url);
      out.url = `data:${m?.[1] ?? "application/octet-stream"};base64,[FOLDED len≈${out.url.length}]`;
      out.dataUrlFolded = true;
    } else if (redact) {
      out.url = redactUrl(out.url);
    }
  }

  const hdrs = (out.headers ?? out.requestHeaders) as Record<string, unknown> | undefined;
  if (redact) {
    if (out.headers && typeof out.headers === "object") {
      out.headers = redactHeaders(out.headers as Record<string, unknown>);
    }
    if (out.requestHeaders && typeof out.requestHeaders === "object") {
      out.requestHeaders = redactHeaders(out.requestHeaders as Record<string, unknown>);
    }
    if (out.responseHeaders && typeof out.responseHeaders === "object") {
      out.responseHeaders = redactHeaders(out.responseHeaders as Record<string, unknown>);
    }
  }

  const h = (out.headers ?? out.requestHeaders ?? hdrs) as Record<string, unknown> | undefined;
  if (out.body) out.body = foldBody(out.body, h, includeBinary);
  if (out.requestBody) out.requestBody = foldBody(out.requestBody, h, includeBinary);
  if (out.responseBody) {
    out.responseBody = foldBody(
      out.responseBody,
      (out.responseHeaders as Record<string, unknown>) ?? h,
      includeBinary,
    );
  }
  return out;
}

/** @deprecated use quietNetDump */
export function redactNetEntry(entry: Record<string, unknown>): Record<string, unknown> {
  return quietNetEntry(entry, { redact: true }) ?? { ...entry, dropped: true };
}

export function quietNetDump(
  dump: Record<string, unknown>,
  opts: NetQuietOpts = {},
): Record<string, unknown> {
  const redact = opts.redact !== false;
  const rawEntries = Array.isArray(dump.entries)
    ? (dump.entries as Record<string, unknown>[])
    : [];
  let droppedDataUrls = 0;
  let foldedBinary = 0;
  const entries: Record<string, unknown>[] = [];
  for (const e of rawEntries) {
    const url = typeof e.url === "string" ? e.url : "";
    if (opts.includeDataUrls !== true && isDataUrl(url)) {
      droppedDataUrls++;
      continue;
    }
    const q = quietNetEntry(e, opts);
    if (!q) {
      droppedDataUrls++;
      continue;
    }
    if (
      (q.body as { folded?: boolean })?.folded ||
      (q.requestBody as { folded?: boolean })?.folded ||
      (q.responseBody as { folded?: boolean })?.folded
    ) {
      foldedBinary++;
    }
    entries.push(q);
  }
  const returned = entries.length;
  return {
    // Do not spread dump.count/returned from agent — redefine clearly:
    enabled: dump.enabled,
    opts: dump.opts,
    entries,
    /** Capture buffer size before quiet filters (agent ring / pre-filter list) */
    rawCount: rawEntries.length,
    /** entries.length after drop/fold — same as returned */
    returned,
    /** Alias of returned (kept for old clients; always === returned) */
    count: returned,
    droppedDataUrls,
    foldedBinaryBodies: foldedBinary,
    redacted: redact,
    quietDefaults: {
      includeDataUrls: opts.includeDataUrls === true,
      includeBinaryBodies: opts.includeBinaryBodies === true,
      redact,
    },
    note:
      "rawCount=buffer before quiet filter; droppedDataUrls/foldedBinaryBodies=filter stats; returned(=count)=entries.length. " +
      (redact
        ? "Default: secrets redacted, data: URLs dropped, binary bodies folded."
        : "redact=false: may contain secrets — never paste into issues/PRs."),
  };
}

/** @deprecated */
export function redactNetDump(
  dump: Record<string, unknown>,
  redact = true,
): Record<string, unknown> {
  return quietNetDump(dump, { redact });
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
    if (/^data:/i.test(url)) {
      host = "(data-url)";
    } else {
      try {
        host = new URL(url).host || host;
      } catch {
        /* keep */
      }
    }
    map.set(host, (map.get(host) ?? 0) + 1);
  }
  const hosts = [...map.entries()]
    .map(([host, count]) => ({ host, count }))
    .sort((a, b) => b.count - a.count);
  return { hosts, total: entries.length };
}
