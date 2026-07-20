export type TextNode = {
  ref: string;
  text: string;
  cx: number;
  cy: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** False when frame is zero-size or missing */
  tappable: boolean;
  /** False when center is outside window (if known) */
  onScreen: boolean;
  /** Heuristic: looks like a text field / search box (prefer for smart_type_text) */
  likelyInput?: boolean;
  className?: string;
};

export type SnapshotTable = {
  window?: { width: number; height: number };
  nodes: TextNode[];
  rawCount: number;
  createdAt: number;
  /** Monotonic id so refs cannot be reused across snapshots */
  generation: number;
};

export type SnapshotFormatOpts = {
  /** Default true: hide off-screen nodes from output (full table still kept for ref resolve if needed) */
  onScreenOnly?: boolean;
  /** Max nodes to print (default 40) */
  limit?: number;
  /** Substring or regex filter on text */
  search?: string;
  searchRegex?: boolean;
  /** Relative to previous table: summarize +/−/~ */
  showDiff?: boolean;
  prev?: SnapshotTable | null;
};

let nextGeneration = 1;

type Frame = { x: number; y: number; w: number; h: number; cx: number; cy: number };

function decodeCodes(codes: unknown): string {
  if (typeof codes === "string") return codes;
  if (!Array.isArray(codes)) return "";
  try {
    return String.fromCharCode(...codes.map((c) => Number(c)));
  } catch {
    return "";
  }
}

function normalizeFrame(frame: unknown): Frame | null {
  if (!frame || typeof frame !== "object") return null;
  const f = frame as Record<string, unknown>;
  const x = Number(f.x ?? 0);
  const y = Number(f.y ?? 0);
  const w = Number(f.w ?? 0);
  const h = Number(f.h ?? 0);
  const cx = Number(f.cx ?? x + w / 2);
  const cy = Number(f.cy ?? y + h / 2);
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
  return { x, y, w, h, cx, cy };
}

function isOnScreen(
  frame: Frame,
  window?: { width: number; height: number } | null,
): boolean {
  if (!window || !(window.width > 0) || !(window.height > 0)) {
    return frame.w > 0 && frame.h > 0;
  }
  const pad = 4;
  return (
    frame.cx >= -pad &&
    frame.cy >= -pad &&
    frame.cx <= window.width + pad &&
    frame.cy <= window.height + pad &&
    frame.w > 0 &&
    frame.h > 0
  );
}

function isLikelyInputClass(className: string): boolean {
  const c = className.toLowerCase();
  return (
    c.includes("textfield") ||
    c.includes("textview") ||
    c.includes("searchbar") ||
    c.includes("uitextfield") ||
    c.includes("uitextview") ||
    c.includes("yytext") ||
    (c.includes("search") && c.includes("field"))
  );
}

/** Placeholder / search chrome — not nav chips like 有什麼好事 */
function isLikelyInputText(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 80) return false;
  if (
    /^(搜尋|搜索|Search|検索|입력|輸入|输入|Type|Write a|Say something|有什麼想說|说点什么)/i.test(
      t,
    )
  ) {
    return true;
  }
  if (/placeholder|search here|find user/i.test(t)) return true;
  return false;
}

function guessLikelyInput(
  text: string,
  frame: Frame,
  className: string,
): boolean {
  if (isLikelyInputClass(className)) return true;
  if (isLikelyInputText(text)) return true;
  // Wide short field with short label — weak signal only with empty-ish / hint text
  if (
    frame.w >= 120 &&
    frame.h >= 28 &&
    frame.h <= 56 &&
    text.trim().length > 0 &&
    text.trim().length <= 40 &&
    /搜|Search|search|輸入|输入|Type/i.test(text)
  ) {
    return true;
  }
  return false;
}

