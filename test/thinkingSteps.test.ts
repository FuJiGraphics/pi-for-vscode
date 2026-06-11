import { test } from "node:test";
import assert from "node:assert/strict";
import {
  THINKING_TEXT_MAX,
  applyThinkingEvent,
  closeOpenThinking,
  isThinkingStep,
  lastRunningThinkingStep,
  liveThinkingTail,
  thinkingPreview,
  thinkingStepFromBlock,
} from "../src/webview/thinkingSteps";
import { currentWork, statusTaskText } from "../src/webview/statusLine";
import { thinkingCardHtml } from "../src/webview/cardsThinking";
import type { Activity, ActivityStep, UiMessage } from "../src/webview/types";

function activity(): Activity {
  return { startedAt: Date.now(), endedAt: null, expanded: false, steps: [] };
}

function partialWith(thinking: string, redacted?: boolean) {
  return { content: [{ type: "thinking", thinking, ...(redacted ? { redacted: true } : {}) }] };
}

test("start → delta×N → end folds into one done step with accumulated text", () => {
  const a = activity();
  applyThinkingEvent(a, { type: "thinking_start" });
  applyThinkingEvent(a, { type: "thinking_delta", delta: "First " });
  applyThinkingEvent(a, { type: "thinking_delta", delta: "thought." });
  assert.equal(a.steps.length, 1);
  assert.equal(a.steps[0].status, "running");
  assert.equal(a.steps[0].thinkingText, "First thought.");
  applyThinkingEvent(a, { type: "thinking_end", contentIndex: 0 });
  assert.equal(a.steps[0].status, "done");
  assert.match(a.steps[0].label, /^Thought for \d+s$/);
  assert.ok(a.steps[0].endedAt);
});

test("a delta without a prior start lazily opens a step (lost start on reconnect)", () => {
  const a = activity();
  applyThinkingEvent(a, { type: "thinking_delta", delta: "late" });
  assert.equal(a.steps.length, 1);
  assert.equal(a.steps[0].kind, "thinking");
  assert.equal(a.steps[0].thinkingText, "late");
});

test("thinking_end adopts the authoritative partial block over accumulated deltas", () => {
  const a = activity();
  applyThinkingEvent(a, { type: "thinking_start" });
  applyThinkingEvent(a, { type: "thinking_delta", delta: "partial only" });
  applyThinkingEvent(a, { type: "thinking_end", contentIndex: 0, partial: partialWith("the full authoritative text") });
  assert.equal(a.steps[0].thinkingText, "the full authoritative text");
});

test("redacted thinking: flagged, labeled, body kept from pi's placeholder", () => {
  const a = activity();
  applyThinkingEvent(a, { type: "thinking_start" });
  applyThinkingEvent(a, {
    type: "thinking_end",
    contentIndex: 0,
    partial: partialWith("[Reasoning redacted]", true),
  });
  assert.equal(a.steps.length, 1);
  assert.equal(a.steps[0].redacted, true);
  assert.equal(a.steps[0].label, "Thinking (redacted)");
  assert.equal(a.steps[0].thinkingText, "[Reasoning redacted]");
});

test("an empty start/end pair is pruned (no 'Thought for 0s' ghost row)", () => {
  const a = activity();
  applyThinkingEvent(a, { type: "thinking_start" });
  applyThinkingEvent(a, { type: "thinking_end", contentIndex: 0 });
  assert.equal(a.steps.length, 0);
});

test("accumulation caps at THINKING_TEXT_MAX with a truncation marker", () => {
  const a = activity();
  applyThinkingEvent(a, { type: "thinking_start" });
  applyThinkingEvent(a, { type: "thinking_delta", delta: "x".repeat(THINKING_TEXT_MAX - 5) });
  applyThinkingEvent(a, { type: "thinking_delta", delta: "y".repeat(50) });
  const text = a.steps[0].thinkingText || "";
  assert.ok(text.includes("[truncated]"));
  assert.ok(text.length <= THINKING_TEXT_MAX + 20);
  const lengthAfterCap = text.length;
  applyThinkingEvent(a, { type: "thinking_delta", delta: "more" }); // ignored after the marker
  assert.equal((a.steps[0].thinkingText || "").length, lengthAfterCap);
});

test("closeOpenThinking finalizes running steps with partial text and leaves done steps alone", () => {
  const a = activity();
  applyThinkingEvent(a, { type: "thinking_start" });
  applyThinkingEvent(a, { type: "thinking_delta", delta: "cut off mid-stream" });
  const doneStep: ActivityStep = { id: "t1", label: "Read", detail: "", status: "done", startedAt: 1, endedAt: 2, tool: "read" };
  a.steps.push(doneStep);
  closeOpenThinking(a);
  assert.equal(a.steps[0].status, "done");
  assert.equal(a.steps[0].thinkingText, "cut off mid-stream");
  assert.equal(a.steps[1], doneStep);
  closeOpenThinking(undefined); // no-op, no throw
});

