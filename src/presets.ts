/**
 * Locale-agnostic probe presets. Never assume a single market language.
 */

export type TextPreset = {
  id: string;
  /** Regex alternation (wait_until_texts auto-enables | as regex) */
  pattern: string;
  /** Short hint for agents */
  note: string;
};

/** Bottom-nav / For-You chrome across EN / ZH-Hant / ZH-Hans / JA / KO */
const TIKTOK_FEED_PARTS = [
  // English
  "For You",
  "Home",
  "Friends",
  "Inbox",
  "Profile",
  // Traditional Chinese (TW/HK)
  "為您推薦",
  "首頁",
  "好友",
  "收信匣",
  "個人資料",
  // Simplified Chinese
  "推荐",
  "首页",
  "朋友",
  "消息",
  // Japanese
  "おすすめ",
  "ホーム",
  "友達",
  "受信箱",
  "プロフィール",
  // Korean
  "추천",
  "홈",
  "친구",
  "프로필",
  "받은편지함",
];

export const TEXT_PRESETS: Record<string, TextPreset> = {
  tiktok_feed: {
    id: "tiktok_feed",
    pattern: TIKTOK_FEED_PARTS.map(escapeRegexLiteral).join("|"),
    note:
      "Multi-locale TikTok feed/nav chrome (EN/ZH-Hant/ZH-Hans/JA/KO). Prefer preset over hardcoding one language.",
  },
};

function escapeRegexLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function resolveTextPreset(
  preset: string | undefined,
): TextPreset | null {
  if (!preset) return null;
  const key = preset.trim().toLowerCase().replace(/-/g, "_");
  return TEXT_PRESETS[key] ?? null;
}

export function listTextPresets(): Array<{ id: string; note: string; pattern: string }> {
  return Object.values(TEXT_PRESETS).map((p) => ({
    id: p.id,
    note: p.note,
    pattern: p.pattern,
  }));
}
