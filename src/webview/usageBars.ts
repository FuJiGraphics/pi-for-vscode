// Compact subscription usage control in the composer action row: one icon that opens a
// hover/focus popover with the 5h / 1w used-usage gauges. Subscription windows are an
// OpenAI-Codex-OAuth concept, so the control exists only while that login has real usage
// data — other providers bill per token and have no such windows.
import type { AuthProviderStatus } from "../protocol";
import { authProviders, subscribeAuthState } from "./authState";
import { usageBarsEl } from "./dom";
import { escapeHtml } from "./util";
import { hasUsageData, subscribeUsageData, usageBarRows, type UsageBarRow } from "./usageData";

/** Pure gate: the usage UI exists only for an openai-codex OAuth login. */
export function usageAvailable(providers: readonly AuthProviderStatus[]): boolean {
  return providers.some((p) => p.id === "openai-codex" && p.authType === "oauth");
}

const USAGE_ICON =
  '<svg class="usage-control-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 13V7.8"/><path d="M8 13V3"/><path d="M13 13V5.8"/><path d="M2.4 13.2h11.2"/></svg>';

/** The compact control body — pure for tests. "" when there is nothing to show (control hidden). */
export function usageBarsHtml(rows: UsageBarRow[] = usageBarRows()): string {
  if (rows.length === 0) return "";
  return (
    USAGE_ICON +
    '<div class="usage-popover" role="tooltip">' +
    rows
      .map((row) => {
        const percent = Math.max(0, Math.min(100, Math.round(row.usedPercent)));
        const reset = row.reset ? '<span class="usage-reset">Resets ' + escapeHtml(row.reset) + "</span>" : "";
        return (
          '<div class="usage-bar' + (percent >= 80 ? " high" : "") + '">' +
          '<div class="usage-bar-track">' +
          '<span class="usage-bar-fill" style="width:' + percent + '%"></span>' +
          '<span class="usage-bar-label">' + escapeHtml(row.label) + "</span>" +
          '<span class="usage-bar-value">' + percent + "%</span>" +
          "</div>" +
          reset +
          "</div>"
        );
      })
      .join("") +
    "</div>"
  );
}

function syncFromStore(): void {
  const html = usageAvailable(authProviders()) && hasUsageData() ? usageBarsHtml() : "";
  usageBarsEl.hidden = html === "";
  if (usageBarsEl.innerHTML !== html) usageBarsEl.innerHTML = html;
}

export function initUsageBars(): void {
  subscribeUsageData(syncFromStore);
  subscribeAuthState(syncFromStore);
  syncFromStore();
}
