import { quietNetDump } from "../dist/redact.js";
import { handleMethod } from "../dist/backend.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (n, r) =>
  console.log("==", n, "==\n", (r.content?.[0]?.text || "").slice(0, 400));

// A: quiet dump
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
console.log(
  "quiet count",
  q.count,
  "droppedData",
  q.droppedDataUrls,
  "foldedBin",
  q.foldedBinaryBodies,
);
console.log(JSON.stringify(q.entries, null, 2).slice(0, 700));

log(
  "open",
  await handleMethod("session_open", {
    bundleId: "com.apple.Preferences",
    withSpringBoard: true,
  }),
);
await sleep(2000);
log("trig", await handleMethod("sb_alert_trigger"));
await sleep(1000);
log("list", await handleMethod("sb_alert_list"));
log(
  "close_keep",
  await handleMethod("session_close", { closeSpringBoard: false }),
);
log("st_keep", await handleMethod("session_status"));
await handleMethod("sb_close");

log(
  "open2",
  await handleMethod("session_open", { bundleId: "com.apple.Preferences" }),
);
await sleep(2000);
const snap = await handleMethod("screen_snapshot", { limit: 40 });
const t = snap.content[0].text;
const m = t.match(/\[ref=(g\d+t\d+)\] "一般"/);
console.log("ref一般", m && m[1]);
if (m) {
  log("smart_nav", await handleMethod("smart_type_text", { text: "hi", ref: m[1] }));
}
await handleMethod("session_close");
console.log("SMOKE_UX_OK");
