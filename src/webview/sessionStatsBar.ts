// The session usage strip above the composer: cumulative tokens · cost on the left,
// a context-usage bar + "N% left" on the right (Claude Code-style). Data comes from
// pi's get_session_stats (state.stats, per-session view) — pi computes cost and the
// compaction-aware context estimate; this module only formats and renders.
import { state } from "./state";
import { sessionStatsEl } from "./dom";
import { escapeHtml, formatCost, formatTokens } from "./util";
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

/** Called from render(). Hidden until the session has real usage. */
export function renderSessionStats(): void {
  const stats = state.stats;
  if (!stats || (stats.tokens.total <= 0 && stats.cost <= 0)) {
    sessionStatsEl.hidden = true;
    sessionStatsEl.dataset.sig = "";
    return;
  }
  const ctx = contextLabel(stats.context);
  const summary = statsSummary(stats);
  const sig = summary + "|" + (ctx ? ctx.percentUsed : "");
  sessionStatsEl.hidden = false;
  if (sessionStatsEl.dataset.sig === sig) return; // unrelated renders don't rewrite
  sessionStatsEl.dataset.sig = sig;

  const usageTitle =
    "Input " + formatTokens(stats.tokens.input) +
    " · Output " + formatTokens(stats.tokens.output) +
    " · Cache read " + formatTokens(stats.tokens.cacheRead) +
    " · Cache write " + formatTokens(stats.tokens.cacheWrite);
  let html = '<span class="stats-usage" title="' + escapeHtml(usageTitle) + '">' + escapeHtml(summary) + "</span>";
  if (ctx && stats.context) {
    const ctxTitle = (stats.context.tokens !== null ? formatTokens(stats.context.tokens) + " of " : "") +
      formatTokens(stats.context.contextWindow) + " context tokens used";
    html +=
      '<span class="stats-context' + (ctx.percentUsed > 80 ? " high" : "") + '" title="' + escapeHtml(ctxTitle) + '">' +
      '<span class="ctx-bar"><span class="ctx-fill" style="width:' + ctx.percentUsed + '%"></span></span>' +
      escapeHtml(ctx.label) +
      "</span>";
  }
  sessionStatsEl.innerHTML = html;
}
