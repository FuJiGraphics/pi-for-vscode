// Two-tier rendering:
//   render()          — STRUCTURAL. Rebuilds a message node's innerHTML only when
//                       its structural key changes (role, has-text, live, step
//                       signature, ui). Triggered via scheduleRender() on real
//                       state changes (deltas, tool steps, completion).
//   paintLiveMessage() — PER-FRAME. Updates only the volatile leaf nodes of the
//                       active message in place — the streaming bubble text/cursor
//                       and the spinner glyph/word/seconds — WITHOUT touching the
//                       activity block or buttons. Driven by the animator loop.
// This split is what keeps hover/toggle stable: the activity DOM is never rebuilt
// at 60fps, so :hover state and click targets survive.
import { state, save } from "./state";
import { messagesEl, statusEl, titleEl, thinkingControlEl, modelEl, stopEl, composerEl, sendEl, inputEl } from "./dom";
import { escapeHtml, renderMarkdown, formatTime, formatDuration, roleLabel } from "./util";
import { thinkingLabel } from "./spinner";
import { piMarkHtml } from "./piMark";
import { pixelWordHtml } from "./pixelFont";
import { applyLatestScroll, shouldFollowLatest } from "./scroll";
import { hasPendingImageAttachments, imageDataUrl, imageMeta } from "./attachments";
import type { ActivityStep, UiImageAttachment, UiMessage } from "./types";

let renderQueued = false;
let emptyRendered = false;
const renderedNodes = new Map<string, HTMLElement>();
const renderKeys = new WeakMap<HTMLElement, string>();

