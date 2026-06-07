// Webview entry point: wires DOM events, routes inbound extension messages to
// the appropriate handler, and performs the initial render.
import { state, withSession, activateSession, dropSession, adoptPersistedView, consumeRestored } from "./state";
import { currentSessionTitle, render, scheduleRender } from "./render";
import { addMessage, getMessage, setRunning, hydrateSessionMessages, interruptCurrentTurn, recordToolOutput, toggleActivityStep } from "./conversation";
import { handleRpcEvent, handleExtensionUiRequest, handleStderr } from "./handlers";
import { submitInput, autoResizeInput, updateInputState } from "./input";
import { initImageAttachments, showImagePreview } from "./attachments";
import { closeHistory, toggleHistory, renderSessionList, initHistory } from "./history";
import { closeModelPicker, toggleModelPicker, renderModelList, initModelPicker } from "./modelPicker";
import { acceptActive, closeCommandMenu, initCommandMenu, isCommandMenuOpen, moveActive, openCommandMenu, renderCommandList, setCommandQuery } from "./commandMenu";
import { ensureAnimating } from "./animator";
import { piMarkHtml } from "./piMark";
import { post } from "./bridge";
import { updateConnectionBanner } from "./connectionBanner";
import { initScrollControls, resetScrollFollowing } from "./scroll";
import { appEl, titleEl, sendEl, stopEl, historyBtnEl, newSessionEl, thinkingControlEl, modelEl, inputEl, composerEl, messagesEl } from "./dom";
import type { ExtensionToWebviewMessage } from "../protocol";

const THINKING_LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

function supportedThinkingLevels(model: any): string[] {
  if (!model || model.reasoning !== true) return [];
  const map = model.thinkingLevelMap && typeof model.thinkingLevelMap === "object" ? model.thinkingLevelMap as Record<string, unknown> : undefined;
  return THINKING_LEVEL_ORDER.filter((level) => !map || !Object.prototype.hasOwnProperty.call(map, level) || map[level] !== null);
}

// pi "boot" splash: the pi.dev block logo tetris-assembles, then fades to the chat.
// Shown once per fresh webview load (skipped when a conversation is already present).
function mountBootSplash(): void {
  if (state.messages.length > 0) return;
  const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const el = document.createElement("div");
  el.className = "boot-splash";
  el.innerHTML = `<div class="boot-inner">${piMarkHtml("boot")}<div class="boot-word">pi</div></div>`;
  appEl.appendChild(el);
  const hold = reduce ? 600 : 1500;
  setTimeout(() => {
    el.classList.add("hide");
    setTimeout(() => el.remove(), 450);
  }, hold);
}

sendEl.addEventListener("click", () => {
  if (state.running) {
    interruptCurrentTurn();
    setRunning(false);
    post({ type: "abort" });
    return;
  }
  submitInput();
});
stopEl.addEventListener("click", () => {
  interruptCurrentTurn();
  setRunning(false);
  post({ type: "abort" });
});
historyBtnEl.addEventListener("click", toggleHistory);
modelEl.addEventListener("click", toggleModelPicker);
thinkingControlEl.addEventListener("click", (event) => {
  const target = event.target as HTMLElement | null;
  const button = target && target.closest ? (target.closest('[data-action="set-thinking-level"]') as HTMLButtonElement | null) : null;
  const level = button?.dataset.level;
  if (!level) return;
  post({ type: "setThinkingLevel", level });
});
newSessionEl.addEventListener("click", () => {
  closeHistory();
  closeModelPicker();
  closeCommandMenu();
  post({ type: "newSession" });
});
function placeCaretAtEnd(element: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  requestAnimationFrame(() => {
    element.scrollLeft = element.scrollWidth;
  });
}

function insertPlainText(text: string): void {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text.replace(/\s+/g, " "));
  range.insertNode(node);
  range.setStartAfter(node);
  range.setEndAfter(node);
  selection.removeAllRanges();
  selection.addRange(range);
}

