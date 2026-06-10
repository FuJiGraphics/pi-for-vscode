// Operations over the conversation: appending messages, tracking the active
// assistant turn, recording tool activity, and hydrating a session's history.
import { state } from "./state";
import { scheduleRender } from "./render";
import { ensureAnimating } from "./animator";
import { finalizeOrPrune } from "./turnBoundary";
import { uid } from "./util";
import { effectiveExpanded } from "./cards";
import { thinkingStepFromBlock } from "./thinkingSteps";
import type { Activity, ActivityStep, UiImageAttachment, UiMessage, UiPrompt, UiRole } from "./types";

export function getMessage(id: string | null | undefined): UiMessage | undefined {
  if (!id) return undefined;
  return state.messages.find((message) => message.id === id);
}

interface AddMessageOptions {
  id?: string;
  pre?: boolean;
  error?: boolean;
  createdAt?: number;
  attachments?: UiImageAttachment[];
  activity?: Activity;
  ui?: UiPrompt;
}

export function addMessage(role: UiRole, text: string, options: AddMessageOptions = {}): UiMessage {
  const message: UiMessage = {
    id: options.id || uid(role),
    role,
    text: text || "",
    pre: !!options.pre,
    error: !!options.error,
    createdAt: options.createdAt || Date.now(),
    attachments: options.attachments,
    activity: options.activity,
    ui: options.ui,
  };
  // Always append in chronological order — the same order pi records to the session file
  // (user1, assistant1, user2, assistant2, …). A follow-up sent mid-turn therefore lands
  // BELOW the still-running turn's indicator/timeline, and when its queued turn starts the
  // new assistant message appears right under it. (An earlier heuristic spliced follow-ups
  // ABOVE the running assistant to pin the indicator at the bottom, but that put later
  // messages above earlier turns and diverged from the on-disk order — see round 7.)
  state.messages.push(message);
  scheduleRender();
  return message;
}

export function ensureAssistant(): UiMessage {
  if (state.currentAssistantId) {
    const existing = getMessage(state.currentAssistantId);
    if (existing) return existing;
  }
  // Activities default EXPANDED: the work stays visible after the turn completes (the
  // header toggle collapses it) — "all steps visible" is the design baseline.
  const message = addMessage("assistant", "", {
    activity: state.running ? { startedAt: Date.now(), endedAt: null, expanded: true, steps: [] } : undefined,
  });
  message.revealed = 0;
  state.currentAssistantId = message.id;
  return message;
}

export function ensureActivity(): Activity {
  const message = ensureAssistant();
  if (!message.activity) message.activity = { startedAt: Date.now(), endedAt: null, expanded: true, steps: [] };
  return message.activity;
}

export function prettifyToolName(name: unknown): string {
  const raw = String(name || "tool");
  const lower = raw.toLowerCase();
  // Terse Claude-style verbs (paired with the file/command detail in the timeline).
  // Most specific first — these bundled tools would otherwise collapse into Search/Fetch.
  if (lower === "todo") return "Update Todos";
  if (lower === "web_search") return "Web Search";
  if (lower === "code_search") return "Code Search";
  if (lower === "fetch_content" || lower.includes("fetch")) return "Fetch";
  if (lower === "get_search_content") return "Web Content";
  if (lower.includes("read") || lower.includes("cat")) return "Read";
  if (lower === "write" || lower.includes("create")) return "Write";
  if (lower.includes("edit") || lower.includes("write") || lower.includes("apply")) return "Edit";
  if (lower.includes("bash") || lower.includes("shell") || lower.includes("exec") || lower.includes("run")) return "Bash";
  if (lower.includes("grep") || lower.includes("search") || lower.includes("glob") || lower.includes("find")) return "Search";
  if (lower.includes("web")) return "Web";
  if (lower.includes("ls") || lower.includes("list")) return "List";
  return raw
    .replace(/[_-]+/g, " ")
    .split(" ")
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(" ");
}

export function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  const keys = ["path", "file", "filePath", "command", "query", "pattern"];
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