/** Build ref table from collectTextsWithFrames payload. */
export function buildTextSnapshot(
  items: unknown,
  window?: { width: number; height: number } | null,
): SnapshotTable {
  const list = Array.isArray(items) ? items : [];
  const rawList =
    !Array.isArray(items) &&
    items &&
    typeof items === "object" &&
    Array.isArray((items as { items?: unknown }).items)
      ? (items as { items: unknown[] }).items
      : list;

  const generation = nextGeneration++;
  const nodes: TextNode[] = [];
  let i = 1;
  for (const item of rawList) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const text = decodeCodes(rec.codes).trim();
    if (!text) continue;
    const frame = normalizeFrame(rec.frame);
    const f = frame ?? { x: 0, y: 0, w: 0, h: 0, cx: 0, cy: 0 };
    const className =
      typeof rec.className === "string"
        ? rec.className
        : typeof rec.cls === "string"
          ? rec.cls
          : "";
    const tappable = f.w >= 1 && f.h >= 1 && Number.isFinite(f.cx) && Number.isFinite(f.cy);
    const onScreen = tappable && isOnScreen(f, window);
    const likelyInput = guessLikelyInput(text, f, className);
    nodes.push({
      ref: `g${generation}t${i++}`,
      text,
      cx: f.cx,
      cy: f.cy,
      x: f.x,
      y: f.y,
      w: f.w,
      h: f.h,
      tappable,
      onScreen,
      likelyInput: likelyInput || undefined,
      className: className || undefined,
    });
  }
  return {
    window: window ?? undefined,
    nodes,
    rawCount: rawList.length,
    createdAt: Date.now(),
    generation,
  };
}

/**
 * Default search is literal substring.
 * If search looks like alternation (a|b) and searchRegex not explicitly false,
 * auto-enable regex and note it in the filter meta.
 */
export function resolveSearchMode(
  search: string | undefined,
  searchRegex?: boolean,
): { useRegex: boolean; autoRegex: boolean } {
  if (!search) return { useRegex: false, autoRegex: false };
  if (searchRegex === true) return { useRegex: true, autoRegex: false };
  if (searchRegex === false) return { useRegex: false, autoRegex: false };
  // Auto: | suggests alternation regex (common AI mistake with 個人|新增)
  if (search.includes("|")) {
    return { useRegex: true, autoRegex: true };
  }
  return { useRegex: false, autoRegex: false };
}

function filterNodes(
  table: SnapshotTable,
  opts: SnapshotFormatOpts,
): { nodes: TextNode[]; searchMeta?: string } {
  let nodes = table.nodes.slice();
  const onScreenOnly = opts.onScreenOnly !== false; // default true
  if (onScreenOnly) {
    nodes = nodes.filter((n) => n.onScreen);
  }
  let searchMeta: string | undefined;
  if (opts.search) {
    const { useRegex, autoRegex } = resolveSearchMode(opts.search, opts.searchRegex);
    if (useRegex) {
      try {
        const re = new RegExp(opts.search, "i");
        nodes = nodes.filter((n) => re.test(n.text));
        searchMeta = autoRegex
          ? `search=regex(auto|):${JSON.stringify(opts.search)}`
          : `search=regex:${JSON.stringify(opts.search)}`;
      } catch {
        const q = opts.search.toLowerCase();
        nodes = nodes.filter((n) => n.text.toLowerCase().includes(q));
        searchMeta = `search=substring(fallback):${JSON.stringify(opts.search)}`;
      }
    } else {
      const q = opts.search.toLowerCase();
      nodes = nodes.filter((n) => n.text.toLowerCase().includes(q));
      searchMeta = `search=substring:${JSON.stringify(opts.search)}`;
    }
  }
  // Prefer likely inputs, then larger tappable first when limited
  nodes.sort((a, b) => {
    const score = (n: TextNode) =>
      (n.likelyInput ? 5000 : 0) +
      (n.tappable ? 1000 : 0) +
      (n.onScreen ? 500 : 0) +
      n.w * n.h;
    return score(b) - score(a);
  });
  return { nodes, searchMeta };
}

