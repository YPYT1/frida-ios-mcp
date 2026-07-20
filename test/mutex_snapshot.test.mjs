/**
 * Node test runner (no deps): mutex hold/wait timeout + forceReset + snapshot likelyInput + presets.
 * Run: pnpm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AsyncMutex } from "../dist/mutex.js";
import { ProbeError } from "../dist/errors.js";
import { buildTextSnapshot, formatSnapshot } from "../dist/snapshot.js";
import { resolveTextPreset } from "../dist/presets.js";

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