// Accumulate pi's per-API-call token usage (from a message_end's `message.usage`) and add a
// per-generation checkpoint node to the turn's timeline. A model call (generation) is the
// thing that actually spends tokens — tool steps don't — so the usage is shown at that node.
// No-op when usage is absent.
export function recordUsage(usage: unknown): void {
  if (!usage || typeof usage !== "object") return;
  const u = usage as { totalTokens?: unknown; cost?: { total?: unknown } };
  const tokens = typeof u.totalTokens === "number" && Number.isFinite(u.totalTokens) ? u.totalTokens : 0;
  const cost = u.cost && typeof u.cost.total === "number" && Number.isFinite(u.cost.total) ? u.cost.total : 0;
  if (!tokens && !cost) return;
  state.sessionTokens += tokens;
  state.sessionCost += cost;
  const message = state.currentAssistantId ? getMessage(state.currentAssistantId) : undefined;
  if (message) {
    // Turn total (shown on the collapsed activity header).
    message.tokens = (message.tokens || 0) + tokens;
    message.cost = (message.cost || 0) + cost;
    // Per-generation checkpoint in the expanded timeline.
    const activity = ensureActivity();
    const now = Date.now();
    activity.steps.push({
      id: uid("gen"),
      label: "Generated",
      detail: "",
      status: "done",
      startedAt: now,
      endedAt: now,
      tokens,
      cost,
      kind: "generation",
    });
  }
  scheduleRender();
}

export function recordActivity(
  id: string,
  label: string,
  detail: string,
  status: ActivityStep["status"],
  input?: Record<string, unknown>,
  tool?: string,
): void {
  const activity = ensureActivity();
  const stepId = id || uid("step");
  let step = activity.steps.find((item) => item.id === stepId);
  if (!step) {
    step = { id: stepId, label, detail: detail || "", status: status || "running", startedAt: Date.now(), input, tool };
    activity.steps.push(step);
  } else {
    step.label = label || step.label;
    step.detail = detail || step.detail;
    step.status = status || step.status;
    if (input && !step.input) step.input = input;
    if (tool && !step.tool) step.tool = tool;
    if (status === "done" || status === "error") step.endedAt = Date.now();
  }
  scheduleRender();
}

// Mark the in-flight turn as interrupted (user pressed Stop) so an inline "Interrupted"
// marker renders below it. No-op when nothing is running.
export function interruptCurrentTurn(): void {
  if (!state.running) return;
  const message = state.currentAssistantId ? getMessage(state.currentAssistantId) : undefined;
  if (message) {
    message.interrupted = true;
    scheduleRender();
  }
}

export function findStep(stepId: string): ActivityStep | undefined {
  for (const message of state.messages) {
    const step = message.activity?.steps.find((s) => s.id === stepId);
    if (step) return step;
  }
  return undefined;
}

// Attach a finished tool's output (enriched from the session file) to its timeline step.
export function recordToolOutput(
  toolCallId: string,
  output: { text: string; isError: boolean; diff?: string; firstChangedLine?: number },
): void {
  const step = findStep(toolCallId);
  if (step) {
    step.output = output;
    scheduleRender();
  }
}

// Expand/collapse a step's output/diff card. Flip the EFFECTIVE state (explicit toggle or the
// per-tool default) so the first click on a default-open card actually closes it, rather than
// flipping an `undefined` to `true` and visibly doing nothing.
export function toggleActivityStep(stepId: string): void {
  const step = findStep(stepId);
  if (step) {
    step.expanded = !effectiveExpanded(step);
    scheduleRender();
  }
}

export function appendAssistant(delta: string): void {
  const message = ensureAssistant();
  message.text += delta;
  ensureAnimating();
  scheduleRender();
}

function idleStatus(): string {
  // The status line is reserved for transient, meaningful state (e.g. queued
  // follow-ups). It is NOT used for a "Pi is working" label — the thinking/activity
  // indicator already conveys that — so when idle it stays empty and render() hides it.
  return "";
}

export function setRunning(value: boolean): void {
  const next = !!value;
  if (next === state.running) {
    // Idempotent "stop" (e.g. a trailing agent_end after the spinner already cleared): still
    // finalize the current bubble so a half-typed turn settles.
    if (!next && state.currentAssistantId) {
      finalizeOrPrune();
      state.status = idleStatus();
    }
    scheduleRender();
    return;
  }
  state.running = next;
  if (next) {
    // No "Pi is working" label — the thinking/activity indicator conveys it. Leave the
    // status line empty unless a real status (e.g. queued follow-ups) is posted.
    state.status = "";
    ensureActivity();
    ensureAnimating();
  } else {
    state.status = idleStatus();
    // Finalize the bubble; an empty one is pruned. A content-bearing bubble KEEPS its id so a
    // retry/compaction continuation (a fresh agent_start with no user message between) reuses
    // it. The id is cleared instead by a new prompt (submitInput) or a follow-up boundary.
    finalizeOrPrune();
  }
  scheduleRender();
}