test("two blocks interleaved with a tool step keep arrival order and stay independent", () => {
  const a = activity();
  applyThinkingEvent(a, { type: "thinking_start" });
  applyThinkingEvent(a, { type: "thinking_delta", delta: "block one" });
  applyThinkingEvent(a, { type: "thinking_end", contentIndex: 0 });
  a.steps.push({ id: "t1", label: "Read", detail: "", status: "done", startedAt: 1, tool: "read" });
  applyThinkingEvent(a, { type: "thinking_start" });
  applyThinkingEvent(a, { type: "thinking_delta", delta: "block two" });
  assert.deepEqual(
    a.steps.map((s) => (isThinkingStep(s) ? s.thinkingText : s.tool)),
    ["block one", "read", "block two"],
  );
  assert.equal(lastRunningThinkingStep(a)?.thinkingText, "block two");
});

test("thinkingStepFromBlock rebuilds a collapsed done step (redacted included)", () => {
  const s = thinkingStepFromBlock({ type: "thinking", thinking: "stored reasoning" }, 1000, 0, 3);
  assert.equal(s.kind, "thinking");
  assert.equal(s.status, "done");
  assert.equal(s.label, "Thinking");
  assert.equal(s.thinkingText, "stored reasoning");
  assert.equal(s.startedAt, 1000);
  assert.equal(s.endedAt, 1000);
  const r = thinkingStepFromBlock({ type: "thinking", thinking: "[Reasoning redacted]", redacted: true }, 1000, 1, 3);
  assert.equal(r.redacted, true);
  assert.equal(r.label, "Thinking (redacted)");
});

test("thinkingPreview: first/last line, trimmed and capped", () => {
  const s = thinkingStepFromBlock({ type: "thinking", thinking: "  first line  \n\n  last line  " }, 1, 0, 0);
  assert.equal(thinkingPreview(s, "first"), "first line");
  assert.equal(thinkingPreview(s, "last"), "last line");
  const long = thinkingStepFromBlock({ type: "thinking", thinking: "z".repeat(100) }, 1, 0, 0);
  assert.ok(thinkingPreview(long, "first").length <= 48);
  assert.ok(thinkingPreview(long, "first").endsWith("…"));
});

test("liveThinkingTail returns the latest slice, trimmed to a line start", () => {
  const short = thinkingStepFromBlock({ type: "thinking", thinking: "short" }, 1, 0, 0);
  assert.equal(liveThinkingTail(short), "short");
  const lines = Array.from({ length: 100 }, (_, i) => "line number " + i).join("\n");
  const long = thinkingStepFromBlock({ type: "thinking", thinking: lines }, 1, 0, 0);
  const tail = liveThinkingTail(long);
  assert.ok(tail.startsWith("… "));
  assert.ok(tail.length <= 1210);
  assert.ok(tail.includes("line number 99"));
});

test("currentWork: running thinking → 'Thinking…' + last line; running tool wins when later", () => {
  const think: ActivityStep = {
    id: "th", kind: "thinking", label: "Thinking", detail: "", status: "running", startedAt: 1,
    thinkingText: "pondering the plan\nnow reading code",
  };
  assert.deepEqual(currentWork([think]), { label: "Thinking…", detail: "now reading code" });
  const tool: ActivityStep = { id: "t", label: "Read", detail: "", status: "running", startedAt: 2, tool: "read", input: { path: "src/a/b.ts" } };
  assert.deepEqual(currentWork([think, tool]), { label: "Read", detail: "b.ts" });
  assert.equal(currentWork([]), null);
});

test("statusTaskText falls back to the step count when nothing is running", () => {
  const message = (steps: ActivityStep[]): UiMessage => ({
    id: "m", role: "assistant", text: "", createdAt: 0,
    activity: { startedAt: 0, endedAt: null, expanded: false, steps },
  });
  const done: ActivityStep = { id: "d", label: "Read", detail: "", status: "done", startedAt: 1, tool: "read" };
  assert.equal(statusTaskText(message([done])), "1 step");
  assert.equal(statusTaskText(message([done, { ...done, id: "d2" }])), "2 steps");
  assert.equal(statusTaskText({ id: "m", role: "assistant", text: "", createdAt: 0 }), "");
});

test("thinkingCardHtml: live shows the tail, done shows full text + expand, html escaped", () => {
  const running: ActivityStep = {
    id: "th", kind: "thinking", label: "Thinking", detail: "", status: "running", startedAt: 1,
    thinkingText: "<b>live</b>",
  };
  const live = thinkingCardHtml(running);
  assert.match(live, /tl-thinking live/);
  assert.match(live, /&lt;b&gt;live&lt;\/b&gt;/);
  assert.ok(!live.includes("tl-expand")); // expand overlay only once done
  const done = thinkingCardHtml({ ...running, status: "done", thinkingText: "final reasoning" });
  assert.match(done, /tl-thinking/);
  assert.ok(!done.includes(" live"));
  assert.match(done, /data-action="expand-card"/);
  assert.match(done, /final reasoning/);
  assert.equal(thinkingCardHtml({ ...running, thinkingText: "" }), ""); // nothing to show yet
});
