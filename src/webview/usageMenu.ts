// Codex-style "Usage remaining" menu: a small button in the bottom status strip that
// opens a card listing the provider's subscription windows ("5h · 98% · 11:24 PM",
// "Weekly · 32% · Jun 13") and any API rate limits. Data comes from the usage bridge
// (usageData store); when the provider hasn't sent rate-limit headers yet, the menu
// explains that instead of showing nothing.
import { appEl, usageBtnEl, usagePanelEl } from "./dom";
import { escapeHtml } from "./util";
import { hasUsageData, subscribeUsageData, usageMenuRows } from "./usageData";

const GAUGE_ICON =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M8 8l3-2.2"/></svg>';

export function isUsageMenuOpen(): boolean {
  return appEl.classList.contains("usage-open");
}

/** The menu body — pure for tests. */
export function usageMenuHtml(rows = usageMenuRows()): string {
  const head = '<div class="usage-head">' + GAUGE_ICON + "<span>Usage remaining</span></div>";
  if (rows.length === 0) {
    return (
      head +
      '<div class="usage-empty">No usage data reported yet. It appears after the provider answers a request (and only for providers that send rate-limit headers).</div>'
    );
  }
  return (
    head +
    rows
      .map(
        (row) =>
          '<div class="usage-row"><span class="usage-label">' + escapeHtml(row.label) + "</span>" +
          '<span class="usage-value">' + escapeHtml(row.value) + "</span>" +
          '<span class="usage-reset">' + escapeHtml(row.reset) + "</span></div>",
      )
      .join("")
  );
}

function renderPanel(): void {
  usagePanelEl.innerHTML = usageMenuHtml();
}

export function openUsageMenu(): void {
  appEl.classList.remove("history-open", "model-open", "command-open", "thinking-open", "settings-open");
  appEl.classList.add("usage-open");
  renderPanel();
}

export function closeUsageMenu(): void {
  appEl.classList.remove("usage-open");
}

/** Keeps the strip button label fresh; re-renders the panel live while it is open. */
function syncFromStore(): void {
  usageBtnEl.classList.toggle("has-data", hasUsageData());
  if (isUsageMenuOpen()) renderPanel();
}

function handleOutsideClick(event: MouseEvent): void {
  if (!isUsageMenuOpen()) return;
  const target = event.target as Node | null;
  if (!target) return;
  if (usagePanelEl.contains(target) || usageBtnEl.contains(target)) return;
  closeUsageMenu();
}

export function initUsageMenu(): void {
  usageBtnEl.innerHTML = GAUGE_ICON + '<span class="usage-btn-label">Usage</span>';
  usageBtnEl.addEventListener("click", () => {
    if (isUsageMenuOpen()) closeUsageMenu();
    else openUsageMenu();
  });
  document.addEventListener("click", handleOutsideClick);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isUsageMenuOpen()) closeUsageMenu();
  });
  subscribeUsageData(syncFromStore);
  syncFromStore();
}
