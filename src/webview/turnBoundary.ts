// How the conversation is split into assistant bubbles.
//
// A bubble is NOT "one agent run" — pi keeps follow-up/steer messages inside the SAME run and
// splits retries/compaction across MULTIPLE runs. The correct unit is one LOGICAL exchange,
// delimited by user messages: pi emits `message_start{message.role:"user"}` for the initial
// prompt, every steering message, and every follow-up (agent-loop.js L50-52, L95-98). This
// module owns that single concern, kept DOM-free so it is unit-testable under Node.
import { state } from "./state";
import type { UiMessage } from "./types";

function find(id: string | null): UiMessage | undefined {
  return id ? state.messages.find((message) => message.id === id) : undefined;
}

/** A bubble "has content" once it holds streamed text OR any activity step. */
export function bubbleHasContent(message: UiMessage | undefined): boolean {
  return !!message && (message.text.length > 0 || (message.activity?.steps.length ?? 0) > 0);
}

function finalize(message: UiMessage): void {
  message.revealed = message.text.length;
  if (message.activity && !message.activity.endedAt) message.activity.endedAt = Date.now();
}

// A `message_start{role:"user"}` arrived: a new logical exchange begins. If the current bubble
// already holds content (the previous turn's text/timeline), finalize it and DETACH
// (currentAssistantId = null) so the next assistant content opens a FRESH bubble BELOW the
// user message that the composer already added locally. An empty current bubble is the initial
// prompt's own user-message echo (fires right after agent_start) → no-op. Two stacked user
// messages with no assistant content between them also no-op (the second finds an empty bubble).
export function closeExchangeBoundary(): void {
  if (!state.running) return;
  const message = find(state.currentAssistantId);
  if (!bubbleHasContent(message)) return;
  finalize(message as UiMessage);
  state.currentAssistantId = null;
}

// Called on agent_end / setRunning(false). An empty bubble (no text, no timeline, not
// interrupted) is removed; otherwise the bubble is finalized but its id is KEPT so a
// retry/compaction continuation (a fresh agent_start with NO intervening user message_start)
// reuses the SAME bubble instead of fragmenting. The kept id is later cleared by submitInput's
// idle-reset (a new prompt) or by closeExchangeBoundary (a follow-up/steer). Keeping the id
// across an idle gap is harmless: pi emits no events while idle.
export function finalizeOrPrune(): void {
  const id = state.currentAssistantId;
  if (!id) return;
  const message = find(id);
  if (!message) {
    state.currentAssistantId = null;
    return;
  }
  // Keep tool-only turns (steps but no final text) — only a truly empty bubble is pruned.
  const empty = !message.text && !message.interrupted && !(message.activity?.steps.length);
  if (empty) {
    state.messages = state.messages.filter((item) => item.id !== id);
    state.currentAssistantId = null;
  } else {
    finalize(message);
  }
}
