import { test } from "node:test";
import assert from "node:assert/strict";
// Stubs MUST come before any webview module: _bridgeStub installs acquireVsCodeApi,
// _domStub installs document/requestAnimationFrame so dom.ts resolves at import.
import "./_bridgeStub";
import "./_domStub";
import { state, activateSession } from "../src/webview/state";
import { addMessage, hydrateSessionMessages, setRunning } from "../src/webview/conversation";
import { handleRpcEvent } from "../src/webview/handlers";
import { isThinkingStep } from "../src/webview/thinkingSteps";
import { messageRenderKey } from "../src/webview/render";

// Mimic the composer send path (input.ts submitInput): a prompt sent while idle detaches the
// previous bubble and OPTIMISTICALLY enters the working state (spinner shows instantly, before
// pi's agent_start round-trips back); a prompt sent mid-run keeps the bubble and leaves running
// alone (the message_start{user} boundary owns the split). Keep this in lockstep with submitInput.
function sendUser(text: string): void {
  const idle = !state.running;
  if (idle) state.currentAssistantId = null;
  addMessage("user", text);
  if (idle) setRunning(true);
}

const ev = {
  agentStart: () => ({ type: "agent_start" }),
  agentEnd: (willRetry?: boolean) => ({ type: "agent_end", willRetry }),
  turnStart: () => ({ type: "turn_start" }),
  turnEnd: () => ({ type: "turn_end" }),
  userStart: (content: string) => ({ type: "message_start", message: { role: "user", content } }),
  asstStart: () => ({ type: "message_start", message: { role: "assistant", content: "" } }),
  delta: (delta: string) => ({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } }),
  asstEnd: (content: string) => ({ type: "message_end", message: { role: "assistant", content } }),
  asstError: (errorMessage: string) => ({ type: "message_end", message: { role: "assistant", errorMessage } }),
  toolStart: (id: string, name: string) => ({ type: "tool_execution_start", toolCallId: id, toolName: name, args: {} }),
  toolEnd: (id: string, name: string) => ({ type: "tool_execution_end", toolCallId: id, toolName: name }),
  autoRetryStart: () => ({ type: "auto_retry_start", attempt: 1, maxAttempts: 5 }),
  autoRetryEnd: () => ({ type: "auto_retry_end", success: true }),
  compactionStart: () => ({ type: "compaction_start", reason: "overflow" }),
  compactionEnd: () => ({ type: "compaction_end" }),
  queueUpdate: (followUp: number, steering = 0) => ({
    type: "queue_update",
    followUp: Array.from({ length: followUp }, (_, i) => ({ role: "user", content: "f" + i })),
    steering: Array.from({ length: steering }, (_, i) => ({ role: "user", content: "s" + i })),
  }),
};

let sessionCounter = 0;
function fresh(): void {
  activateSession("seq-" + sessionCounter++);
  state.messages = [];
  state.currentAssistantId = null;
  state.running = false;
}

function replay(events: Array<Record<string, unknown>>): void {
  for (const event of events) handleRpcEvent(event);
}

function shape(): Array<[string, string]> {
  return state.messages.map((m) => [m.role, m.text]);
}

function assistants() {
  return state.messages.filter((m) => m.role === "assistant");
}

test("A. reported bug: follow-up reply lands BELOW its user message and does NOT overwrite turn 1", () => {
  fresh();
  sendUser("질문");
  replay([ev.agentStart(), ev.userStart("질문"), ev.delta("테스트"), ev.asstEnd("테스트 완료했습니다")]);
  sendUser("알았지?"); // mid-run follow-up (running === true here)
  replay([ev.userStart("알았지?"), ev.delta("응"), ev.asstEnd("응."), ev.agentEnd()]);

  assert.deepEqual(shape(), [
    ["user", "질문"],
    ["assistant", "테스트 완료했습니다"],
    ["user", "알았지?"],
    ["assistant", "응."],
  ]);
});

test("B. tool loop then text: one assistant bubble, activity steps preserved", () => {
  fresh();
  sendUser("do X");
  replay([
    ev.agentStart(), ev.userStart("do X"),
    ev.toolStart("t1", "read"), ev.toolEnd("t1", "read"),
    ev.delta("done"), ev.asstEnd("Done."), ev.agentEnd(),
  ]);
  assert.deepEqual(shape(), [["user", "do X"], ["assistant", "Done."]]);
  const a = assistants()[0];
  assert.ok((a.activity?.steps.length ?? 0) >= 1); // the read step survived
});

