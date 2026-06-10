import { test } from "node:test";
import assert from "node:assert/strict";
// Stubs MUST come before any webview module (the import chain reaches dom.ts indirectly).
import "./_bridgeStub";
import "./_domStub";
import { hasUsageData, setUsageData, usageBarRows } from "../src/webview/usageData";
import { usageAvailable, usageBarsHtml } from "../src/webview/usageBars";

test("usageBarRows: subscription windows only, percent REMAINING, compact labels", () => {
  const reset5h = Date.now() + 60_000; // today → time-of-day label
  setUsageData({
    at: 1,
    unified: [
      { window: "5h", utilization: 1.2, reset: reset5h }, // 1% used → 99% left
      { window: "7d", utilization: 68, reset: Date.now() + 3 * 86_400_000 }, // → 32% left
      { window: "overall", status: "allowed" }, // no utilization → no bar
    ],
    limits: [{ kind: "requests", remaining: 4980, limit: 5000 }], // API limits are not rendered in bars
  });

  assert.equal(hasUsageData(), true);
  const rows = usageBarRows();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].label, "5h");
  assert.equal(rows[0].remainingPercent, 99);
  assert.ok(rows[0].reset.length > 0); // "11:24 PM"-style
  assert.equal(rows[1].label, "1w");
  assert.equal(rows[1].remainingPercent, 32);
});

test("usageBarsHtml: labels and remaining percent live inside the filled bars", () => {
  const html = usageBarsHtml([
    { label: "5h", remainingPercent: 99, reset: "11:24 PM" },
    { label: "1w", remainingPercent: 19, reset: "" },
  ]);

  assert.ok(html.includes('<span class="usage-bar-label">5h</span>'));
  assert.ok(html.includes('<span class="usage-bar-value">99%</span>'));
  assert.ok(html.includes('style="width:99%"'));
  assert.ok(html.includes("Resets 11:24 PM"));
  assert.ok(html.includes('class="usage-bar low"'));
  assert.ok(html.includes('style="width:19%"'));
});

test("usageBarsHtml: no rows means the dedicated row stays hidden", () => {
  assert.equal(usageBarsHtml([]), "");
});

test("usageAvailable: only an openai-codex OAuth login shows the usage bars", () => {
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
