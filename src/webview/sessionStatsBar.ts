// The bottom status strip's usage cluster (Codex-style): "12.3k tokens · $0.42" plus a
// circular context gauge with the % remaining. Hovering (or focusing) the cluster opens a
// rich popover: context breakdown with a mini bar, the session's input/output/cache token
// split, the estimated API cost (pi's price-table conversion — labeled "Est." so
// subscription users don't read it as a bill), and — when the usage bridge reported
// provider rate-limit headers — a Codex-style "Usage remaining" section.
// Data: pi's get_session_stats (state.stats, per-session) + usageData (global).
import { state } from "./state";
import { sessionStatsEl } from "./dom";
import { escapeHtml, formatCost, formatTokens } from "./util";
import { usageSummaryRows } from "./usageData";
import type { SessionStats } from "../protocol";

/** "12.3k tokens · $0.42" — cost omitted for free models (formatCost drops $0). */
export function statsSummary(stats: SessionStats): string {
  const tokens = formatTokens(stats.tokens.total) + " tokens";
  const cost = formatCost(stats.cost);
  return cost ? tokens + " · " + cost : tokens;
}

/** Context segment, or undefined when unknown (post-compaction null / no contextWindow). */
export function contextLabel(ctx: SessionStats["context"]): { percentUsed: number; label: string } | undefined {
  if (!ctx || ctx.percent === null) return undefined;
  const percentUsed = Math.min(100, Math.max(0, Math.round(ctx.percent)));
  return { percentUsed, label: 100 - percentUsed + "% left" };
}

function popoverRow(label: string, value: string): string {
  return '<div class="sp-row"><span>' + escapeHtml(label) + "</span><span>" + escapeHtml(value) + "</span></div>";
}

/** The hover popover body — pure for tests. */
export function statsPopoverHtml(stats: SessionStats, usage = usageSummaryRows()): string {
  let html = "";
  const ctx = stats.context;
  const ctxInfo = contextLabel(ctx);
  if (ctx && ctxInfo) {
    const used = (ctx.tokens !== null ? formatTokens(ctx.tokens) + " of " : "") + formatTokens(ctx.contextWindow) + " tokens";
    html +=
      '<div class="sp-title">Context</div>' +
      popoverRow(used, ctxInfo.label) +
      '<div class="sp-bar"><span style="width:' + ctxInfo.percentUsed + '%"></span></div>';
  }
  const t = stats.tokens;
  html += '<div class="sp-title">Session</div>';
  if (t.input) html += popoverRow("Input", formatTokens(t.input));
  if (t.output) html += popoverRow("Output", formatTokens(t.output));
  if (t.cacheRead) html += popoverRow("Cache read", formatTokens(t.cacheRead));
  if (t.cacheWrite) html += popoverRow("Cache write", formatTokens(t.cacheWrite));
  html += popoverRow("Total", formatTokens(t.total) + " tokens");
  const cost = formatCost(stats.cost);
  if (cost) html += popoverRow("Est. API cost", cost);
  if (usage.length) {
    html += '<div class="sp-title">Usage remaining</div>';
    for (const row of usage) html += popoverRow(row.label, row.value);
  }
  return '<div class="stats-popover" role="tooltip">' + html + "</div>";
}

/** Called from render(). Hidden until the session has real usage. */
export function renderSessionStats(): void {
  const stats = state.stats;
  if (!stats || (stats.tokens.total <= 0 && stats.cost <= 0)) {
    sessionStatsEl.hidden = true;
    sessionStatsEl.dataset.sig = "";
    return;
  }
  const usage = usageSummaryRows();
  const ctxInfo = contextLabel(stats.context);
  const summary = statsSummary(stats);
  const sig = summary + "|" + (ctxInfo ? ctxInfo.percentUsed : "") + "|" + usage.map((r) => r.label + r.value).join(";");
  sessionStatsEl.hidden = false;
  if (sessionStatsEl.dataset.sig === sig) return; // unrelated renders don't rewrite (keeps hover stable)
  sessionStatsEl.dataset.sig = sig;

  let html = '<span class="stats-summary">' + escapeHtml(summary) + "</span>";
  if (ctxInfo) {
    const tone = ctxInfo.percentUsed > 80 ? "var(--error)" : "var(--accent)";
    html +=
      '<span class="ctx-gauge" aria-hidden="true" style="background: conic-gradient(' + tone + " " +
      ctxInfo.percentUsed + '%, color-mix(in srgb, var(--fg) 14%, transparent) 0)"></span>' +
      '<span class="ctx-pct">' + escapeHtml(ctxInfo.label) + "</span>";
  }
  html += statsPopoverHtml(stats, usage);
  sessionStatsEl.innerHTML = html;
}
