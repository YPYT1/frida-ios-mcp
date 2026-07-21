/**
 * Agent swipe() expects duration in **seconds** (default ~0.4–0.6).
 * AI often passes milliseconds (e.g. 280 → 280s → 16k steps → appLock stuck).
 */

export type SwipeDurationNorm = {
  /** Seconds passed to Frida agent */
  seconds: number;
  /** True when caller likely meant ms and we converted */
  coercedFromMs: boolean;
  /** True when value was clamped to [min,max] */
  clamped: boolean;
  warn?: string;
};

const MIN_SEC = 0.15;
const MAX_SEC = 2.5;
const DEFAULT_SEC = 0.4;
/** Values above this (when unit ambiguous) are treated as milliseconds */
const MS_HINT_THRESHOLD = 10;

/**
 * Normalize swipe duration to agent seconds.
 * - Prefer durationMs when provided
 * - duration ≤ 10 → seconds; duration > 10 → milliseconds (common AI mistake)
 */
export function normalizeSwipeDuration(opts: {
  duration?: number;
  durationMs?: number;
}): SwipeDurationNorm {
  let seconds: number;
  let coercedFromMs = false;

  if (opts.durationMs != null && Number.isFinite(opts.durationMs)) {
    seconds = opts.durationMs / 1000;
    coercedFromMs = true;
  } else if (opts.duration != null && Number.isFinite(opts.duration)) {
    if (opts.duration > MS_HINT_THRESHOLD) {
      seconds = opts.duration / 1000;
      coercedFromMs = true;
    } else {
      seconds = opts.duration;
    }
  } else {
    return { seconds: DEFAULT_SEC, coercedFromMs: false, clamped: false };
  }

  if (seconds < 0) seconds = DEFAULT_SEC;

  let clamped = false;
  if (seconds < MIN_SEC) {
    seconds = MIN_SEC;
    clamped = true;
  } else if (seconds > MAX_SEC) {
    seconds = MAX_SEC;
    clamped = true;
  }

  const parts: string[] = [];
  if (coercedFromMs) {
    parts.push(
      `duration interpreted as milliseconds → ${seconds.toFixed(2)}s (agent uses seconds)`,
    );
  }
  if (clamped) {
    parts.push(`duration clamped to ${MIN_SEC}–${MAX_SEC}s`);
  }

  return {
    seconds,
    coercedFromMs,
    clamped,
    warn: parts.length ? parts.join("; ") : undefined,
  };
}
