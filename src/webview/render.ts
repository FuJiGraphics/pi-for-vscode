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
import { state, save, isRenderSuppressed } from "./state";
import { messagesEl, titleEl, thinkingControlEl, modelEl, stopEl, composerEl, sendEl, inputEl, queueIndicatorEl } from "./dom";
import { escapeHtml, formatTime, formatDuration, roleLabel } from "./util";
import { renderMarkdown } from "./markdown";
import { cardFor, effectiveExpanded, isCardCollapsible, stepDetail, timelineRow, tokCost } from "./cards";
import { deriveTodos, isTodoStep, todoCardHtml } from "./cardsTodo";
import { isTextStep, textStepRowHtml } from "./textSteps";
import { isThinkingStep, lastRunningThinkingStep, liveThinkingTail } from "./thinkingSteps";
import { statusTaskText } from "./statusLine";
import { thinkingLabel } from "./spinner";
import { piMarkHtml } from "./piMark";
import { pixelWordHtml } from "./pixelFont";
import { applyLatestScroll, shouldFollowLatest } from "./scroll";
import { hasPendingImageAttachments, imageDataUrl, imageMeta } from "./attachments";
import type { Activity, UiImageAttachment, UiMessage } from "./types";

let renderQueued = false;
let emptyRendered = false;
const renderedNodes = new Map<string, HTMLElement>();
const renderKeys = new WeakMap<HTMLElement, string>();

// Streaming re-parse gate: the reveal animation paints every frame, but markdown-it + Shiki are
// too heavy to re-run per frame on a growing buffer. Re-render only after the revealed text
// advances by this many chars (or on the final, non-streaming frame), keyed per bubble element so
// a structural rebuild (new bubble node) resets cleanly. Keeps the char-by-char reveal smooth
// while bounding parses to ~length/STEP instead of one per frame.
const STREAM_RENDER_STEP = 8;
const liveRenderedLen = new WeakMap<Element, number>();
const liveThinkLen = new WeakMap<Element, number>();

// Bumped when the Shiki highlighter becomes ready or the theme changes. Folded into the step
// render key (stepsSig) so the timeline nodes — whose card HTML now differs — are rebuilt; a
// bare scheduleRender would no-op because the underlying step DATA is unchanged.
let highlightVersion = 0;
export function bumpHighlightVersion(): void {
  highlightVersion++;
  scheduleRender();
}

export function scheduleRender(): void {
  // A mutation against a background session's view: update its data only, don't render or
  // persist the active view. The background view renders later when it's activated.
  if (isRenderSuppressed()) return;
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
  off: "off",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
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
  thinkingControlEl.title = `Thinking level: ${currentLabel}`;
  thinkingControlEl.setAttribute("aria-label", `Thinking level: ${currentLabel}`);
  thinkingControlEl.innerHTML =
    '<span class="thinking-label">' +
    escapeHtml(currentLabel) +
    '</span><div class="thinking-steps" role="group" aria-label="Thinking levels">' +
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
          escapeHtml(`Set thinking level to ${THINKING_LEVEL_LABELS[level] || level}`) +
          '" aria-label="' +
          escapeHtml(`Set thinking level to ${THINKING_LEVEL_LABELS[level] || level}`) +
          '"></button>'
        );
      })
      .join("") +
    "</div>";
}

// ---- assistant status line (spinner / working / done), single coherent line ----

const SEP = " · ";

