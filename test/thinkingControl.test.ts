import { test } from "node:test";
import assert from "node:assert/strict";
// Stubs MUST come before any webview module (the import chain reaches dom.ts).
import "./_bridgeStub";
import "./_domStub";
import { supportedThinkingLevels, thinkingPanelHtml } from "../src/webview/thinkingControl";

test("supportedThinkingLevels mirrors pi: non-reasoning → none; null-mapped excluded; xhigh only when explicitly mapped", () => {
  assert.deepEqual(supportedThinkingLevels(undefined), []);
  assert.deepEqual(supportedThinkingLevels({ reasoning: false }), []);
  // Reasoning model with no map: everything EXCEPT xhigh (pi clamps unmapped xhigh down —
  // regression for the old main.ts logic that offered it anyway).
  assert.deepEqual(supportedThinkingLevels({ reasoning: true }), ["off", "minimal", "low", "medium", "high"]);
  // Explicit xhigh mapping unlocks it.
  assert.deepEqual(
    supportedThinkingLevels({ reasoning: true, thinkingLevelMap: { xhigh: "max" } }),
    ["off", "minimal", "low", "medium", "high", "xhigh"],
  );
  // A level mapped to null is excluded.
  assert.deepEqual(
    supportedThinkingLevels({ reasoning: true, thinkingLevelMap: { high: null } }),
    ["off", "minimal", "low", "medium"],
  );
});

test("thinkingPanelHtml lists all six levels, marks current and unsupported rows", () => {
  const html = thinkingPanelHtml(["off", "minimal", "low", "medium", "high"], "high");
  // Six rows always render (unsupported ones teach the control's range).
  assert.equal((html.match(/thinking-option/g) || []).length >= 6, true);
  assert.ok(html.includes('class="thinking-option current"') || html.includes(' current"'));
  assert.ok(html.includes("unsupported")); // xhigh row disabled
  assert.ok(html.includes('data-level="medium"'));
  assert.equal(html.includes('data-level="xhigh"'), false); // unsupported rows are not clickable
  assert.ok(html.includes("Thorough reasoning"));
});