function startTitleRename(): void {
  if (titleEl.classList.contains("editing")) return;
  if (!state.sessionFile) {
    addMessage("system", "Send a prompt before renaming this session.");
    return;
  }

  const currentName = state.sessionName.trim() || currentSessionTitle();
  titleEl.classList.add("editing");
  titleEl.textContent = currentName;
  titleEl.setAttribute("contenteditable", "plaintext-only");
  titleEl.setAttribute("role", "textbox");
  titleEl.setAttribute("aria-label", "Session title");
  titleEl.setAttribute("aria-multiline", "false");
  titleEl.spellcheck = false;
  titleEl.focus({ preventScroll: true });
  placeCaretAtEnd(titleEl);

  let done = false;
  const abort = new AbortController();
  const finish = (commit: boolean): void => {
    if (done) return;
    done = true;
    abort.abort();
    const name = (titleEl.textContent || "").replace(/\s+/g, " ").trim();
    titleEl.classList.remove("editing");
    titleEl.removeAttribute("contenteditable");
    titleEl.removeAttribute("role");
    titleEl.removeAttribute("aria-label");
    titleEl.removeAttribute("aria-multiline");
    if (commit && name && name !== state.sessionName.trim()) {
      state.sessionName = name;
      post({ type: "renameSession", sessionPath: state.sessionFile, name });
    }
    scheduleRender();
  };

  titleEl.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      if (event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  }, { signal: abort.signal });
  titleEl.addEventListener("beforeinput", (event) => {
    if (event.inputType === "insertParagraph" || event.inputType === "insertLineBreak") event.preventDefault();
  }, { signal: abort.signal });
  titleEl.addEventListener("paste", (event) => {
    event.preventDefault();
    insertPlainText(event.clipboardData?.getData("text/plain") || "");
  }, { signal: abort.signal });
  titleEl.addEventListener("blur", () => finish(true), { once: true, signal: abort.signal });
}
titleEl.addEventListener("dblclick", (event) => {
  event.preventDefault();
  startTitleRename();
});
inputEl.addEventListener("focus", () => composerEl.classList.add("focused"));
inputEl.addEventListener("blur", () => composerEl.classList.remove("focused"));
inputEl.addEventListener("input", () => {
  autoResizeInput();
  updateInputState();
  // Slash-command palette: open while the composer holds just "/<token>" (slash as
  // the first char, no spaces). A completing space, a newline, or deleting the "/"
  // closes it. Runs on `input` (after the value settles) so it is IME-safe.
  const match = /^\/(\S*)$/.exec(inputEl.value);
  if (match) {
    if (!isCommandMenuOpen()) openCommandMenu();
    setCommandQuery(match[1]);
  } else if (isCommandMenuOpen()) {
    closeCommandMenu();
  }
});
let inputComposing = false;
let submitAfterComposition = false;
inputEl.addEventListener("compositionstart", () => {
  inputComposing = true;
});
inputEl.addEventListener("compositionend", () => {
  inputComposing = false;
  updateInputState();
  if (submitAfterComposition) {
    submitAfterComposition = false;
    setTimeout(submitInput, 0);
  }
});
inputEl.addEventListener("keydown", (event) => {
  // When the command palette is open, it gets first refusal on nav keys — but never
  // mid-IME-composition (let the composer/IME handle those), so Shift+Enter newlines
  // and the deferred-submit path below stay intact.
  if (isCommandMenuOpen() && !(event.isComposing || inputComposing || event.keyCode === 229)) {
    if (event.key === "ArrowDown") { event.preventDefault(); moveActive(1); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); moveActive(-1); return; }
    if (event.key === "Escape") { event.preventDefault(); closeCommandMenu(); return; }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      if (acceptActive()) return; // inserted "/name " (or ran a built-in); do not submit
    }
  }
  if (event.key === "Enter" && !event.shiftKey) {
    if (event.isComposing || inputComposing) {
      submitAfterComposition = true;
      event.preventDefault();
      return;
    }
    event.preventDefault();
    if (event.keyCode === 229) setTimeout(submitInput, 0);
    else submitInput();
  }
});

messagesEl.addEventListener("click", (event) => {
  const target = event.target as HTMLElement | null;
  const actionEl = target && target.closest ? (target.closest("[data-action]") as HTMLElement | null) : null;
  if (!actionEl) return;
  const action = actionEl.dataset.action;
  const id = actionEl.dataset.id;
  const message = id ? getMessage(id) : undefined;
  if (action === "toggle-activity" && message && message.activity) {
    message.activity.expanded = !message.activity.expanded;
    scheduleRender();
    return;
  }
  if (action === "toggle-step") {
    const stepId = actionEl.dataset.stepId;
    if (stepId) toggleActivityStep(stepId);
    return;
  }
  if (action === "preview-image" && message) {
    const index = Number(actionEl.dataset.index);
    const attachment = Number.isInteger(index) ? message.attachments?.[index] : undefined;
    if (attachment) showImagePreview(attachment);
    return;
  }
  if (action === "copy" && message) {
    post({ type: "copy", text: message.text || "" });
    actionEl.classList.add("copied");
    actionEl.textContent = "✓";
    setTimeout(() => scheduleRender(), 700);
    return;
  }
  if (action === "edit" && message) {
    inputEl.value = message.text || "";
    autoResizeInput();
    updateInputState();
    inputEl.focus();
    return;
  }
  if ((action === "ui-confirm" || action === "ui-cancel") && message && message.ui) {
    message.ui.resolved = true;
    post({
      type: "extensionUiResponse",
      response: {
        type: "extension_ui_response",
        id: message.ui.requestId,
        confirmed: action === "ui-confirm",
        cancelled: action === "ui-cancel",
      },
    });
    scheduleRender();
  }
});

// ---- inbound message routing ----
// A typed handler table keyed by message type. The mapped `InboundTable` type forces
// EXHAUSTIVENESS: add a variant to ExtensionToWebviewMessage without a handler here and tsc
// errors — so every inbound transition is auditable in one place. Multi-statement flows are
// named functions below with their ordering INVARIANT documented.
type Inbound = ExtensionToWebviewMessage;
type InboundHandler<T extends Inbound["type"]> = (message: Extract<Inbound, { type: T }>) => void;
type InboundTable = { [T in Inbound["type"]]: InboundHandler<T> };