function stepsRowsHtml(activity: Activity): string {
  const steps = activity.steps;
  const rows: string[] = [];
  // Lead "Thought for Xs" node — the time spent before the first step ran (Claude-style).
  // Suppressed when real thinking steps exist: they carry their own timed rows, and the
  // synthetic lead would double-count the same seconds.
  const firstStart = steps.length ? steps[0].startedAt : activity.endedAt || Date.now();
  if (firstStart - activity.startedAt >= 1500 && !steps.some(isThinkingStep)) {
    rows.push(timelineRow({ status: "done", label: "Thought for " + formatDuration(activity.startedAt, firstStart) }));
  }
  if (!steps.length) {
    if (rows.length === 0) rows.push(timelineRow({ status: "running", label: "Preparing context" }));
    return rows.join("");
  }
  const visible = steps.slice(-16);
  // All `todo` calls collapse into ONE consolidated checklist (Claude-style), folded ONCE
  // here and rendered at the position of the most recent todo step; if every todo step
  // scrolled out of the visible window but todos still exist, the card is appended at the end.
  const todos = steps.some(isTodoStep) ? deriveTodos(steps) : [];
  let lastTodoIndex = -1;
  for (let i = 0; i < visible.length; i++) if (isTodoStep(visible[i])) lastTodoIndex = i;
  visible.forEach((step, index) => {
    if (isTodoStep(step)) {
      if (index === lastTodoIndex) rows.push(todoCardHtml(todos));
      return;
    }
    if (isTextStep(step)) {
      rows.push(textStepRowHtml(step));
      return;
    }
    rows.push(timelineRow({
      id: step.id,
      status: step.status,
      label: step.label,
      detail: stepDetail(step),
      // A done thinking row's label already reads "Thought for Xs" — a time chip would repeat it.
      time: step.endedAt && !isThinkingStep(step) ? formatDuration(step.startedAt, step.endedAt) : "",
      tokens: step.tokens,
      cost: step.cost,
      gen: step.kind === "generation",
      output: step.output,
      expanded: effectiveExpanded(step),
      card: cardFor(step),
      cardCollapsible: isCardCollapsible(step),
    }));
  });
  if (lastTodoIndex === -1 && todos.length > 0) {
    rows.push(todoCardHtml(todos));
  }
  return rows.join("");
}

// Turn-total usage "5.3k tokens | $0.03" — no leading separator; the header joins fragments.
function usageChip(message: UiMessage): string {
  return message.tokens ? tokCost(message.tokens, message.cost) : "";
}

// Done-mode header label. A session-restored thinking-only turn has no real duration data
// (startedAt === endedAt), where "Worked for 0s" would read wrong — abbreviate to "Thought".
function doneLabel(message: UiMessage): string {
  const activity = message.activity;
  const steps = activity?.steps ?? [];
  if (activity && steps.length > 0 && steps.every(isThinkingStep) && activity.endedAt === activity.startedAt) {
    return "Thought";
  }
  return "Worked for " + formatDuration(activity?.startedAt, activity?.endedAt);
}

function statusHeaderInner(message: UiMessage, mode: "spinner" | "working" | "done"): string {
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
      // Always present (even empty) so paintLiveMessage can update it in place per frame:
      // the current work ("Read · cards.ts" / "Thinking… <last line>") or the step count.
      '<span class="status-task">' + escapeHtml(statusTaskText(message)) + "</span>"
    );
  }
  const dot = mode === "working" ? '<span class="activity-working-dot"></span>' : "";
  const label = mode === "working" ? "Working" : doneLabel(message);
  if (mode === "working") {
    // The live task chip ("Read · cards.ts" / "Thinking… <tail>") sits in its own span so
    // paintLiveMessage can update it per frame without rebuilding the header.
    return (
      dot + "<span>" + escapeHtml(label) + '</span><span class="status-task">' +
      escapeHtml(statusTaskText(message)) + "</span>"
    );
  }
  // Join the present fragments with one middot rather than baking a leading " · " into each.
  // statusTaskText falls back to "N steps" when nothing is actively running (always, in done mode).
  return dot + "<span>" + escapeHtml([label, statusTaskText(message), usageChip(message)].filter(Boolean).join(SEP)) + "</span>";
}

function statusBlock(message: UiMessage, mode: "spinner" | "working" | "done", expanded: boolean): string {
  const activity = message.activity;
  const steps = activity?.steps ?? [];
  const hasSteps = steps.length > 0;
  const classes = "activity status-line" + (mode === "spinner" ? " spinner" : "") + (expanded ? " expanded" : "");
  const inner = statusHeaderInner(message, mode);
  const chevron = hasSteps ? '<span class="activity-chevron">›</span>' : "";
  const open = hasSteps
    ? '<button class="activity-toggle" data-action="toggle-activity" data-id="' + message.id + '">'
    : '<div class="activity-toggle static">';
  const close = hasSteps ? "</button>" : "</div>";
  const details = hasSteps && activity ? '<div class="activity-details">' + stepsRowsHtml(activity) + "</div>" : "";
  return '<div class="' + classes + '" data-activity-id="' + message.id + '">' + open + inner + chevron + close + details + "</div>";
}

