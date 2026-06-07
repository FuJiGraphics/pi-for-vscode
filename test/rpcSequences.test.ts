import { test } from "node:test";
import assert from "node:assert/strict";
// Stubs MUST come before any webview module: _bridgeStub installs acquireVsCodeApi,
// _domStub installs document/requestAnimationFrame so dom.ts resolves at import.
import "./_bridgeStub";
import "./_domStub";
import { state, activateSession } from "../src/webview/state";
import { addMessage } from "../src/webview/conversation";
import { handleRpcEvent } from "../src/webview/handlers";

// Mimic the composer send path (input.ts submitInput): a prompt sent while idle detaches the
// previous bubble; a prompt sent mid-run keeps it (the message_start{user} boundary handles it).
function sendUser(text: string): void {
  if (!state.running) state.currentAssistantId = null;
  addMessage("user", text);
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