/**
 * INVARIANT (crash-restore ordering): the `state` message MUST arrive before
 * `sessionMessages` for the same sessionId. `state` calls adoptPersistedView() which marks
 * restoredIds; this consumes that mark to SKIP the disk re-seed so the richer persisted
 * timeline isn't clobbered by plain disk messages. (Race #2 — see round-6 B4, which makes
 * the skip robust to delivery order rather than relying on it.)
 */
function handleSessionMessages(message: Extract<Inbound, { type: "sessionMessages" }>): void {
  if (consumeRestored(message.sessionId)) return;
  withSession(message.sessionId, () => {
    if (message.force || state.messages.length === 0) {
      resetScrollFollowing();
      hydrateSessionMessages(message.messages);
    }
  });
}

/**
 * INVARIANT: adoptPersistedView() runs BEFORE the scalar field assignments — it overwrites
 * messages/tokens/cost/running wholesale, and the scalars (sessionName/file/thinking/model)
 * layer on top of the restored view.
 */
function handleSessionState(message: Extract<Inbound, { type: "state" }>): void {
  withSession(message.sessionId, () => {
    const s = message.state as any;
    const model = s && s.model;
    const sessionName = s && s.sessionName;
    const sessionFile = s && typeof s.sessionFile === "string" ? s.sessionFile : "";
    const isStreaming = s && typeof s.isStreaming === "boolean" ? s.isStreaming : undefined;
    adoptPersistedView(message.sessionId, sessionFile);
    state.sessionName = sessionName ? String(sessionName) : "";
    state.sessionFile = sessionFile;
    state.thinkingLevel = s && typeof s.thinkingLevel === "string" ? s.thinkingLevel : "";
    state.thinkingLevels = supportedThinkingLevels(model);
    state.modelLabel = model && (model.name || model.id) ? String(model.name || model.id) : state.modelLabel || "Pi";
    if (typeof isStreaming === "boolean") setRunning(isStreaming);
    else scheduleRender();
  });
}

function handleReset(): void {
  state.messages = [];
  state.currentAssistantId = null;
  state.running = false;
  state.sessionName = "";
  state.sessionFile = "";
  state.status = "";
  state.thinkingLevel = "";
  state.thinkingLevels = [];
  resetScrollFollowing();
  scheduleRender();
}

const inbound: InboundTable = {
  // per-session: applied to the tagged session's view
  rpcEvent: (m) => withSession(m.sessionId, () => handleRpcEvent(m.event)),
  toolOutput: (m) => withSession(m.sessionId, () => recordToolOutput(m.toolCallId, { text: m.text, isError: m.isError, diff: m.diff, firstChangedLine: m.firstChangedLine })),
  running: (m) => withSession(m.sessionId, () => setRunning(!!m.value)),
  sessionMessages: handleSessionMessages,
  state: handleSessionState,
  // session activation / lifecycle
  activate: (m) => {
    if (activateSession(m.sessionId)) {
      resetScrollFollowing();
      scheduleRender();
    }
  },
  dropSession: (m) => dropSession(m.sessionId),
  reset: handleReset,
  // global (not session-scoped)
  extensionUiRequest: (m) => handleExtensionUiRequest(m.request),
  system: (m) => {
    const text = m.text || "";
    addMessage("system", text, { error: /error|failed|closed/i.test(text) });
  },
  stderr: (m) => handleStderr(m.text || ""),
  connection: (m) => updateConnectionBanner(m.status),
  sessionList: (m) => renderSessionList(m.sessions),
  commandList: (m) => renderCommandList(m.commands),
  modelList: (m) => renderModelList(m.models),
};

window.addEventListener("message", (event) => {
  const message = event.data as Inbound | undefined;
  if (!message || typeof message !== "object") return;
  const handle = inbound[message.type as Inbound["type"]] as ((m: Inbound) => void) | undefined;
  if (handle) handle(message);
});

initHistory();
initModelPicker();
initCommandMenu();
initImageAttachments(() => {
  autoResizeInput();
  updateInputState();
});
initScrollControls();
mountBootSplash();
autoResizeInput();
updateInputState();
render();
if (state.running) ensureAnimating();
post({ type: "ready", hasMessages: state.messages.length > 0, sessionFile: state.sessionFile || undefined });

// Wake-from-sleep detection. A long stall between ticks means the machine was
// suspended (timers freeze during sleep), so the broker socket is likely
// half-open — nudge the host to verify and reconnect. Becoming visible again is
// a second, cheaper trigger. The host's probe is a no-op when the link is fine.
let lastWakeTick = Date.now();
setInterval(() => {
  const now = Date.now();
  if (now - lastWakeTick > 30000) post({ type: "wake" });
  lastWakeTick = now;
}, 10000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) post({ type: "wake" });
});