test("C. stacked follow-ups: each reply gets its own bubble, on-disk order preserved", () => {
  fresh();
  sendUser("u1");
  replay([ev.agentStart(), ev.userStart("u1"), ev.asstEnd("a1")]);
  sendUser("u2");
  replay([ev.userStart("u2"), ev.asstEnd("a2")]);
  sendUser("u3");
  replay([ev.userStart("u3"), ev.asstEnd("a3"), ev.agentEnd()]);
  assert.deepEqual(shape(), [
    ["user", "u1"], ["assistant", "a1"],
    ["user", "u2"], ["assistant", "a2"],
    ["user", "u3"], ["assistant", "a3"],
  ]);
});

test("D. retry stays in ONE bubble (agent_end{willRetry} → auto_retry → agent_start, no user msg)", () => {
  fresh();
  sendUser("go");
  replay([
    ev.agentStart(), ev.userStart("go"), ev.delta("partial"),
    ev.agentEnd(true), // willRetry: keep running + bubble
    ev.autoRetryStart(), ev.agentStart(), // continuation, no message_start{user}
    ev.delta("final"), ev.asstEnd("Final answer."), ev.agentEnd(),
  ]);
  assert.deepEqual(shape(), [["user", "go"], ["assistant", "Final answer."]]);
  assert.equal(assistants().length, 1);
  const steps = assistants()[0].activity?.steps ?? [];
  assert.ok(steps.some((s) => s.id === "auto-retry")); // retry shown in the timeline
});

test("E. compaction continuation stays in ONE bubble", () => {
  fresh();
  sendUser("big");
  replay([
    ev.agentStart(), ev.userStart("big"), ev.delta("working"),
    ev.agentEnd(), // terminal end; bubble kept (has content)
    ev.compactionStart(), ev.compactionEnd(),
    ev.agentStart(), // continuation, no user msg
    ev.delta("ok"), ev.asstEnd("OK."), ev.agentEnd(),
  ]);
  assert.deepEqual(shape(), [["user", "big"], ["assistant", "OK."]]);
  assert.equal(assistants().length, 1);
  const steps = assistants()[0].activity?.steps ?? [];
  assert.ok(steps.some((s) => s.id === "compaction"));
});

test("F. errored empty turn is pruned; a follow-up then answers below", () => {
  fresh();
  sendUser("x");
  replay([ev.agentStart(), ev.userStart("x"), ev.asstError("model exploded"), ev.agentEnd()]);
  sendUser("retry pls");
  replay([ev.agentStart(), ev.userStart("retry pls"), ev.delta("ok"), ev.asstEnd("OK."), ev.agentEnd()]);
  assert.deepEqual(shape(), [
    ["user", "x"],
    ["system", "model exploded"],
    ["user", "retry pls"],
    ["assistant", "OK."],
  ]);
});

test("G. tool-only turn (no final text) is NOT pruned — keeps its timeline", () => {
  fresh();
  sendUser("run");
  replay([
    ev.agentStart(), ev.userStart("run"),
    ev.toolStart("t1", "bash"), ev.toolEnd("t1", "bash"),
    ev.agentEnd(),
  ]);
  assert.equal(assistants().length, 1); // bubble survived despite empty text
  assert.ok((assistants()[0].activity?.steps.length ?? 0) >= 1);
});

test("H. optimistic spinner: a send while idle enters the working state IMMEDIATELY (before agent_start)", () => {
  fresh();
  sendUser("hi"); // no agent_start replayed — the spinner must already be live
  assert.equal(state.running, true);
  const a = assistants();
  assert.equal(a.length, 1);
  assert.equal(a[0].text, ""); // empty bubble = the spinner's target
  assert.equal(state.currentAssistantId, a[0].id);
  assert.deepEqual(shape(), [["user", "hi"], ["assistant", ""]]);
});

test("I. optimistic rollback: a rejected prompt (host posts running:false) prunes the empty bubble", () => {
  fresh();
  sendUser("oops");
  setRunning(false); // host's prompt() rolls the optimistic running back on RPC rejection
  assert.equal(state.running, false);
  assert.equal(assistants().length, 0); // empty optimistic bubble pruned, no orphan spinner
  assert.deepEqual(shape(), [["user", "oops"]]);
});

test("J. optimistic then real stream: agent_start is idempotent, no duplicate bubble", () => {
  fresh();
  sendUser("go"); // optimistic: running + empty A1
  const optimisticId = state.currentAssistantId;
  replay([ev.agentStart(), ev.userStart("go"), ev.delta("ok"), ev.asstEnd("OK."), ev.agentEnd()]);
  assert.deepEqual(shape(), [["user", "go"], ["assistant", "OK."]]);
  assert.equal(assistants().length, 1); // reused the optimistic bubble, did not stack a second
  assert.equal(assistants()[0].id, optimisticId);
});

