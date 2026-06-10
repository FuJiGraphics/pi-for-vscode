import { test } from "node:test";
import assert from "node:assert/strict";
// Stubs MUST come before any webview module (contextChip's import chain reaches dom.ts).
import "./_bridgeStub";
import "./_domStub";
import { contextReference, formatContextLabel, resetContextInclude, toggleContextInclude, updateEditorContext } from "../src/webview/contextChip";

test("formatContextLabel: file, single line, and line range", () => {
  assert.equal(formatContextLabel({}), "");
  assert.equal(formatContextLabel({ path: "src/main.ts" }), "src/main.ts");
  assert.equal(formatContextLabel({ path: "src/main.ts", startLine: 12, endLine: 12 }), "src/main.ts:12");
  assert.equal(formatContextLabel({ path: "src/main.ts", startLine: 12, endLine: 34 }), "src/main.ts:12-34");
});

test("contextReference is empty until the chip is toggled on, then tracks the editor", () => {
  updateEditorContext({ path: "src/a.ts", startLine: 3, endLine: 9 });
  assert.equal(contextReference(), ""); // default OFF
  toggleContextInclude();
  assert.equal(contextReference(), "src/a.ts:3-9");
  updateEditorContext({ path: "src/b.ts" }); // selection cleared, file switched — stays on
  assert.equal(contextReference(), "src/b.ts");
  updateEditorContext({}); // no usable editor → nothing to attach even while on
  assert.equal(contextReference(), "");
  toggleContextInclude(); // back off for any later test
});

test("switching sessions detaches the reference (attach was a per-conversation decision)", () => {
  updateEditorContext({ path: "src/a.ts" });
  toggleContextInclude();
  assert.equal(contextReference(), "src/a.ts");
  resetContextInclude(); // main.ts activate handler fires this on a REAL session change
  assert.equal(contextReference(), "");
  resetContextInclude(); // idempotent when already off
  assert.equal(contextReference(), "");
});
