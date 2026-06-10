// Webview entry point: wires DOM events, routes inbound extension messages to
// the appropriate handler, and performs the initial render.
import { state, withSession, activateSession, dropSession, adoptPersistedView, consumeRestored } from "./state";
import { currentSessionTitle, render, scheduleRender, bumpHighlightVersion } from "./render";
import { addMessage, setRunning, interruptCurrentTurn, recordToolOutput } from "./conversation";
import { hydrateSessionMessages } from "./sessionHydrate";
import { handleRpcEvent, handleExtensionUiRequest, handleStderr } from "./handlers";
import { handleMessageClick } from "./messageActions";
import { initHighlighter, setHighlightNotifier, setTheme } from "./highlight";
import { initWakeDetection } from "./wake";
import { submitInput, autoResizeInput, updateInputState, composerIsEmpty } from "./input";
import { initImageAttachments } from "./attachments";
import { closeHistory, toggleHistory, renderSessionList, initHistory } from "./history";
import { closeModelPicker, toggleModelPicker, renderModelList, initModelPicker, setAuthAvailable } from "./modelPicker";
import { setAboutInfo, setAuthState, setAuthAvailable as setBridgeAuthAvailable } from "./authState";
import { acceptActive, closeCommandMenu, initCommandMenu, invalidateCommands, isCommandMenuOpen, moveActive, openCommandMenu, renderCommandList, setCommandQuery } from "./commandMenu";
import { initContextChip, resetContextInclude, updateEditorContext } from "./contextChip";
import { initThinkingControl, supportedThinkingLevels } from "./thinkingControl";
import { ensureAnimating } from "./animator";
import { piMarkHtml } from "./piMark";
import { post } from "./bridge";
import { updateConnectionBanner } from "./connectionBanner";
import { initScrollControls, resetScrollFollowing } from "./scroll";
import { appEl, titleEl, sendEl, stopEl, historyBtnEl, newSessionEl, modelEl, inputEl, composerEl, messagesEl } from "./dom";
import type { ExtensionToWebviewMessage } from "../protocol";

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
  // Context-aware while Pi is working: an EMPTY composer stops the turn; a non-empty one SENDS
  // it (a steer/follow-up — pi keeps the run going). Enter always sends (keydown handler below),
  // so a typed message is never lost to an accidental stop. Idle: always send.
  if (state.running && composerIsEmpty()) {
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

messagesEl.addEventListener("click", handleMessageClick);

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
  state.stats = undefined;
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
      // The newly active session has its own pi runtime, which may have loaded a different set of
      // packages/skills (e.g. ones installed since the last session started). Drop the stale
      // command cache so the slash palette reflects this runtime's commands.
      invalidateCommands();
      // The context-chip attach toggle was a decision for the PREVIOUS conversation —
      // don't let it silently append references to prompts in this one.
      resetContextInclude();
      resetScrollFollowing();
      scheduleRender();
      // Pull this session's authoritative usage/cost/context stats (webview-pull keeps
      // SessionRuntimeManager untouched; every seed path ends in this activate).
      post({ type: "requestSessionStats" });
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
  commandList: (m) => {
    renderCommandList(m.commands);
    setAuthAvailable(m.authAvailable);
    setBridgeAuthAvailable(m.authAvailable);
  },
  authState: (m) => setAuthState(m.status, m.providers),
  about: (m) => setAboutInfo({ extensionVersion: m.extensionVersion, piVersion: m.piVersion, piSource: m.piSource }),
  modelList: (m) => renderModelList(m.models),
  sessionStats: (m) => withSession(m.sessionId, () => {
    state.stats = m.stats;
    scheduleRender();
  }),
  theme: (m) => setTheme(m.theme, m.kind),
  editorContext: (m) => updateEditorContext({ path: m.path, startLine: m.startLine, endLine: m.endLine }),
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
initThinkingControl();
initContextChip();
initImageAttachments(() => {
  autoResizeInput();
  updateInputState();
});
initScrollControls();
// Wire Shiki: re-render cards once the highlighter/theme is ready (bumps the render key).
setHighlightNotifier(bumpHighlightVersion);
void initHighlighter();
mountBootSplash();
autoResizeInput();
updateInputState();
render();
if (state.running) ensureAnimating();
post({ type: "ready", hasMessages: state.messages.length > 0, sessionFile: state.sessionFile || undefined });

initWakeDetection();