const think = {
  start: () => ({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } }),
  delta: (delta: string) => ({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta } }),
  end: (partial?: unknown) => ({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, partial } }),
};

test("L. thinking deltas land in a timeline step and never pollute the bubble text", () => {
  fresh();
  sendUser("why?");
  replay([ev.agentStart(), ev.userStart("why?"), think.start(), think.delta("hmm "), think.delta("because")]);
  const a = assistants()[0];
  assert.equal(a.text, ""); // bubble untouched
  const steps = a.activity?.steps ?? [];
  assert.equal(steps.filter(isThinkingStep).length, 1);
  assert.equal(steps[0].thinkingText, "hmm because");
  assert.equal(steps[0].status, "running");
  replay([think.end(), ev.delta("Answer."), ev.asstEnd("Answer."), ev.agentEnd()]);
  assert.equal(steps[0].status, "done");
  assert.deepEqual(shape(), [["user", "why?"], ["assistant", "Answer."]]);
});

test("M. thinking and tool steps interleave in arrival order", () => {
  fresh();
  sendUser("do");
  replay([
    ev.agentStart(), ev.userStart("do"),
    think.start(), think.delta("plan"), think.end(),
    ev.toolStart("t1", "read"), ev.toolEnd("t1", "read"),
    think.start(), think.delta("verify"), think.end(),
    ev.asstEnd("Done."), ev.agentEnd(),
  ]);
  const kinds = (assistants()[0].activity?.steps ?? []).map((s) => (isThinkingStep(s) ? "think" : s.id));
  assert.deepEqual(kinds, ["think", "t1", "think"]);
});

test("N. idle guard: thinking events while not running are dropped", () => {
  fresh();
  replay([think.start(), think.delta("stray")]);
  assert.equal(state.messages.length, 0);
});

test("O. Stop mid-thinking finalizes the step with its partial text", () => {
  fresh();
  sendUser("go");
  replay([ev.agentStart(), ev.userStart("go"), think.start(), think.delta("cut off")]);
  setRunning(false); // Stop path
  const steps = assistants()[0].activity?.steps ?? [];
  assert.equal(steps[0].status, "done");
  assert.equal(steps[0].thinkingText, "cut off");
});

test("P. hydrate restores thinking blocks as collapsed steps (thinking-only message survives)", () => {
  fresh();
  hydrateSessionMessages([
    { role: "user", content: "q", timestamp: 1 },
    {
      role: "assistant",
      timestamp: 2,
      content: [
        { type: "thinking", thinking: "stored reasoning" },
        { type: "text", text: "answer" },
      ],
    },
    { role: "assistant", timestamp: 3, content: [{ type: "thinking", thinking: "[Reasoning redacted]", redacted: true }] },
  ]);
  assert.deepEqual(shape(), [["user", "q"], ["assistant", "answer"], ["assistant", ""]]);
  const first = assistants()[0].activity?.steps ?? [];
  assert.equal(first.length, 1);
  assert.equal(first[0].thinkingText, "stored reasoning");
  assert.equal(first[0].status, "done");
  const second = assistants()[1].activity?.steps ?? [];
  assert.equal(second[0].redacted, true);
});

test("Q. render-key stability: streaming thinking text does NOT change the structural key", () => {
  fresh();
  sendUser("k");
  replay([ev.agentStart(), ev.userStart("k"), think.start(), think.delta("a")]);
  const message = assistants()[0];
  const before = messageRenderKey(message);
  replay([think.delta("bcdefgh"), think.delta("more text streaming in")]);
  assert.equal(messageRenderKey(message), before); // deltas → same key, painter-only update
  replay([think.end()]);
  assert.notEqual(messageRenderKey(message), before); // status/label flip → one rebuild
});

test("K. queue_update drives the queued-sends count (steering + followUp) and clears on drain", () => {
  fresh();
  sendUser("u1");
  replay([ev.agentStart(), ev.userStart("u1")]);
  replay([ev.queueUpdate(2, 1)]); // 2 follow-ups + 1 steering still waiting
  assert.equal(state.status, "3 queued");
  replay([ev.queueUpdate(1)]);
  assert.equal(state.status, "1 queued");
  replay([ev.queueUpdate(0)]); // drained → pill hides
  assert.equal(state.status, "");
});
