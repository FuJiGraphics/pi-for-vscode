import { test } from "node:test";
import assert from "node:assert/strict";
// Stubs MUST come before any webview module (the import chain reaches dom.ts indirectly).
import "./_bridgeStub";
import "./_domStub";
import { hasUsageData, setUsageData, usageBarRows } from "../src/webview/usageData";
import { usageAvailable, usageBarsHtml } from "../src/webview/usageBars";

test("usageBarRows: subscription windows only, percent USED, compact labels", () => {
  const reset5h = Date.now() + 60_000; // today → time-of-day label
  setUsageData({
    at: 1,
    unified: [
      { window: "5h", utilization: 1.2, reset: reset5h }, // 1% used → 1% filled
      { window: "7d", utilization: 68, reset: Date.now() + 3 * 86_400_000 }, // → 68% filled
      { window: "overall", status: "allowed" }, // no utilization → no bar
    ],
    limits: [{ kind: "requests", remaining: 4980, limit: 5000 }], // API limits are not rendered in bars
  });

  assert.equal(hasUsageData(), true);
  const rows = usageBarRows();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].label, "5h");
  assert.equal(rows[0].usedPercent, 1);
  assert.ok(rows[0].reset.length > 0); // "11:24 PM"-style
  assert.equal(rows[1].label, "1w");
  assert.equal(rows[1].usedPercent, 68);
});

test("usageBarsHtml: icon-only control reveals used-usage bars in the popover", () => {
  const html = usageBarsHtml([
    { label: "5h", usedPercent: 57, reset: "11:24 PM" },
    { label: "1w", usedPercent: 85, reset: "" },
  ]);

  assert.ok(html.includes('class="usage-control-icon"'));
  assert.ok(html.includes('class="usage-popover"'));
  assert.ok(html.includes('<span class="usage-bar-label">5h</span>'));
  assert.ok(html.includes('<span class="usage-bar-value">57%</span>'));
  assert.ok(html.includes('style="width:57%"'));
  assert.ok(html.includes("Resets 11:24 PM"));
  assert.ok(html.includes('class="usage-bar high"'));
  assert.ok(html.includes('style="width:85%"'));
});

test("usageBarsHtml: no rows means the compact control stays hidden", () => {
  assert.equal(usageBarsHtml([]), "");
});

test("usageAvailable: only an openai-codex OAuth login shows the usage control", () => {
  assert.equal(usageAvailable([{ id: "openai-codex", authType: "oauth" }]), true);
  assert.equal(usageAvailable([{ id: "anthropic", authType: "oauth" }]), false);
  assert.equal(usageAvailable([{ id: "openai-codex", authType: "api_key" }]), false);
  assert.equal(usageAvailable([]), false);
});

test("setUsageData tolerates junk and clears to empty", () => {
  setUsageData("garbage");
  assert.equal(hasUsageData(), false);
  assert.deepEqual(usageBarRows(), []);
  setUsageData({ unified: [{ window: 5, utilization: "x" }], limits: [null] });
  assert.equal(hasUsageData(), false);
  assert.deepEqual(usageBarRows(), []);
});