function assistantStatusHtml(message: UiMessage): string {
  const active = isActive(message);
  const activity = message.activity;
  const steps = activity?.steps ?? [];

  // While the turn is active the timeline stays expanded so progress reads as a live
  // connected graph. Spinner mode only at the true turn start (no steps yet) — once any
  // step exists the header is "working"; otherwise each toolUse demotion (text → "")
  // would bounce the header back to the giant spinner mid-turn.
  if (active && !message.text && steps.length === 0) return statusBlock(message, "spinner", true);
  if (!activity) return "";
  if (active && steps.length === 0) return ""; // streaming text with no tools → no header line
  return statusBlock(message, active ? "working" : "done", active ? true : !!activity.expanded);
}

function assistantActions(message: UiMessage): string {
  if (!message.text || isActive(message)) return "";
  return (
    '<div class="assistant-actions"><button data-action="copy" data-id="' +
    message.id +
    '" title="Copy">⧉</button><button title="Helpful">♡</button><button title="Not helpful">♧</button><button title="Open">↗</button></div>'
  );
}

// Inline "Interrupted" marker below a turn that was cut off (Stop / VS Code closed).
function interruptedLine(message: UiMessage): string {
  return message.interrupted ? '<div class="interrupted-line">Interrupted</div>' : "";
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
    return assistantStatusHtml(message) + assistantBody(message) + assistantActions(message) + interruptedLine(message);
  }
  return '<div class="role">' + escapeHtml(roleLabel(message.role)) + "</div>" + staticBody(message) + uiHtml(message);
}

