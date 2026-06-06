// Operations over the conversation: appending messages, tracking the active
// assistant turn, recording tool activity, and hydrating a session's history.
import { state } from "./state";
import { scheduleRender } from "./render";
import { ensureAnimating } from "./animator";
import { uid } from "./util";
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
  state.messages.push(message);
  scheduleRender();
  return message;
}

export function ensureAssistant(): UiMessage {
  if (state.currentAssistantId) {
    const existing = getMessage(state.currentAssistantId);
    if (existing) return existing;
  }
  const message = addMessage("assistant", "", {
    activity: state.running ? { startedAt: Date.now(), endedAt: null, expanded: false, steps: [] } : undefined,
  });
  message.revealed = 0;
  state.currentAssistantId = message.id;
  return message;
}

export function ensureActivity(): Activity {
  const message = ensureAssistant();
  if (!message.activity) message.activity = { startedAt: Date.now(), endedAt: null, expanded: false, steps: [] };
  return message.activity;
}

export function prettifyToolName(name: unknown): string {
  const raw = String(name || "tool");
  const lower = raw.toLowerCase();
  if (lower.includes("read")) return "Reading files";
  if (lower.includes("edit") || lower.includes("write")) return "Updating files";
  if (lower.includes("bash") || lower.includes("shell")) return "Running command";
  if (lower.includes("grep") || lower.includes("search")) return "Searching workspace";
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

export function recordActivity(id: string, label: string, detail: string, status: ActivityStep["status"]): void {
  const activity = ensureActivity();
  const stepId = id || uid("step");
  let step = activity.steps.find((item) => item.id === stepId);
  if (!step) {
    step = { id: stepId, label, detail: detail || "", status: status || "running", startedAt: Date.now() };
    activity.steps.push(step);
  } else {
    step.label = label || step.label;
    step.detail = detail || step.detail;
    step.status = status || step.status;
    if (status === "done" || status === "error") step.endedAt = Date.now();
  }
  scheduleRender();
}

export function appendAssistant(delta: string): void {
  const message = ensureAssistant();
  message.text += delta;
  ensureAnimating();
  scheduleRender();
}

function idleStatus(): string {
  // The status line is reserved for transient work state ("Pi is working",
  // queued follow-ups). When idle it stays empty so render() can hide it —
  // the model name already lives on the composer's model button.
  return "";
}

export function setRunning(value: boolean): void {
  const next = !!value;
  if (next === state.running) {
    if (!next && state.currentAssistantId) {
      const message = getMessage(state.currentAssistantId);
      if (message && !message.text) state.messages = state.messages.filter((item) => item.id !== message.id);
      else if (message) message.revealed = message.text.length;
      state.currentAssistantId = null;
      state.status = idleStatus();
    }
    scheduleRender();
    return;
  }
  state.running = next;
  if (next) {
    state.status = "Pi is working";
    ensureActivity();
    ensureAnimating();
  } else {
    state.status = idleStatus();
    const message = state.currentAssistantId ? getMessage(state.currentAssistantId) : undefined;
    if (message && !message.text) {
      state.messages = state.messages.filter((item) => item.id !== message.id);
    } else if (message) {
      message.revealed = message.text.length;
      if (message.activity && !message.activity.endedAt) message.activity.endedAt = Date.now();
    }
    state.currentAssistantId = null;
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
    return text
      ? { id: "session-assistant-" + index + "-" + timestamp, role: "assistant", text, createdAt: timestamp }
      : null;
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
