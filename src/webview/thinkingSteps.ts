// Folds pi's thinking_* streaming events (message_update.assistantMessageEvent) into
// activity-timeline steps, and rebuilds thinking steps from persisted session content
// blocks. Pure and DOM-free — same contract as cardsTodo.ts — so it unit-tests directly.
//
// One step per thinking_start/…/thinking_end block; a turn can hold several, naturally
// interleaved with tool steps in steps[] arrival order. The accumulated text lives in
// step.thinkingText, which is VOLATILE for rendering: it must never enter the message
// render key (render.ts paints the live tail per frame instead).
import { uid, formatDuration } from "./util";
import type { Activity, ActivityStep } from "./types";

/** Cap on accumulated thinking text so persisted views can't grow without bound. */
export const THINKING_TEXT_MAX = 20_000;
const TRUNCATION_MARKER = "\n… [truncated]";
/** How much of the stream the live card paints (the latest tail). */
const LIVE_TAIL_CHARS = 1200;
const PREVIEW_CHARS = 48;

export function isThinkingStep(step: ActivityStep): boolean {
  return step.kind === "thinking";
}

/** The thinking block currently streaming, if any — derived from the activity (never
 *  module state) so background sessions can't leak into each other. */
export function lastRunningThinkingStep(activity: Activity | undefined): ActivityStep | undefined {
  if (!activity) return undefined;
  for (let i = activity.steps.length - 1; i >= 0; i--) {
    const step = activity.steps[i];
    if (step.kind === "thinking" && step.status === "running") return step;
  }
  return undefined;
}

function openStep(activity: Activity): ActivityStep {
  const step: ActivityStep = {
    id: uid("think"),
    kind: "thinking",
    label: "Thinking",
    detail: "",
    status: "running",
    startedAt: Date.now(),
    thinkingText: "",
  };
  activity.steps.push(step);
  return step;
}

function appendText(step: ActivityStep, delta: unknown): void {
  if (typeof delta !== "string" || !delta) return;
  const text = step.thinkingText || "";
  if (text.endsWith(TRUNCATION_MARKER)) return;
  if (text.length + delta.length > THINKING_TEXT_MAX) {
    step.thinkingText = text + delta.slice(0, Math.max(0, THINKING_TEXT_MAX - text.length)) + TRUNCATION_MARKER;
  } else {
    step.thinkingText = text + delta;
  }
}

// On thinking_end, prefer the authoritative block from the partial message over the
// accumulated deltas: it covers lost deltas (mid-stream reconnect) and carries the
// redacted flag for redacted_thinking blocks.
function adoptFinalBlock(step: ActivityStep, ev: { contentIndex?: number; partial?: unknown }): void {
  const content = (ev.partial as { content?: unknown } | undefined)?.content;
  const block = Array.isArray(content) && typeof ev.contentIndex === "number" ? content[ev.contentIndex] : undefined;
  if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "thinking") return;
  const b = block as { thinking?: unknown; redacted?: unknown };
  if (b.redacted === true) step.redacted = true;
  if (typeof b.thinking === "string" && b.thinking) {
    step.thinkingText =
      b.thinking.length > THINKING_TEXT_MAX ? b.thinking.slice(0, THINKING_TEXT_MAX) + TRUNCATION_MARKER : b.thinking;
  }
}

function closeStep(activity: Activity, step: ActivityStep): void {
  if (!step.thinkingText && !step.redacted) {
    // An empty start/end pair would render a meaningless "Thought for 0s" row.
    const at = activity.steps.indexOf(step);
    if (at !== -1) activity.steps.splice(at, 1);
    return;
  }
  step.status = "done";
  step.endedAt = Date.now();
  step.label = step.redacted ? "Thinking (redacted)" : "Thought for " + formatDuration(step.startedAt, step.endedAt);
}

/** Single entry point for handlers.ts: fold one thinking_* event into the activity. */
export function applyThinkingEvent(
  activity: Activity,
  ev: { type: string; delta?: string; contentIndex?: number; partial?: unknown },
): void {
  if (ev.type === "thinking_start") {
    openStep(activity);
    return;
  }
  if (ev.type === "thinking_delta") {
    // No open step (start lost to a reconnect) → create one lazily; duration is approximate.
    appendText(lastRunningThinkingStep(activity) ?? openStep(activity), ev.delta);
    return;
  }
  if (ev.type === "thinking_end") {
    const step = lastRunningThinkingStep(activity);
    if (!step) return;
    adoptFinalBlock(step, ev);
    closeStep(activity, step);
  }
}

/** Close any still-running thinking step with its partial text — called from the turn
 *  finalizer (Stop, agent_end, follow-up boundary) so no orphan pulsing row remains. */
export function closeOpenThinking(activity: Activity | undefined): void {
  if (!activity) return;
  // Snapshot: closeStep may prune empty steps out of the live array.
  for (const step of [...activity.steps]) {
    if (step.kind === "thinking" && step.status === "running") closeStep(activity, step);
  }
}

/** Rebuild a (collapsed, done) thinking step from a persisted session content block.
 *  The on-disk block has no timing data, so the label stays "Thinking". */
export function thinkingStepFromBlock(
  block: Record<string, unknown>,
  timestamp: number,
  blockIndex: number,
  messageIndex: number,
): ActivityStep {
  const redacted = block.redacted === true;
  const raw = typeof block.thinking === "string" ? block.thinking : "";
  return {
    id: "session-think-" + messageIndex + "-" + blockIndex + "-" + timestamp,
    kind: "thinking",
    label: redacted ? "Thinking (redacted)" : "Thinking",
    detail: "",
    status: "done",
    startedAt: timestamp,
    endedAt: timestamp,
    thinkingText: raw.length > THINKING_TEXT_MAX ? raw.slice(0, THINKING_TEXT_MAX) + TRUNCATION_MARKER : raw,
    redacted: redacted || undefined,
  };
}

/** One-line preview for the collapsed row ("first") and the status line ("last"). */
export function thinkingPreview(step: ActivityStep, mode: "first" | "last"): string {
  const lines = (step.thinkingText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return "";
  const line = mode === "first" ? lines[0] : lines[lines.length - 1];
  return line.length > PREVIEW_CHARS ? line.slice(0, PREVIEW_CHARS - 1) + "…" : line;
}

/** The latest slice of the stream for the live card (trimmed to a line start so the
 *  visible text doesn't open mid-word). */
export function liveThinkingTail(step: ActivityStep): string {
  const text = step.thinkingText || "";
  if (text.length <= LIVE_TAIL_CHARS) return text;
  const tail = text.slice(-LIVE_TAIL_CHARS);
  const newline = tail.indexOf("\n");
  return "… " + (newline !== -1 && newline < 200 ? tail.slice(newline + 1) : tail);
}
