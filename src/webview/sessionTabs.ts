// Chrome-style tab strip for OPEN sessions (one tab per live runtime view). Owns tab
// rendering, click-to-activate, close (×), and the active tab's inline dblclick rename
// (moved here from main.ts's old single-title rename). Past sessions on disk stay in the
// history popover — tabs only mirror what's open right now (SessionViewStore.openViews).
import { state, getActiveSessionId, openViews, activateSession, closeSessionTab, moveSessionTab } from "./state";
import { tabsEl } from "./dom";
import { post } from "./bridge";
import { escapeHtml } from "./util";
import { scheduleRender } from "./render";
import type { AppState } from "./types";

let draggingId = "";

/** Display title for any session view: explicit name → first user message → "New session".
 *  (Generalized from the old single-title currentSessionTitle so background tabs title too.) */
export function sessionTitleOf(view: AppState): string {
  const explicitTitle = view.sessionName.trim();
  if (explicitTitle) return explicitTitle;

  const firstUserMessage = view.messages.find((message) => message.role === "user");
  const firstUserText = firstUserMessage?.text.replace(/\s+/g, " ").trim();
  if (firstUserText) return firstUserText.length > 80 ? firstUserText.slice(0, 79) + "…" : firstUserText;

  const imageCount = firstUserMessage?.attachments?.length ?? 0;
  if (imageCount > 0) return imageCount === 1 ? "Image" : `${imageCount} images`;

  return "New session";
}

function tabHtml(id: string, view: AppState, active: boolean): string {
  const title = sessionTitleOf(view);
  const classes = "tab" + (active ? " active" : "") + (id === draggingId ? " dragging" : "");
  return (
    '<div class="' + classes + '" role="tab" aria-selected="' + active +
    '" draggable="true" data-session-id="' + escapeHtml(id) + '" title="' + escapeHtml(title) + '">' +
    (view.running ? '<span class="tab-running-dot" aria-hidden="true"></span>' : "") +
    '<span class="tab-label">' + escapeHtml(title) + "</span>" +
    '<button class="tab-close" data-close="' + escapeHtml(id) + '" title="Close tab" aria-label="Close tab">×</button>' +
    "</div>"
  );
}

/** Rebuild the strip when the tab set/titles/active/running state changed. Called from
 *  render() (active-view changes) AND directly from background-tagged message handlers in
 *  main.ts — withSession suppresses renders for background views, so a background spinner
 *  or rename would otherwise never reach the strip. */
