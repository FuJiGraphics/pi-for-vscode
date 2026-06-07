import { test } from "node:test";
import assert from "node:assert/strict";
// Install the vscode-api stub BEFORE state→sessionStore→bridge is evaluated.
import "./_bridgeStub";
import { state } from "../src/webview/state";
import { bubbleHasContent, closeExchangeBoundary, finalizeOrPrune } from "../src/webview/turnBoundary";
import type { Activity, UiMessage } from "../src/webview/types";

function activity(steps = 0): Activity {
  return {
    startedAt: 0,
    endedAt: null,
    expanded: false,
    steps: Array.from({ length: steps }, (_, i) => ({ id: "s" + i, label: "", detail: "", status: "done" as const, startedAt: 0 })),
  };
}

function msg(partial: Partial<UiMessage>): UiMessage {
  return { id: "m", role: "assistant", text: "", createdAt: 0, ...partial };
}

function reset(messages: UiMessage[], currentId: string | null, running: boolean): void {
  state.messages = messages;
  state.currentAssistantId = currentId;
  state.running = running;
}

test("bubbleHasContent: empty → false; text or steps → true", () => {
  assert.equal(bubbleHasContent(undefined), false);
  assert.equal(bubbleHasContent(msg({ text: "" })), false);
  assert.equal(bubbleHasContent(msg({ text: "hi" })), true);
  assert.equal(bubbleHasContent(msg({ text: "", activity: activity(1) })), true);
});

test("closeExchangeBoundary: no-op when not running", () => {
  const a = msg({ id: "a", text: "done" });
  reset([a], "a", false);
  closeExchangeBoundary();
  assert.equal(state.currentAssistantId, "a"); // unchanged
});

test("closeExchangeBoundary: no-op on an empty current bubble (initial prompt's own user echo)", () => {
  const a = msg({ id: "a", text: "" });
  reset([a], "a", true);
  closeExchangeBoundary();
  assert.equal(state.currentAssistantId, "a"); // empty bubble kept as the response target
  assert.equal(state.messages.length, 1);
});

test("closeExchangeBoundary: detaches a content-bearing bubble so the next turn opens fresh", () => {
  const a = msg({ id: "a", text: "테스트 완료", revealed: 0, activity: activity(2) });
  reset([a], "a", true);
  closeExchangeBoundary();
  assert.equal(state.currentAssistantId, null); // detached
  assert.equal(state.messages.length, 1); // bubble kept (has content)
  assert.equal(a.revealed, "테스트 완료".length); // finalized (fully revealed)
  assert.notEqual(a.activity?.endedAt, null); // activity closed
});

test("finalizeOrPrune: removes a truly empty bubble and nulls the id", () => {
  const a = msg({ id: "a", text: "" });
  reset([a], "a", true);
  finalizeOrPrune();
  assert.equal(state.messages.length, 0);
  assert.equal(state.currentAssistantId, null);
});

test("finalizeOrPrune: keeps a text bubble AND its id (so a retry/compaction continuation reuses it)", () => {
  const a = msg({ id: "a", text: "answer", revealed: 0 });
  reset([a], "a", true);
  finalizeOrPrune();
  assert.equal(state.messages.length, 1);
  assert.equal(state.currentAssistantId, "a"); // id kept alive
  assert.equal(a.revealed, "answer".length);
});

test("finalizeOrPrune: keeps a tool-only bubble (steps but no text) — regression for the prune bug", () => {
  const a = msg({ id: "a", text: "", activity: activity(3) });
  reset([a], "a", true);
  finalizeOrPrune();
  assert.equal(state.messages.length, 1); // NOT pruned
  assert.equal(state.currentAssistantId, "a");
});