export function scheduleRender(): void {
  save();
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function isActive(message: UiMessage): boolean {
  return state.running && message.id === state.currentAssistantId;
}

function isStreaming(message: UiMessage): boolean {
  return (
    message.id === state.currentAssistantId &&
    typeof message.revealed === "number" &&
    message.revealed < message.text.length
  );
}

const THINKING_LEVEL_LABELS: Record<string, string> = {
  off: "Off",
  minimal: "Min",
  low: "Low",
  medium: "Med",
  high: "High",
  xhigh: "Max",
};

function renderThinkingControl(): void {
  const levels = state.thinkingLevels;
  if (levels.length <= 1) {
    thinkingControlEl.hidden = true;
    thinkingControlEl.innerHTML = "";
    thinkingControlEl.removeAttribute("data-current-level");
    thinkingControlEl.removeAttribute("title");
    return;
  }

  const currentIndex = Math.max(0, levels.indexOf(state.thinkingLevel));
  const currentLevel = levels[currentIndex] || levels[0];
  const currentLabel = THINKING_LEVEL_LABELS[currentLevel] || currentLevel;
  thinkingControlEl.hidden = false;
  thinkingControlEl.dataset.currentLevel = currentLevel;
  thinkingControlEl.title = `Reasoning effort: ${currentLabel}`;
  thinkingControlEl.setAttribute("aria-label", `Reasoning effort: ${currentLabel}`);
  thinkingControlEl.innerHTML =
    '<span class="thinking-label">' +
    escapeHtml(currentLabel) +
    '</span><div class="thinking-steps" role="group" aria-label="Reasoning effort levels">' +
    levels
      .map((level, index) => {
        const filled = index <= currentIndex ? " filled" : "";
        const current = level === currentLevel ? " current" : "";
        return (
          '<button class="thinking-step' +
          filled +
          current +
          '" data-action="set-thinking-level" data-level="' +
          escapeHtml(level) +
          '" title="' +
          escapeHtml(`Set effort to ${THINKING_LEVEL_LABELS[level] || level}`) +
          '" aria-label="' +
          escapeHtml(`Set effort to ${THINKING_LEVEL_LABELS[level] || level}`) +
          '"></button>'
        );
      })
      .join("") +
    "</div>";
}

// ---- assistant status line (spinner / working / done), single coherent line ----

function stepsRowsHtml(steps: ActivityStep[]): string {
  if (!steps.length) return '<div class="activity-step"><span class="bullet">•</span><span>Preparing context</span></div>';
  return steps
    .slice(-8)
    .map(
      (step) =>
        '<div class="activity-step"><span class="bullet">' +
        (step.status === "error" ? "×" : "•") +
        '</span><span>' +
        escapeHtml(step.label) +
        (step.detail ? " · " + escapeHtml(step.detail) : "") +
        "</span></div>",
    )
    .join("");
}

function statusHeaderInner(message: UiMessage, mode: "spinner" | "working" | "done", steps: ActivityStep[]): string {
  const stepCount = steps.length ? " · " + steps.length + " step" + (steps.length > 1 ? "s" : "") : "";
  if (mode === "spinner") {
    const { word, seconds } = thinkingLabel(message.createdAt);
    return (
      piMarkHtml("spinner") +
      '<span class="pixel-word" data-word="' +
      escapeHtml(word) +
      '">' +
      pixelWordHtml(word) +
      '</span><span class="think-time">' +
      (seconds > 0 ? seconds + "s" : "") +
      "</span>" +
      (steps.length ? '<span class="status-steps">' + escapeHtml(stepCount) + "</span>" : "")
    );
  }
  const dot = mode === "working" ? '<span class="activity-working-dot"></span>' : "";
  const label =
    mode === "working"
      ? "Working"
      : "Worked for " + formatDuration(message.activity?.startedAt, message.activity?.endedAt);
  return dot + "<span>" + escapeHtml(label + stepCount) + "</span>";
}

function statusBlock(message: UiMessage, mode: "spinner" | "working" | "done", steps: ActivityStep[], expanded: boolean): string {
  const hasSteps = steps.length > 0;
  const classes = "activity status-line" + (mode === "spinner" ? " spinner" : "") + (expanded ? " expanded" : "");
  const inner = statusHeaderInner(message, mode, steps);
  const chevron = hasSteps ? '<span class="activity-chevron">›</span>' : "";
  const open = hasSteps
    ? '<button class="activity-toggle" data-action="toggle-activity" data-id="' + message.id + '">'
    : '<div class="activity-toggle static">';
  const close = hasSteps ? "</button>" : "</div>";
  const details = hasSteps ? '<div class="activity-details">' + stepsRowsHtml(steps) + "</div>" : "";
  return '<div class="' + classes + '" data-activity-id="' + message.id + '">' + open + inner + chevron + close + details + "</div>";
}

function assistantStatusHtml(message: UiMessage): string {
  const active = isActive(message);
  const activity = message.activity;
  const steps = activity?.steps ?? [];

  if (active && !message.text) return statusBlock(message, "spinner", steps, !!activity?.expanded);
  if (!activity) return "";
  if (active && steps.length === 0) return ""; // streaming text with no tools → no header line
  return statusBlock(message, active ? "working" : "done", steps, !!activity.expanded);
}

function assistantActions(message: UiMessage): string {
  if (!message.text || isActive(message)) return "";
  return (
    '<div class="assistant-actions"><button data-action="copy" data-id="' +
    message.id +
    '" title="Copy">⧉</button><button title="Helpful">♡</button><button title="Not helpful">♧</button><button title="Open">↗</button></div>'
  );
}

function uiHtml(message: UiMessage): string {
  if (!message.ui || message.ui.resolved) return "";
  if (message.ui.kind === "confirm") {
    return (
      '<div class="ui-actions"><button class="primary" data-action="ui-confirm" data-id="' +
      message.id +
      '">Approve</button><button data-action="ui-cancel" data-id="' +
      message.id +
      '">Cancel</button></div>'
    );
  }
  return "";
}

function staticBody(message: UiMessage): string {
  if (message.pre) return "<pre>" + escapeHtml(message.text) + "</pre>";
  if (!message.text) return "";
  return '<div class="bubble">' + renderMarkdown(message.text) + "</div>";
}

function imageAttachmentHtml(message: UiMessage, attachment: UiImageAttachment, index: number): string {
  const meta = imageMeta(attachment);
  return (
    '<div class="attachment-pill" role="button" tabindex="0" data-action="preview-image" data-id="' +
    escapeHtml(message.id) +
    '" data-index="' +
    index +
    '">' +
    '<img class="attachment-thumb" alt="" src="' +
    escapeHtml(imageDataUrl(attachment)) +
    '" />' +
    '<span class="attachment-label" title="' +
    escapeHtml(attachment.name) +
    '">' +
    escapeHtml(attachment.name) +
    "</span>" +
    (meta ? '<span class="attachment-meta">' + escapeHtml(meta) + "</span>" : "") +
    "</div>"
  );
}

function imageAttachmentsHtml(message: UiMessage): string {
  const attachments = message.attachments || [];
  if (attachments.length === 0) return "";
  return '<div class="message-attachments">' + attachments.map((attachment, index) => imageAttachmentHtml(message, attachment, index)).join("") + "</div>";
}

function assistantBody(message: UiMessage): string {
  if (!message.text) return "";
  if (message.pre) return "<pre>" + escapeHtml(message.text) + "</pre>";
  const streaming = isStreaming(message);
  const shown = streaming ? message.text.slice(0, message.revealed) : message.text;
  const cursor = streaming ? '<span class="stream-cursor"></span>' : "";
  return '<div class="bubble">' + renderMarkdown(shown) + cursor + "</div>";
}

function messageHtml(message: UiMessage): string {
  if (message.role === "user") {
    const meta = formatTime(message.createdAt);
    return (
      imageAttachmentsHtml(message) +
      staticBody(message) +
      '<div class="meta"><span>' +
      escapeHtml(meta) +
      '</span><button data-action="copy" data-id="' +
      message.id +
      '" title="Copy">⧉</button><button data-action="edit" data-id="' +
      message.id +
      '" title="Edit">✎</button></div>'
    );
  }
  if (message.role === "assistant") {
    return assistantStatusHtml(message) + assistantBody(message) + assistantActions(message);
  }
  return '<div class="role">' + escapeHtml(roleLabel(message.role)) + "</div>" + staticBody(message) + uiHtml(message);
}

// Structural key: intentionally excludes per-frame volatiles (revealed, spinner
// glyph/word/seconds) so streaming/thinking does NOT rebuild the node each frame.
// Assistant text is excluded too (the painter fills the bubble); the final full
// text lands when `live` flips false and the node is rebuilt once.
function messageRenderKey(message: UiMessage): string {
  const active = isActive(message);
  const activity = message.activity;
  const stepsSig = activity
    ? activity.steps.map((s) => s.id + "|" + s.status + "|" + s.label + "|" + s.detail).join(";") +
      "#" + activity.steps.length + (activity.expanded ? "E" : "") + (activity.endedAt ? "D" : "")
    : "";
  return JSON.stringify({
    role: message.role,
    pre: !!message.pre,
    error: !!message.error,
    hasText: message.text.length > 0,
    live: active,
    stepsSig,
    ui: message.ui ? message.ui.kind + (message.ui.resolved ? "R" : "") : "",
    attachments: (message.attachments || []).map((attachment) => attachment.id + "|" + attachment.name).join(";"),
    text: message.role === "assistant" ? "" : message.text,
  });
}

export function currentSessionTitle(): string {
  const explicitTitle = state.sessionName.trim();
  if (explicitTitle) return explicitTitle;

  const firstUserMessage = state.messages.find((message) => message.role === "user");
  const firstUserText = firstUserMessage?.text.replace(/\s+/g, " ").trim();
  if (firstUserText) return firstUserText.length > 80 ? firstUserText.slice(0, 79) + "…" : firstUserText;

  const imageCount = firstUserMessage?.attachments?.length ?? 0;
  if (imageCount > 0) return imageCount === 1 ? "Image" : `${imageCount} images`;

  return "New session";
}

function updateMessageNode(node: HTMLElement, message: UiMessage): void {
  node.className = "message " + message.role + (message.error ? " error" : "");
  node.dataset.id = message.id;
  const key = messageRenderKey(message);
  if (renderKeys.get(node) !== key) {
    renderKeys.set(node, key);
    node.innerHTML = messageHtml(message);
  }
}

function setText(node: HTMLElement, selector: string, text: string): void {
  const el = node.querySelector(selector);
  if (el && el.textContent !== text) el.textContent = text;
}

// Per-frame, in-place update of only the active message's volatile parts.
export function paintLiveMessage(): void {
  const id = state.currentAssistantId;
  if (!id) return;
  const node = renderedNodes.get(id);
  if (!node) return;
  const message = state.messages.find((m) => m.id === id);
  if (!message) return;
  const followLatest = shouldFollowLatest();

  if (state.running && !message.text) {
    // The block pi (CSS-animated) needs no per-frame work. Re-render the pixel
    // word banner only when the word changes (so the rain replays), tick seconds.
    const { word, seconds } = thinkingLabel(message.createdAt);
    const wordEl = node.querySelector(".pixel-word");
    if (wordEl && wordEl.getAttribute("data-word") !== word) {
      wordEl.setAttribute("data-word", word);
      wordEl.innerHTML = pixelWordHtml(word);
    }
    setText(node, ".think-time", seconds > 0 ? seconds + "s" : "");
  } else if (message.text) {
    const bubble = node.querySelector(".bubble");
    if (bubble) {
      const streaming = isStreaming(message);
      const shown = streaming ? message.text.slice(0, message.revealed) : message.text;
      bubble.innerHTML = renderMarkdown(shown) + (streaming ? '<span class="stream-cursor"></span>' : "");
    }
  }

  applyLatestScroll(followLatest);
}

export function render(): void {
  const title = currentSessionTitle();
  if (!titleEl.classList.contains("editing")) {
    titleEl.textContent = title;
    titleEl.title = title;
  }
  const statusText = state.status || (state.running ? "Pi is working" : "");
  statusEl.textContent = statusText;
  statusEl.hidden = !statusText;
  renderThinkingControl();
  modelEl.textContent = (state.modelLabel || "Pi") + "⌄";
  stopEl.disabled = !state.running;
  stopEl.hidden = !state.running;
  composerEl.classList.toggle("working", !!state.running);
  sendEl.textContent = state.running ? "↪" : "↑";
  sendEl.title = state.running ? "Queue follow-up" : "Send";
  sendEl.classList.toggle("empty", !inputEl.value.trim() && !hasPendingImageAttachments());

  const followLatest = shouldFollowLatest();

  if (state.messages.length === 0) {
    if (!emptyRendered) {
      messagesEl.innerHTML =
        '<div class="empty"><strong>Ready when you are.</strong>Ask Pi to work in this project from the composer below.</div>';
      renderedNodes.clear();
      emptyRendered = true;
    }
    applyLatestScroll(true);
    return;
  }

  if (emptyRendered) {
    messagesEl.innerHTML = "";
    renderedNodes.clear();
    emptyRendered = false;
  }

  const seen = new Set<string>();
  state.messages.forEach((message, index) => {
    seen.add(message.id);
    let node = renderedNodes.get(message.id);
    if (!node) {
      node = document.createElement("section");
      renderedNodes.set(message.id, node);
    }
    updateMessageNode(node, message);
    const current = messagesEl.children[index];
    if (current !== node) messagesEl.insertBefore(node, current || null);
  });

  for (const [id, node] of renderedNodes) {
    if (!seen.has(id)) {
      node.remove();
      renderedNodes.delete(id);
    }
  }

  applyLatestScroll(followLatest);
}