export function renderSessionTabs(): void {
  if (tabsEl.querySelector(".editing")) return; // never clobber an inline rename in progress
  const views = openViews();
  const activeId = getActiveSessionId();
  const sig =
    activeId + "#" + views.map(({ id, view }) => id + "|" + sessionTitleOf(view) + (view.running ? "|R" : "")).join(";");
  if (tabsEl.dataset.sig === sig) return; // unchanged → keep hover/element identity
  tabsEl.dataset.sig = sig;
  // No open sessions → empty strip, NOT a fake "Pi" tab. The empty state is just the composer;
  // a placeholder tab read as a phantom session literally named "Pi" (e.g. right after closing
  // the last/only session), which is confusing.
  tabsEl.innerHTML = views.map(({ id, view }) => tabHtml(id, view, id === activeId)).join("");
  tabsEl.querySelector<HTMLElement>(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

// ---- inline rename (active tab only) ----

function placeCaretAtEnd(element: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
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

// A rename needs an on-disk session to rename; an unsent session briefly shakes instead.
function denyRename(tab: HTMLElement): void {
  tab.classList.add("tab-deny");
  setTimeout(() => tab.classList.remove("tab-deny"), 420);
}

function startTabRename(tab: HTMLElement): void {
  const label = tab.querySelector<HTMLElement>(".tab-label");
  if (!label || label.classList.contains("editing")) return;
  if (!state.sessionFile) {
    denyRename(tab);
    return;
  }

  label.classList.add("editing");
  label.textContent = state.sessionName.trim() || sessionTitleOf(state);
  label.setAttribute("contenteditable", "plaintext-only");
  label.setAttribute("role", "textbox");
  label.setAttribute("aria-label", "Session title");
  label.spellcheck = false;
  label.focus({ preventScroll: true });
  placeCaretAtEnd(label);

  let done = false;
  const abort = new AbortController();
  const finish = (commit: boolean): void => {
    if (done) return;
    done = true;
    abort.abort();
    const name = (label.textContent || "").replace(/\s+/g, " ").trim();
    label.classList.remove("editing");
    label.removeAttribute("contenteditable");
    label.removeAttribute("role");
    label.removeAttribute("aria-label");
    if (commit && name && name !== state.sessionName.trim()) {
      state.sessionName = name;
      post({ type: "renameSession", sessionPath: state.sessionFile, name });
    }
    tabsEl.dataset.sig = ""; // force the next renderSessionTabs to rebuild with the new title
    renderSessionTabs();
  };

  label.addEventListener("keydown", (event) => {
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
  label.addEventListener("beforeinput", (event) => {
    if (event.inputType === "insertParagraph" || event.inputType === "insertLineBreak") event.preventDefault();
  }, { signal: abort.signal });
  label.addEventListener("paste", (event) => {
    event.preventDefault();
    insertPlainText(event.clipboardData?.getData("text/plain") || "");
  }, { signal: abort.signal });
  label.addEventListener("blur", () => finish(true), { once: true, signal: abort.signal });
}

function activateTabLocally(id: string): void {
  if (!id || id === getActiveSessionId()) return;
  if (activateSession(id)) {
    renderSessionTabs();
    scheduleRender();
  }
}

function closeTabLocally(id: string): string | undefined {
  const activeBefore = getActiveSessionId();
  const nextId = closeSessionTab(id);
  tabsEl.dataset.sig = "";
  renderSessionTabs();
  if (id === activeBefore) scheduleRender();
  return nextId;
}

function tabFromEvent(event: Event): HTMLElement | null {
  const target = event.target as HTMLElement | null;
  return target?.closest<HTMLElement>(".tab[data-session-id]") ?? null;
}

function reorderDraggedTab(event: DragEvent): void {
  if (!draggingId) return;
  const tab = tabFromEvent(event);
  const targetId = tab?.dataset.sessionId;
  if (!tab || !targetId || targetId === draggingId) return;
  const rect = tab.getBoundingClientRect();
  const placeAfter = event.clientX > rect.left + rect.width / 2;
  if (moveSessionTab(draggingId, targetId, placeAfter)) {
    tabsEl.dataset.sig = "";
    renderSessionTabs();
  }
}

export function initSessionTabs(): void {
  tabsEl.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const close = target.closest<HTMLElement>(".tab-close");
    if (close) {
      event.stopPropagation();
      const id = close.dataset.close;
      if (id) {
        const nextId = closeTabLocally(id);
        post({ type: "closeSession", sessionId: id, activateSessionId: nextId });
      }
      return;
    }
    const tab = target.closest<HTMLElement>(".tab[data-session-id]");
    const id = tab?.dataset.sessionId;
    if (id && id !== getActiveSessionId()) {
      activateTabLocally(id);
      post({ type: "activateSession", sessionId: id });
    }
  });
  tabsEl.addEventListener("dblclick", (event) => {
    const tab = tabFromEvent(event);
    // Active tab only: the first click of a dblclick on a background tab already
    // requested activation — renaming there would race the swap.
    if (!tab || tab.dataset.sessionId !== getActiveSessionId()) return;
    event.preventDefault();
    startTabRename(tab);
  });
  tabsEl.addEventListener("dragstart", (event) => {
    const tab = tabFromEvent(event);
    const id = tab?.dataset.sessionId;
    if (!id || tab?.classList.contains("placeholder")) return;
    draggingId = id;
    tab.classList.add("dragging");
    event.dataTransfer?.setData("text/plain", id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  });
  tabsEl.addEventListener("dragover", (event) => {
    if (!draggingId) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    reorderDraggedTab(event);
  });
  tabsEl.addEventListener("drop", (event) => {
    if (!draggingId) return;
    event.preventDefault();
    reorderDraggedTab(event);
    draggingId = "";
    tabsEl.dataset.sig = "";
    renderSessionTabs();
  });
  tabsEl.addEventListener("dragend", () => {
    if (!draggingId) return;
    draggingId = "";
    tabsEl.dataset.sig = "";
    renderSessionTabs();
  });
}
