import { test } from "node:test";
import assert from "node:assert/strict";
import { diffStatsFor, parsePiDiff } from "../src/webview/diffStats";
import type { ActivityStep } from "../src/webview/types";

function step(partial: Partial<ActivityStep>): ActivityStep {
  return { id: "s", label: "", detail: "", status: "done", startedAt: 0, ...partial };
}

test("parsePiDiff: numbered sign rows; unmatched lines fall back to neutral context", () => {
  const rows = parsePiDiff(" 92 ctx\n-93 removed\n+97 added\nodd line");
  assert.deepEqual(rows.map((r) => [r.sign, r.lineNo]), [[" ", "92"], ["-", "93"], ["+", "97"], [" ", ""]]);
});

test("diffStatsFor edit: pi's real diff counts exactly (context lines excluded)", () => {
  const s = step({
    tool: "edit",
    input: { edits: [{ oldText: "a", newText: "b\nc\nd" }] }, // estimate would be +3 -1
    output: { text: "ok", isError: false, diff: " 1 ctx\n-2 gone\n-3 gone\n+2 new\n 4 ctx" },
  });
  assert.deepEqual(diffStatsFor(s), { added: 1, removed: 2 }); // real diff wins over args
});

test("diffStatsFor edit (pre-enrichment): estimates from the args' line counts", () => {
  const s = step({ tool: "edit", input: { edits: [{ oldText: "x\ny", newText: "z" }, { oldText: "", newText: "p\nq" }] } });
  assert.deepEqual(diffStatsFor(s), { added: 3, removed: 2 });
  // JSON-string-encoded edits (some models) still count.
  const enc = step({ tool: "edit", input: { edits: '[{"oldText":"a","newText":"b\\nc"}]' } });
  assert.deepEqual(diffStatsFor(enc), { added: 2, removed: 1 });
});

test("diffStatsFor write: content lines all count as added", () => {
  assert.deepEqual(diffStatsFor(step({ tool: "write", input: { content: "l1\nl2\nl3" } })), { added: 3, removed: 0 });
  assert.equal(diffStatsFor(step({ tool: "write", input: {} })), undefined);
});

test("diffStatsFor: other tools and arg-less edits have no stats", () => {
  assert.equal(diffStatsFor(step({ tool: "bash", input: { command: "ls" } })), undefined);
  assert.equal(diffStatsFor(step({ tool: "read", input: { path: "x" } })), undefined);
  assert.equal(diffStatsFor(step({ tool: "edit", input: {} })), undefined);
});
