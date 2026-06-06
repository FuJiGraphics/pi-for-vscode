// Webview entry point: wires DOM events, routes inbound extension messages to
// the appropriate handler, and performs the initial render.
import { state } from "./state";
import { currentSessionTitle, render, scheduleRender } from "./render";
import { addMessage, getMessage, setRunning, hydrateSessionMessages } from "./conversation";
import { handleRpcEvent, handleExtensionUiRequest, handleStderr } from "./handlers";
import { submitInput, autoResizeInput, updateInputState } from "./input";
import { initImageAttachments, showImagePreview } from "./attachments";
import { closeHistory, toggleHistory, renderSessionList, initHistory } from "./history";
import { closeModelPicker, toggleModelPicker, renderModelList, initModelPicker } from "./modelPicker";
import { acceptActive, closeCommandMenu, initCommandMenu, isCommandMenuOpen, moveActive, openCommandMenu, renderCommandList, setCommandQuery } from "./commandMenu";
import { ensureAnimating } from "./animator";
import { piMarkHtml } from "./piMark";
import { post } from "./bridge";
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

sendEl.addEventListener("click", submitInput);
stopEl.addEventListener("click", () => {
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

window.addEventListener("message", (event) => {
  const message = event.data as ExtensionToWebviewMessage | undefined;
  if (!message || typeof message !== "object") return;
  switch (message.type) {
    case "rpcEvent":
      handleRpcEvent(message.event);
      break;
    case "extensionUiRequest":
      handleExtensionUiRequest(message.request);
      break;
    case "system": {
      const text = message.text || "";
      addMessage("system", text, { error: /error|failed|closed/i.test(text) });
      break;
    }
    case "stderr":
      handleStderr(message.text || "");
      break;
    case "running":
      setRunning(!!message.value);
      break;
    case "sessionMessages":
      if (message.force || state.messages.length === 0) {
        resetScrollFollowing();
        hydrateSessionMessages(message.messages);
      }
      break;
    case "sessionList":
      renderSessionList(message.sessions);
      break;
    case "commandList":
      renderCommandList(message.commands);
      break;
    case "modelList":
      renderModelList(message.models);
      break;
    case "reset":
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
      break;
    case "state": {
      const s = message.state as any;
      const model = s && s.model;
      const sessionName = s && s.sessionName;
      const sessionFile = s && s.sessionFile;
      const isStreaming = s && typeof s.isStreaming === "boolean" ? s.isStreaming : undefined;
      state.sessionName = sessionName ? String(sessionName) : "";
      state.sessionFile = sessionFile ? String(sessionFile) : "";
      state.thinkingLevel = s && typeof s.thinkingLevel === "string" ? s.thinkingLevel : "";
      state.thinkingLevels = supportedThinkingLevels(model);
      state.modelLabel = model && (model.name || model.id) ? String(model.name || model.id) : state.modelLabel || "Pi";
      state.status = state.running ? "Pi is working" : "";
      if (typeof isStreaming === "boolean") setRunning(isStreaming);
      else scheduleRender();
      break;
    }
  }
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
