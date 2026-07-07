// Folds intermediate assistant narration into the activity timeline. A pi turn spans
// several API calls; each call that ended in tool use (stopReason "toolUse") streamed
// narration text that belongs BEFORE its tool steps — Claude-style chronological flow —
// not in the answer bubble. demoteAssistantText() moves the streamed bubble text into an
// immutable kind:"text" step at that boundary, so the timeline reads narration →
// generation checkpoint → tool steps …, and the bubble stays reserved for the turn's
// FINAL answer. Pure data ops + HTML-string builders, DOM-free (same contract as
// thinkingSteps.ts); callers own scheduleRender.
import { uid } from "./util";
import { renderMarkdown } from "./markdown";
import type { ActivityStep, UiMessage } from "./types";

/** Cap on a narration step's text so persisted views can't grow without bound. */
export const TEXT_STEP_MAX = 20_000;
const TRUNCATION_MARKER = "\n… [truncated]";

export function isTextStep(step: ActivityStep): boolean {
  return step.kind === "text";
}

/** Move the streamed bubble text into a kind:"text" timeline step (immutable once
 *  created) and reset the bubble for the next API call's deltas. `finalText` (from
 *  message_end's content) is authoritative over the accumulated deltas — it covers
 *  deltas lost to a reconnect. No-op step-wise when there is nothing to demote, but the
 *  bubble is always cleared so the next call starts fresh. */
export function demoteAssistantText(message: UiMessage, finalText: string): void {
  const text = (finalText || message.text).trim();
  message.text = "";
  if (!text) return;
  if (!message.activity) message.activity = { startedAt: Date.now(), endedAt: null, expanded: true, steps: [] };
  const steps = message.activity.steps;
  const prev = steps[steps.length - 1];
  const now = Date.now();
  steps.push({
    id: uid("text"),
    kind: "text",
    label: "",
    detail: "",
    status: "done",
    // The narration streamed between the previous step's end and now.
    startedAt: prev ? prev.endedAt ?? prev.startedAt : message.activity.startedAt,
    endedAt: now,
    text: text.length > TEXT_STEP_MAX ? text.slice(0, TEXT_STEP_MAX) + TRUNCATION_MARKER : text,
  });
}

/** Timeline row for a narration step: a markdown body on the rail, no label/chips. */
export function textStepRowHtml(step: ActivityStep): string {
  return (
    '<div class="tl-step tl-done tl-text"><span class="tl-node"></span>' +
    '<div class="tl-md">' +
    renderMarkdown(step.text || "") +
    "</div></div>"
  );
}
