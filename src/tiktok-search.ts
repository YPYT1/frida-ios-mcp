/**
 * TikTok search-page heuristics + feed→search entry tap points.
 * 「搜尋」on the right is submit (after typing), not the open-search entry.
 */

export type SearchProbeNode = {
  text: string;
  likelyInput?: boolean;
  onScreen?: boolean;
};

/** Candidate taps for the feed top-right magnifier (points, not the submit label). */
export const TIKTOK_SEARCH_ENTRY_POINTS: Array<{ x: number; y: number }> = [
  { x: 398, y: 38 },
  { x: 390, y: 42 },
  { x: 400, y: 40 },
  { x: 385, y: 36 },
];

/**
 * True when snapshot looks like search landing (suggestions / bar), not For You feed.
 */
export function looksLikeTikTokSearchPage(nodes: SearchProbeNode[]): boolean {
  const on = nodes.filter((n) => n.onScreen !== false);
  const texts = on.map((n) => n.text.trim());
  const hasSuggest = texts.some((t) =>
    /猜您喜歡|猜你喜欢|You may like|熱門搜尋|热门搜索|Trending|Suggested/i.test(t),
  );
  const hasSubmit = texts.some((t) => /^(搜尋|搜索|Search|検索)$/i.test(t));
  const hasInput = on.some((n) => n.likelyInput);
  // Feed also has tabs; search landing has suggest chrome or (submit + input bar)
  if (hasSuggest) return true;
  if (hasSubmit && hasInput) return true;
  return false;
}
