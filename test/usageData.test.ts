import { test } from "node:test";
import assert from "node:assert/strict";
// Stubs MUST come before any webview module (the import chain reaches dom.ts indirectly).
import "./_bridgeStub";
import "./_domStub";
import { hasUsageData, setUsageData, usageSummaryRows } from "../src/webview/usageData";

test("usageSummaryRows formats unified windows and limits Codex-style", () => {
  setUsageData({
    at: 1,
    unified: [
      { window: "5h", utilization: 1.2, reset: Date.now() + 60_000 }, // resets today → time
      { window: "7d", utilization: 32 },
      { window: "overall", status: "allowed" },
    ],
    limits: [{ kind: "requests", remaining: 4980, limit: 5000 }],
  });
  assert.equal(hasUsageData(), true);
  const rows = usageSummaryRows();
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
  assert.match(byLabel["5h limit"], /^1% used · resets /);
  assert.equal(byLabel["Weekly"], "32% used");
  assert.equal(byLabel["Plan"], "allowed");
  assert.equal(byLabel["Requests"], "5.0k of 5.0k left");
});

test("setUsageData tolerates junk and clears to empty", () => {
  setUsageData("garbage");
  assert.equal(hasUsageData(), false);
  assert.deepEqual(usageSummaryRows(), []);
  setUsageData({ unified: [{ window: 5, utilization: "x" }], limits: [null] });
  assert.deepEqual(usageSummaryRows(), []);
});
