/**
 * Offline + optional device smoke for open-source polish.
 *
 * - quietNetDump always runs offline.
 * - Device steps need a connected phone; skip if open fails.
 * - Real TikTok search-box typing is NOT automated here (needs human/device
 *   online Feed UI). Do not auto-tap random chrome — kills session on NOT_INPUT paths.
 */
import { quietNetDump } from "../dist/redact.js";
import { handleMethod } from "../dist/backend.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (n, r) =>
  console.log("==", n, "==\n", (r.content?.[0]?.text || "").slice(0, 500));

// A: quiet dump field semantics
const noisy = {
  entries: [
    {
      method: "GET",
      url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
      headers: {},
    },
    {
      method: "POST",
      url: "https://api.snapkit.com/v1",
      headers: {
        Authorization: "Bearer SECRETTOKEN12345",
        "Content-Type": "application/octet-stream",
      },
      body: { encoding: "base64", length: 2024, preview: "\x00\x01\x02binaryjunk" },
    },
    {
      method: "GET",
      url: "https://www.tiktok.com/api/foo",
      headers: { "Content-Type": "application/json" },
      body: { encoding: "utf8", preview: '{"ok":true}' },
    },
  ],
  count: 3,
};
const q = quietNetDump(noisy, {});
console.log("quiet fields", {
  rawCount: q.rawCount,
  returned: q.returned,
  count: q.count,
  droppedDataUrls: q.droppedDataUrls,
  foldedBinaryBodies: q.foldedBinaryBodies,
  note: q.note,
});
if (q.rawCount !== 3 || q.returned !== 2 || q.count !== q.returned || q.droppedDataUrls < 1) {
  throw new Error("quietNetDump field semantics failed");
}
console.log(JSON.stringify(q.entries, null, 2).slice(0, 700));

// Offline: probe_help typing steps
const help = await handleMethod("probe_help");
const helpText = help.content?.[0]?.text || "";
if (!/搜尋|搜索|Search/.test(helpText) || !/NOT_INPUT/.test(helpText)) {
  throw new Error("probe_help.typing missing search-box steps");
}
console.log("probe_help.typing OK");

// Device steps (optional)
log(
  "open",
  await handleMethod("session_open", {
    bundleId: "com.apple.Preferences",
    withSpringBoard: true,
  }),
);
await sleep(2000);
const trig1 = await handleMethod("sb_alert_trigger");
log("trig1", trig1);
await sleep(1000);
const trig2 = await handleMethod("sb_alert_trigger");
log("trig2_should_skip", trig2);
const t2 = trig2.content?.[0]?.text || "";
if (t2.includes("skipped") && !/"skipped"\s*:\s*true/.test(t2) && !t2.includes('"skipped": true')) {
  // soft: device may be offline
  console.log("note: second trigger skip not confirmed (device/SB may be offline)");
} else if (/"skipped"\s*:\s*true/.test(t2) || t2.includes('"skipped": true')) {
  console.log("sb_alert_trigger anti-stack OK (skipped:true)");
}
log("list", await handleMethod("sb_alert_list"));
log(
  "close_keep",
  await handleMethod("session_close", { closeSpringBoard: false }),
);
log("st_keep", await handleMethod("session_status"));
await handleMethod("sb_close");

// Preferences nav label → expect NOT_INPUT (safe; no session kill)
log(
  "open2",
  await handleMethod("session_open", { bundleId: "com.apple.Preferences" }),
);
await sleep(2000);
const snap = await handleMethod("screen_snapshot", { limit: 40 });
const t = snap.content?.[0]?.text || "";
const m = t.match(/\[ref=(g\d+t\d+)\] "一般"/);
console.log("ref一般", m && m[1]);
if (m) {
  log("smart_nav_expect_NOT_INPUT", await handleMethod("smart_type_text", { text: "hi", ref: m[1] }));
}
// Real TikTok search-box path is manual — see probe_help.typing / README.
await handleMethod("session_close");
console.log("SMOKE_UX_OK");
