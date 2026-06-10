// Always-visible subscription usage bars in a dedicated row above the composer: one
// rounded gauge per window ("5h", "1w"), filled by the percent REMAINING (battery
// metaphor — 1% used renders a 99% bar) with the label inside-left, the number
// inside-right, and the reset time in a hover/focus popover. Subscription windows are
// currently an OpenAI-Codex-OAuth concept, so the whole row exists only while that
// login does — other providers bill per token and have no such windows.
import type { AuthProviderStatus } from "../protocol";
import { authProviders, subscribeAuthState } from "./authState";
import { usageBarsEl } from "./dom";
import { escapeHtml } from "./util";
import { hasUsageData, subscribeUsageData, usageBarRows, type UsageBarRow } from "./usageData";

/** Pure gate: the usage UI exists only for an openai-codex OAuth login. */
export function usageAvailable(providers: readonly AuthProviderStatus[]): boolean {
  return providers.some((p) => p.id === "openai-codex" && p.authType === "oauth");
}

/** The bars row body — pure for tests. "" when there is nothing to show (row hidden). */
export function usageBarsHtml(rows: UsageBarRow[] = usageBarRows()): string {
  return rows
    .map((row) => {
      const percent = Math.max(0, Math.min(100, Math.round(row.remainingPercent)));
      const reset = row.reset
        ? '<span class="usage-bar-pop" role="tooltip">Resets ' + escapeHtml(row.reset) + "</span>"
        : "";
      return (
        '<div class="usage-bar' + (percent < 20 ? " low" : "") + '" tabindex="0">' +
        '<span class="usage-bar-fill" style="width:' + percent + '%"></span>' +
        '<span class="usage-bar-label">' + escapeHtml(row.label) + "</span>" +
        '<span class="usage-bar-value">' + percent + "%</span>" +
        reset +
        "</div>"
      );
    })
    .join("");
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