// Structural key: intentionally excludes per-frame volatiles (revealed, spinner
// glyph/word/seconds) so streaming/thinking does NOT rebuild the node each frame.
// Assistant text is excluded too (the painter fills the bubble); the final full
// text lands when `live` flips false and the node is rebuilt once.
// step.thinkingText is volatile for the same reason — NEVER fold it into stepsSig
// (the live painter updates the .thinking-text leaf; thinking_start/end change
// status/label and rebuild exactly twice per block). Exported for the key-stability test.
export function messageRenderKey(message: UiMessage): string {
  const active = isActive(message);
  const activity = message.activity;
  const stepsSig = activity
    ? activity.steps
        // Narration steps fold only their LENGTH (immutable after creation; never the body —
        // sig strings must stay small).
        .map((s) => s.id + "|" + s.status + "|" + s.label + "|" + (s.tool || "") + "|" + s.detail + "|" + (s.output ? "O" : "") + (effectiveExpanded(s) ? "X" : "") + (s.kind === "text" ? "T" + (s.text?.length || 0) : ""))
        .join(";") +
      "#" + activity.steps.length + (activity.expanded ? "E" : "") + (activity.endedAt ? "D" : "") + "@" + highlightVersion
    : "";
  return JSON.stringify({
    role: message.role,
    pre: !!message.pre,
    error: !!message.error,
    hasText: message.text.length > 0,
    live: active,
    stepsSig,
    tokens: message.tokens || 0,
    interrupted: !!message.interrupted,
    ui: message.ui ? message.ui.kind + (message.ui.resolved ? "R" : "") : "",
    attachments: (message.attachments || []).map((attachment) => attachment.id + "|" + attachment.name).join(";"),
    text: message.role === "assistant" ? "" : message.text,
    // Bubble code blocks highlight lazily — fold highlightVersion in so a message repaints when its
    // grammar finishes loading (or the theme changes). Without this only tool cards (stepsSig) would.
    hl: highlightVersion,
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

  if (state.running) {
    // Header leaves: the spinner-mode pixel word/seconds (absent in working mode — the
    // querySelector just misses) and the .status-task chip, which BOTH modes carry.
    const { word, seconds } = thinkingLabel(message.createdAt);
    const wordEl = node.querySelector(".pixel-word");
    if (wordEl && wordEl.getAttribute("data-word") !== word) {
      wordEl.setAttribute("data-word", word);
      wordEl.innerHTML = pixelWordHtml(word);
    }
    setText(node, ".think-time", seconds > 0 ? seconds + "s" : "");
    setText(node, ".status-task", statusTaskText(message));
  }
  if (message.text) {
    const bubble = node.querySelector(".bubble");
    if (bubble) {
      const streaming = isStreaming(message);
      const shownLen = streaming ? (message.revealed as number) : message.text.length;
      const last = liveRenderedLen.get(bubble);
      // During streaming, batch by STREAM_RENDER_STEP; the final (non-streaming) frame always
      // renders so the complete text — and any not-yet-shown markdown/code — lands.
      const needsRender = streaming ? last === undefined || shownLen - last >= STREAM_RENDER_STEP : last !== shownLen;
      if (needsRender) {
        const shown = streaming ? message.text.slice(0, message.revealed) : message.text;
        bubble.innerHTML = renderMarkdown(shown) + (streaming ? '<span class="stream-cursor"></span>' : "");
        liveRenderedLen.set(bubble, shownLen);
      }
    }
  }

  // Live thinking card: paint the streaming tail as plaintext (no markdown re-parse),
  // gated by the same char step as the bubble. Independent of the branches above — a
  // later thinking block streams after bubble text already exists.
  if (state.running) {
    const think = lastRunningThinkingStep(message.activity);
    if (think) {
      const card = node.querySelector(".tl-thinking.live .thinking-text");
      if (card) {
        const len = think.thinkingText?.length ?? 0;
        const last = liveThinkLen.get(card);
        if (last === undefined || len - last >= STREAM_RENDER_STEP) {
          card.textContent = liveThinkingTail(think);
          liveThinkLen.set(card, len);
          // The live card grows without structural renders, so keep its overflow fade
          // (markOverflowingCards' job) in sync here.
          const root = card.parentElement;
          if (root) root.classList.toggle("is-overflowing", root.scrollHeight > root.clientHeight + 1);
        }
      }
    }
  }

  applyLatestScroll(followLatest);
}

// The composer's send/stop control is context-aware: while Pi is working it STOPS only when the
// composer is empty; with text or images staged it SENDS (a steer/follow-up). Called from
// render() and from input.ts on every composer change so the glyph tracks typing immediately.
export function refreshSendButton(): void {
  const empty = !inputEl.value.trim() && !hasPendingImageAttachments();
  const stopMode = state.running && empty;
  sendEl.textContent = stopMode ? "■" : "↑";
  sendEl.title = stopMode ? "Stop" : "Send";
  sendEl.setAttribute("aria-label", stopMode ? "Stop" : "Send");
  // Dim only when idle with nothing to send; a stop button (running + empty) stays active.
  sendEl.classList.toggle("empty", !state.running && empty);
}

// "N queued" pill above the composer — reassurance that rapid-fire sends were accepted and are
// waiting their turn (Claude-style), instead of a flickering stack of per-run indicators.
// state.status is the single source (the queue_update handler sets the count, clears on drain /
// turn end / reset). The dataset guard avoids re-writing innerHTML on every unrelated render.
function renderQueueIndicator(): void {
  const status = state.status;
  if (!status) {
    queueIndicatorEl.hidden = true;
    queueIndicatorEl.dataset.status = "";
    return;
  }
  if (queueIndicatorEl.dataset.status !== status) {
    queueIndicatorEl.dataset.status = status;
    queueIndicatorEl.innerHTML =
      '<span class="activity-working-dot" aria-hidden="true"></span><span>' + escapeHtml(status) + "</span>";
  }
  queueIndicatorEl.hidden = false;
}

export function render(): void {
  const title = currentSessionTitle();
  if (!titleEl.classList.contains("editing")) {
    titleEl.textContent = title;
    titleEl.title = title;
  }
  // (No status subtitle under the title — removed. Run state shows in the activity
  // timeline; "Interrupted" is rendered inline below the cut-off turn, not as a banner.)
  renderThinkingControl();
  modelEl.textContent = (state.modelLabel || "Pi") + "⌄";
  stopEl.disabled = true;
  stopEl.hidden = true;
  composerEl.classList.toggle("working", !!state.running);
  refreshSendButton();
  renderQueueIndicator();

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

  markOverflowingCards();
  applyLatestScroll(followLatest);
}

// Cards clip their (compact) preview at a max-height; flag the ones whose content overflows so
// CSS can fade the bottom edge — a "there's more, click ⤢ to expand" hint. Read once after all
// innerHTML writes to avoid interleaved layout reads.
function markOverflowingCards(): void {
  for (const node of renderedNodes.values()) {
    node.querySelectorAll<HTMLElement>(".tl-diff, .tl-write, .tl-read, .tl-thinking").forEach((card) => {
      card.classList.toggle("is-overflowing", card.scrollHeight > card.clientHeight + 1);
    });
  }
}
