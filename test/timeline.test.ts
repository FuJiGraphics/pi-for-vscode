import { test } from "node:test";
import assert from "node:assert/strict";
// Stubs MUST come before any webview module (the import chain reaches dom.ts).
import "./_bridgeStub";
import "./_domStub";
import { rowsForActivity, stepSig, timelineRowsHtml } from "../src/webview/timeline";
import type { Activity, ActivityStep } from "../src/webview/types";

function act(steps: ActivityStep[], startedAt = 1000): Activity {
  return { startedAt, endedAt: null, expanded: true, steps };
}

function tool(id: string, status: ActivityStep["status"] = "done"): ActivityStep {
  return { id, label: "Read", detail: "a.ts", status, startedAt: 1000, endedAt: status === "done" ? 2000 : undefined, tool: "read" };
}

test("rowsForActivity: stable keys/sigs across no-op derivations; a status flip changes only that row's sig", () => {
  const steps = [tool("t1"), tool("t2", "running")];
  const a = act(steps);
  const first = rowsForActivity(a, 0);
  const second = rowsForActivity(a, 0);
  assert.deepEqual(first.map((r) => [r.key, r.sig]), second.map((r) => [r.key, r.sig]));

  steps[1].status = "done";
  steps[1].endedAt = 3000;
  const third = rowsForActivity(a, 0);
  assert.equal(third[0].sig, first[0].sig); // untouched row keeps its sig
  assert.notEqual(third[1].sig, first[1].sig); // flipped row re-renders
  assert.equal(third[1].key, first[1].key); // …in place (same key)
});

test("rowsForActivity: NO cap — every step yields a row (regression for the 16-step slice)", () => {
  const steps = Array.from({ length: 40 }, (_, i) => tool("t" + i));
  const rows = rowsForActivity(act(steps), 0);
  assert.equal(rows.length, 40);
  assert.equal(rows[0].key, "t0"); // the earliest step is still present
});

test("rowsForActivity: todo steps consolidate into one row at the LAST todo position", () => {
  const todo = (id: string, subject: string): ActivityStep => ({
    id, label: "Update Todos", detail: "", status: "done", startedAt: 1, tool: "todo",
    input: { action: "create", subject, status: "pending" },
  });
  const rows = rowsForActivity(act([todo("td1", "first"), tool("t1"), todo("td2", "second")]), 0);
  assert.deepEqual(rows.map((r) => r.key), ["t1", "todos"]);
  assert.ok(rows[1].html().includes("Update Todos"));
});

test("rowsForActivity: the synthetic lead row is suppressed when thinking steps exist", () => {
  const thinkStep: ActivityStep = {
    id: "th1", kind: "thinking", label: "Thought for 2s", detail: "", status: "done",
    startedAt: 5000, endedAt: 7000, thinkingText: "hm",
  };
  const withThinking = rowsForActivity(act([thinkStep], 1000), 0);
  assert.ok(!withThinking.some((r) => r.key === "lead"));
  const withoutThinking = rowsForActivity(act([tool("t1", "done")], -5000), 0);
  assert.equal(withoutThinking[0].key, "lead"); // ≥1.5s before the first step → lead row
});

test("row html carries its data-key (full rebuilds and reconciles must match on it)", () => {
  const textStep: ActivityStep = {
    id: "txt1", kind: "text", label: "", detail: "", status: "done", startedAt: 1, endedAt: 2,
    text: "Narration **bold**",
  };
  const rows = rowsForActivity(act([textStep, tool("t1")]), 0);
  assert.ok(rows[0].html().startsWith('<div data-key="txt1" '));
  assert.ok(rows[0].html().includes("<strong>bold</strong>")); // markdown rendered
  assert.ok(rows[1].html().startsWith('<div data-key="t1" '));
  assert.equal(timelineRowsHtml(act([textStep]), 0).includes('data-key="txt1"'), true);
});

test("stepSig folds output presence, expansion, and text length — not the volatile thinkingText", () => {
  const step = tool("t1");
  const before = stepSig(step);
  step.output = { text: "out", isError: false };
  assert.notEqual(stepSig(step), before);

  const think: ActivityStep = { id: "th", kind: "thinking", label: "Thinking", detail: "", status: "running", startedAt: 1, thinkingText: "a" };
  const sigA = stepSig(think);
  think.thinkingText = "a much longer streamed reasoning text";
  assert.equal(stepSig(think), sigA); // volatile text never enters the sig
});