export function textFromContent(content: unknown, includeImages = false): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const b = block as Record<string, unknown>;
      if (b.type === "text") return (b.text as string) || "";
      if (includeImages && b.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join(String.fromCharCode(10));
}

function imageAttachmentFromBlock(block: Record<string, unknown>, index: number): UiImageAttachment | undefined {
  if (block.type !== "image") return undefined;

  let data = typeof block.data === "string" ? block.data : "";
  let mimeType = typeof block.mimeType === "string" ? block.mimeType : "";
  const source = block.source && typeof block.source === "object" ? block.source as Record<string, unknown> : undefined;
  if (!data && source?.type === "base64" && typeof source.data === "string") data = source.data;
  if (!mimeType && source?.type === "base64" && typeof source.media_type === "string") mimeType = source.media_type;

  data = data.trim();
  mimeType = mimeType.trim().toLowerCase();
  if (!data || !mimeType.startsWith("image/")) return undefined;
  const extension = mimeType.split("/")[1] || "image";
  return {
    id: "session-image-" + index + "-" + data.slice(0, 10),
    name: "image." + extension,
    data,
    mimeType,
  };
}

function imageAttachmentsFromContent(content: unknown): UiImageAttachment[] {
  if (!Array.isArray(content)) return [];
  return content
    .map((block, index) => block && typeof block === "object" ? imageAttachmentFromBlock(block as Record<string, unknown>, index) : undefined)
    .filter((attachment): attachment is UiImageAttachment => Boolean(attachment));
}

export function sessionMessageToUi(message: any, index: number): UiMessage | null {
  if (!message || typeof message !== "object") return null;
  const timestamp = typeof message.timestamp === "number" ? message.timestamp : Date.now();
  if (message.role === "user") {
    const text = textFromContent(message.content, false).trim();
    const attachments = imageAttachmentsFromContent(message.content);
    return text || attachments.length > 0
      ? { id: "session-user-" + index + "-" + timestamp, role: "user", text, attachments, createdAt: timestamp }
      : null;
  }
  if (message.role === "assistant") {
    const text = textFromContent(message.content, false).trim();
    // Rebuild thinking blocks as collapsed timeline steps so reopened sessions keep them.
    const thinkingSteps: ActivityStep[] = Array.isArray(message.content)
      ? (message.content as unknown[])
          .filter((b): b is Record<string, unknown> => !!b && typeof b === "object" && (b as { type?: unknown }).type === "thinking")
          .map((b, i) => thinkingStepFromBlock(b, timestamp, i, index))
          .filter((s) => s.thinkingText || s.redacted)
      : [];
    if (!text && thinkingSteps.length === 0) return null;
    return {
      id: "session-assistant-" + index + "-" + timestamp,
      role: "assistant",
      text,
      createdAt: timestamp,
      activity: thinkingSteps.length
        ? { startedAt: timestamp, endedAt: timestamp, expanded: false, steps: thinkingSteps }
        : undefined,
    };
  }
  if (message.role === "custom" && message.display) {
    const text = textFromContent(message.content, true).trim();
    return text ? { id: "session-custom-" + index + "-" + timestamp, role: "system", text, createdAt: timestamp } : null;
  }
  if (message.role === "compactionSummary" && message.summary) {
    return {
      id: "session-summary-" + index + "-" + timestamp,
      role: "system",
      text: "Compacted context: " + message.summary,
      createdAt: timestamp,
    };
  }
  return null;
}

export function hydrateSessionMessages(messages: unknown): void {
  const converted = Array.isArray(messages)
    ? messages.map((m, i) => sessionMessageToUi(m, i)).filter((m): m is UiMessage => Boolean(m))
    : [];
  state.messages = converted;
  state.currentAssistantId = null;
  scheduleRender();
}
