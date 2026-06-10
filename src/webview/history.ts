// Claude-style session history: a small floating popover toggled by the clock
// icon. Shows a searchable session list; hovering an item reveals rename
// (inline edit) and delete actions. Picking an item switches to that session.
import { appEl, historyBtnEl, historyListEl, historyPanelEl, historySearchEl } from "./dom";
import { post } from "./bridge";
import { escapeHtml } from "./util";
import type { SessionListItem } from "../protocol";

const PENCIL_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';

const TRASH_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

let allSessions: SessionListItem[] = [];

export function isHistoryOpen(): boolean {
  return appEl.classList.contains("history-open");
}

export function openHistory(): void {
  appEl.classList.remove("model-open"); // mutually exclusive with the model picker
  appEl.classList.remove("command-open"); // and with the slash-command palette
  appEl.classList.remove("thinking-open");
  appEl.classList.remove("settings-open");
  appEl.classList.add("history-open");
  historySearchEl.value = "";
  historyListEl.innerHTML = '<div class="history-empty">Loading sessions…</div>';
  post({ type: "requestSessions" });
  historySearchEl.focus();
}

export function closeHistory(): void {
  appEl.classList.remove("history-open");
}

export function toggleHistory(): void {
  if (isHistoryOpen()) closeHistory();
  else openHistory();
}

function itemHtml(session: SessionListItem): string {
  // The trailing middot is gone — .current-tag carries its own right-margin so it can't
  // collide with the needs-input / running badges that share the meta line.
  const currentTag = session.isCurrent ? '<span class="current-tag">Current</span>' : "";
  // A background runtime is live on this session: needs-input (blocked on a prompt the
  // user must answer by switching here) takes precedence over a plain running spinner.
  const badge = session.needsInput
    ? '<span class="history-badge needs-input" title="Waiting for your input">●</span> '
    : session.isRunning
    ? '<span class="history-badge running" title="Running"><span class="hb-spinner"></span></span> '
    : "";
  // No conversation-content preview line here — it made the list noisy. The title
  // (session name / first user message) + meta is enough; preview still feeds search below.
  return (
    '<div class="history-item' +
    (session.isCurrent ? " current" : "") +
    '" data-path="' +
    escapeHtml(session.filePath) +
    '"><div class="history-main"><div class="history-title">' +
    escapeHtml(session.title) +
    '</div><div class="history-meta">' +
    badge +
    currentTag +
    escapeHtml(session.meta) +
    "</div>" +
    '</div><div class="history-actions">' +
    '<button class="history-action rename" data-action="rename" title="Rename" aria-label="Rename">' +
    PENCIL_ICON +
    '</button><button class="history-action delete" data-action="delete" title="Delete" aria-label="Delete">' +
    TRASH_ICON +
    "</button></div></div>"
  );
}

function applyFilter(): void {
  const query = historySearchEl.value.trim().toLowerCase();
  const filtered = query
    ? allSessions.filter((s) => (s.title + " " + (s.preview || "") + " " + s.meta).toLowerCase().includes(query))
    : allSessions;
  if (filtered.length === 0) {
    historyListEl.innerHTML =
      '<div class="history-empty">' +
      (allSessions.length === 0 ? "No saved Pi sessions yet." : "No sessions match your search.") +
      "</div>";
    return;
  }
  historyListEl.innerHTML = filtered.map(itemHtml).join("");
}

export function renderSessionList(sessions: SessionListItem[]): void {
  allSessions = Array.isArray(sessions) ? sessions : [];
  if (isHistoryOpen()) applyFilter();
}

function startRename(item: HTMLElement): void {
  const path = item.dataset.path;
  const titleEl = item.querySelector(".history-title") as HTMLElement | null;
  if (!path || !titleEl) return;
  const currentTitle = titleEl.textContent || "";

  const input = document.createElement("input");
  input.className = "history-rename";
  input.value = currentTitle;
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const commit = (): void => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (name && name !== currentTitle) {
      post({ type: "renameSession", sessionPath: path, name });
      // The list refreshes when the extension re-sends sessionList.
    } else {
      applyFilter();
    }
  };
  const cancel = (): void => {
    if (done) return;
    done = true;
    applyFilter();
  };

  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  });
  input.addEventListener("blur", cancel);
}

function handleListClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  const item = target && target.closest ? (target.closest(".history-item") as HTMLElement | null) : null;
  if (!item) return;
  const path = item.dataset.path;
  if (!path) return;

  const action = target && target.closest ? (target.closest(".history-action") as HTMLElement | null) : null;
  if (action) {
    event.stopPropagation();
    if (action.dataset.action === "delete") post({ type: "deleteSession", sessionPath: path });
    else if (action.dataset.action === "rename") startRename(item);
    return;
  }

  post({ type: "switchSession", sessionPath: path });
  closeHistory();
}

function handleOutsideClick(event: MouseEvent): void {
  if (!isHistoryOpen()) return;
  const target = event.target as Node | null;
  if (!target) return;
  if (historyPanelEl.contains(target) || historyBtnEl.contains(target)) return;
  closeHistory();
}

export function initHistory(): void {
  historyListEl.addEventListener("click", handleListClick);
  historySearchEl.addEventListener("input", applyFilter);
  historySearchEl.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeHistory();
    }
  });
  document.addEventListener("click", handleOutsideClick);
}
