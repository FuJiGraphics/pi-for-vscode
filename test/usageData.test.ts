import { test } from "node:test";
import assert from "node:assert/strict";
// Stubs MUST come before any webview module (the import chain reaches dom.ts indirectly).
import "./_bridgeStub";
import "./_domStub";
import { hasUsageData, setUsageData, usageMenuRows, usageSummaryRows } from "../src/webview/usageData";
import { usageMenuHtml } from "../src/webview/usageMenu";

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
  assert.match(byLabel["5h"], /^1% used · resets /);
  assert.equal(byLabel["Weekly"], "32% used");
  assert.equal(byLabel["Plan"], "allowed");
  assert.equal(byLabel["Requests"], "5.0k of 5.0k left");
});

test("usageMenuRows: Codex format — percent REMAINING per window, label/value/reset columns", () => {
  const reset5h = Date.now() + 60_000; // today → time-of-day label
  setUsageData({
    at: 1,
    unified: [
      { window: "5h", utilization: 2, reset: reset5h }, // 2% used → 98% left
      { window: "7d", utilization: 68, reset: Date.now() + 3 * 86_400_000 }, // → 32% left, date label
    ],
    limits: [{ kind: "requests", remaining: 4980, limit: 5000 }],
  });
  const rows = usageMenuRows();
  assert.equal(rows[0].label, "5h");
  assert.equal(rows[0].value, "98%");
  assert.ok(rows[0].reset.length > 0); // "11:24 PM"-style
  assert.equal(rows[1].label, "Weekly");
  assert.equal(rows[1].value, "32%");
  assert.equal(rows[2].label, "Requests");
  assert.equal(rows[2].value, "5.0k of 5.0k");

  const html = usageMenuHtml(rows);
  assert.ok(html.includes("Usage remaining"));
  assert.ok(html.includes('<span class="usage-label">5h</span>'));
  assert.ok(html.includes('<span class="usage-value">98%</span>'));
});

test("usageMenuHtml explains the empty state instead of rendering nothing", () => {
  const html = usageMenuHtml([]);
  assert.ok(html.includes("Usage remaining"));
  assert.ok(html.includes("No usage data reported yet"));
});

test("setUsageData tolerates junk and clears to empty", () => {
  setUsageData("garbage");
  assert.equal(hasUsageData(), false);
  assert.deepEqual(usageSummaryRows(), []);
  setUsageData({ unified: [{ window: 5, utilization: "x" }], limits: [null] });
  assert.deepEqual(usageSummaryRows(), []);
});
