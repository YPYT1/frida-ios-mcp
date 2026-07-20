import { handleMethod } from "../dist/backend.js";

function show(name, r) {
  const t = r.content?.[0]?.text ?? JSON.stringify(r);
  console.log(`\n===${name}===`);
  console.log(t.length > 1500 ? `${t.slice(0, 1500)}\n...[truncated]` : t);
}

const udid = process.argv[2] || "6849e3300bb49162c3c7274e0268b8564cd229ce";
const bundleId = process.argv[3] || "com.ss.iphone.ugc.Ame";

try {
  show("device_list", await handleMethod("device_list"));
  show(
    "session_open",
    await handleMethod("session_open", { udid, bundleId, mode: "spawn" }),
  );
  await handleMethod("wait", { ms: 4000 });
  show("ping", await handleMethod("ping"));
  const snap = await handleMethod("screen_snapshot");
  show("screen_snapshot", snap);
  const text = snap.content[0].text;
  const m = text.match(/\[ref=(t\d+)\] "個人資料"/);
  if (m) {
    show("tap_profile", await handleMethod("tap", { ref: m[1] }));
    await handleMethod("wait", { ms: 2500 });
    show("screen_snapshot_after_tap", await handleMethod("screen_snapshot"));
  } else {
    console.log("\n(no 個人資料 ref — skip tap)");
  }
  show("session_close", await handleMethod("session_close"));
  console.log("\nSMOKE_OK");
} catch (e) {
  console.error("SMOKE_FAIL", e);
  try {
    await handleMethod("session_close");
  } catch {
    /* ignore */
  }
  process.exit(1);
}
