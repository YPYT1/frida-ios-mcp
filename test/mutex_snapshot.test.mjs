/**
 * Node test runner (no deps): mutex hold/wait timeout + forceReset + snapshot likelyInput + presets + tool tiers.
 * Run: pnpm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AsyncMutex } from "../dist/mutex.js";
import { ProbeError } from "../dist/errors.js";
import { buildTextSnapshot, formatSnapshot } from "../dist/snapshot.js";
import { resolveTextPreset } from "../dist/presets.js";
import {
  annotateToolDesc,
  shouldRegisterTool,
  toolTier,
  toolsMode,
} from "../dist/tool-tiers.js";

describe("AsyncMutex", () => {
  it("holdTimeout releases lock while fn still hung", async () => {
    const lock = new AsyncMutex();
    const hung = lock.run(
      async () => {
        await new Promise(() => {});
      },
      { op: "session_open", holdTimeoutMs: 80 },
    );
    await assert.rejects(hung, (e) => e instanceof ProbeError && e.code === "APP_LOCK_HOLD_TIMEOUT");
    assert.equal(lock.status().busy, false);
    const r = await lock.run(async () => "ok", { waitTimeoutMs: 200, op: "next" });
    assert.equal(r, "ok");
  });

  it("waitTimeout rejects without running fn", async () => {
    const lock = new AsyncMutex();
    void lock.run(async () => new Promise(() => {}), { op: "holder" });
    await new Promise((r) => setTimeout(r, 20));
    await assert.rejects(
      lock.run(async () => "nope", { waitTimeoutMs: 50, op: "waiter" }),
      (e) => e instanceof ProbeError && e.code === "APP_LOCK_TIMEOUT",
    );
    lock.forceReset();
    const r = await lock.run(async () => "ok", { waitTimeoutMs: 200, op: "after" });
    assert.equal(r, "ok");
  });
});

describe("snapshot likelyInput", () => {
  it("marks search placeholders and sorts them first", () => {
    const table = buildTextSnapshot(
      [
        {
          codes: [..."首頁"].map((c) => c.charCodeAt(0)),
          frame: { x: 0, y: 700, w: 80, h: 20, cx: 40, cy: 710 },
          className: "UILabel",
        },
        {
          codes: [..."搜尋"].map((c) => c.charCodeAt(0)),
          frame: { x: 40, y: 100, w: 300, h: 36, cx: 190, cy: 118 },
          className: "UITextField",
        },
      ],
      { width: 414, height: 736 },
    );
    const input = table.nodes.find((n) => n.likelyInput);
    assert.ok(input);
    assert.match(input.text, /搜尋/);
    const text = formatSnapshot(table, { limit: 5 });
    assert.match(text, /\[input\]/);
    assert.ok(text.indexOf("搜尋") < text.indexOf("首頁"));
  });

  it("does not mark hot-search chips or narrow 搜尋 button as input", () => {
    const table = buildTextSnapshot(
      [
        {
          codes: [..."ヤマル 緊急入院 W杯決勝"].map((c) => c.charCodeAt(0)),
          frame: { x: 40, y: 600, w: 184, h: 26, cx: 132, cy: 613 },
          className: "TUXLabel",
        },
        {
          // Misleading class (TikTok trend cells) must still NOT be [input]
          codes: [..."ブルダック カルボ アレンジ"].map((c) => c.charCodeAt(0)),
          frame: { x: 40, y: 600, w: 200, h: 26, cx: 140, cy: 624 },
          className: "AWESearchTextFieldCell",
        },
        {
          codes: [..."猜您喜歡"].map((c) => c.charCodeAt(0)),
          frame: { x: 16, y: 86, w: 68, h: 20, cx: 50, cy: 96 },
          className: "UILabel",
        },
        {
          codes: [..."搜尋"].map((c) => c.charCodeAt(0)),
          frame: { x: 368, y: 34, w: 30, h: 17, cx: 383, cy: 42 },
          className: "UILabel",
        },
        {
          codes: [..."ワールドカップ注目選手"].map((c) => c.charCodeAt(0)),
          frame: { x: 48, y: 24, w: 304, h: 36, cx: 200, cy: 42 },
          className: "AWESearchBar",
        },
        {
          codes: [..."hello"].map((c) => c.charCodeAt(0)),
          frame: { x: 48, y: 24, w: 304, h: 36, cx: 200, cy: 42 },
          className: "UISearchBarTextField",
        },
      ],
      { width: 414, height: 736 },
    );
    const chip = table.nodes.find((n) => n.text.includes("ヤマル"));
    const fakeField = table.nodes.find((n) => n.text.includes("ブルダック"));
    const section = table.nodes.find((n) => n.text === "猜您喜歡");
    const btn = table.nodes.find((n) => n.text === "搜尋");
    const bar = table.nodes.find((n) => n.text.includes("ワールドカップ"));
    const typed = table.nodes.find((n) => n.text === "hello");
    assert.equal(chip?.likelyInput, undefined);
    assert.equal(fakeField?.likelyInput, undefined);
    assert.equal(section?.likelyInput, undefined);
    assert.equal(btn?.likelyInput, undefined);
    assert.equal(bar?.likelyInput, true);
    assert.equal(typed?.likelyInput, true);
    const inputs = table.nodes.filter((n) => n.likelyInput);
    assert.equal(inputs.length, 2);
  });

  it("dedupes stacked search-bar [input] with same text", () => {
    const table = buildTextSnapshot(
      [
        {
          codes: [..."ok"].map((c) => c.charCodeAt(0)),
          frame: { x: 48, y: 24, w: 304, h: 36, cx: 200, cy: 42 },
          className: "AWESearchBar",
        },
        {
          codes: [..."ok"].map((c) => c.charCodeAt(0)),
          frame: { x: 79, y: 24, w: 245, h: 36, cx: 201.5, cy: 42 },
          className: "UISearchBarTextFieldLabel",
        },
        {
          codes: [..."成人式　写真"].map((c) => c.charCodeAt(0)),
          frame: { x: 40, y: 320, w: 96, h: 21, cx: 88, cy: 336 },
          className: "LynxTextView",
        },
      ],
      { width: 414, height: 736 },
    );
    const inputs = table.nodes.filter((n) => n.likelyInput);
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].text, "ok");
    assert.equal(inputs[0].className, "AWESearchBar");
  });
});

describe("presets", () => {
  it("tiktok_feed covers JA and TW without assuming one locale", () => {
    const p = resolveTextPreset("tiktok_feed");
    assert.ok(p);
    assert.match(p.pattern, /おすすめ/);
    assert.match(p.pattern, /為您推薦/);
    assert.match(p.pattern, /ホーム/);
    assert.match(p.pattern, /For You/);
    assert.match(p.pattern, /首页/);
    assert.match(p.pattern, /홈/);
  });
});

describe("tool tiers", () => {
  it("classifies core vs advanced vs debug", () => {
    assert.equal(toolTier("screen_snapshot"), "core");
    assert.equal(toolTier("screen_shot"), "core");
    assert.equal(toolTier("photos_list"), "advanced");
    assert.equal(toolTier("rpc_call"), "debug");
    assert.match(annotateToolDesc("net_dump", "x"), /^\[advanced\]/);
  });

  it("FRIDA_MCP_TOOLS=core hides advanced but keeps screen_shot", () => {
    const prev = process.env.FRIDA_MCP_TOOLS;
    process.env.FRIDA_MCP_TOOLS = "core";
    try {
      assert.equal(toolsMode(), "core");
      assert.equal(shouldRegisterTool("tap"), true);
      assert.equal(shouldRegisterTool("screen_shot"), true);
      assert.equal(shouldRegisterTool("photos_list"), false);
      assert.equal(shouldRegisterTool("net_dump"), false);
      assert.equal(shouldRegisterTool("rpc_call"), false);
    } finally {
      if (prev === undefined) delete process.env.FRIDA_MCP_TOOLS;
      else process.env.FRIDA_MCP_TOOLS = prev;
    }
  });
});

describe("swipe duration", () => {
  it("treats 280 as ms not 280 seconds", async () => {
    const { normalizeSwipeDuration } = await import("../dist/swipe-duration.js");
    const n = normalizeSwipeDuration({ duration: 280 });
    assert.ok(n.coercedFromMs);
    assert.ok(Math.abs(n.seconds - 0.28) < 0.001);
    assert.equal(n.clamped, false);
  });

  it("prefers durationMs and clamps huge values", async () => {
    const { normalizeSwipeDuration } = await import("../dist/swipe-duration.js");
    const a = normalizeSwipeDuration({ durationMs: 400 });
    assert.ok(Math.abs(a.seconds - 0.4) < 0.001);
    assert.equal(a.coercedFromMs, false);
    assert.equal(a.warn, undefined);
    const b = normalizeSwipeDuration({ durationMs: 60_000 });
    assert.equal(b.seconds, 2.5);
    assert.equal(b.clamped, true);
    assert.equal(b.coercedFromMs, false);
    assert.match(b.warn || "", /clamped/);
    const c = normalizeSwipeDuration({ duration: 0.5 });
    assert.equal(c.coercedFromMs, false);
    assert.equal(c.seconds, 0.5);
    const d = normalizeSwipeDuration({ duration: 280 });
    assert.equal(d.coercedFromMs, true);
    assert.match(d.warn || "", /prefer durationMs/);
  });
});