function formatDiff(prev: SnapshotTable, cur: SnapshotTable): string[] {
  const prevByText = new Map<string, number>();
  for (const n of prev.nodes) {
    if (!n.onScreen) continue;
    prevByText.set(n.text, (prevByText.get(n.text) ?? 0) + 1);
  }
  const curByText = new Map<string, number>();
  for (const n of cur.nodes) {
    if (!n.onScreen) continue;
    curByText.set(n.text, (curByText.get(n.text) ?? 0) + 1);
  }
  const added: string[] = [];
  const removed: string[] = [];
  for (const [t, c] of curByText) {
    const p = prevByText.get(t) ?? 0;
    if (c > p) added.push(t);
  }
  for (const [t, p] of prevByText) {
    const c = curByText.get(t) ?? 0;
    if (p > c) removed.push(t);
  }
  const lines: string[] = ["diff:"];
  const maxEach = 12;
  for (const t of added.slice(0, maxEach)) {
    const short = t.length > 60 ? `${t.slice(0, 57)}...` : t;
    lines.push(`  + ${JSON.stringify(short)}`);
  }
  if (added.length > maxEach) lines.push(`  + …(+${added.length - maxEach} more)`);
  for (const t of removed.slice(0, maxEach)) {
    const short = t.length > 60 ? `${t.slice(0, 57)}...` : t;
    lines.push(`  - ${JSON.stringify(short)}`);
  }
  if (removed.length > maxEach) lines.push(`  - …(+${removed.length - maxEach} more)`);
  if (added.length === 0 && removed.length === 0) {
    lines.push("  (no on-screen text add/remove)");
  }
  lines.push(
    `  gen ${prev.generation} → ${cur.generation}; use refs from gen=${cur.generation} only`,
  );
  return lines;
}

export function formatSnapshot(
  table: SnapshotTable,
  opts: SnapshotFormatOpts = {},
): string {
  const onScreenOnly = opts.onScreenOnly !== false;
  const limit = Math.min(200, Math.max(1, opts.limit ?? 40));
  const { nodes: filtered, searchMeta } = filterNodes(table, opts);
  const shown = filtered.slice(0, limit);
  const omitted = Math.max(0, filtered.length - shown.length);
  const offScreen = table.nodes.filter((n) => !n.onScreen).length;
  const tappableOn = table.nodes.filter((n) => n.tappable && n.onScreen).length;

  const lines: string[] = [];
  if (table.window) {
    lines.push(`window: ${table.window.width}x${table.window.height}`);
  } else {
    lines.push("window: unknown");
  }
  lines.push(`generation: g${table.generation}`);
  const inputCount = table.nodes.filter((n) => n.likelyInput && n.onScreen).length;
  lines.push(
    `nodes: ${shown.length} shown / ${table.nodes.length} total / raw=${table.rawCount}` +
      ` | onScreen=${table.nodes.length - offScreen} offScreen=${offScreen} tappableOnScreen=${tappableOn}` +
      (inputCount ? ` likelyInput=${inputCount}` : "") +
      (onScreenOnly ? " | filter=onScreenOnly" : "") +
      (searchMeta ? ` | ${searchMeta}` : "") +
      (omitted ? ` | truncated=+${omitted}` : ""),
  );
  lines.push(
    "hint: After tap/swipe/type, refs are invalid — call screen_snapshot again (or use resnapshot). Use only refs from THIS generation. Prefer [input] refs for smart_type_text. Do not parallelize app act tools (tap/swipe/type); only App+SB dual is parallel-safe.",
  );

  if (opts.showDiff && opts.prev) {
    lines.push(...formatDiff(opts.prev, table));
  }

  for (const n of shown) {
    const short = n.text.length > 80 ? `${n.text.slice(0, 77)}...` : n.text;
    const flags: string[] = [];
    if (n.likelyInput) flags.push("input");
    if (!n.tappable) flags.push("not-tappable");
    else if (!n.onScreen) flags.push("off-screen");
    const flagStr = flags.length ? ` [${flags.join(",")}]` : "";
    lines.push(
      `[ref=${n.ref}] ${JSON.stringify(short)} cx=${round(n.cx)} cy=${round(n.cy)} w=${round(n.w)} h=${round(n.h)}${flagStr}`,
    );
  }
  if (omitted > 0) {
    lines.push(`… ${omitted} more nodes hidden (raise limit or pass search=)`);
  }
  return lines.join("\n");
}

export function searchSnapshot(
  table: SnapshotTable,
  query: string,
  useRegex = false,
): TextNode[] {
  let hits: TextNode[];
  if (useRegex) {
    const re = new RegExp(query, "i");
    hits = table.nodes.filter((n) => re.test(n.text));
  } else {
    const q = query.toLowerCase();
    hits = table.nodes.filter((n) => n.text.toLowerCase().includes(q));
  }
  return hits.sort((a, b) => {
    const score = (n: TextNode) =>
      (n.tappable ? 1000 : 0) + (n.onScreen ? 500 : 0) + n.w * n.h;
    return score(b) - score(a);
  });
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
