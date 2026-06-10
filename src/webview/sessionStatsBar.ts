// Compact context gauge in the composer action row. The visible control shows the
// percent of the model context window currently occupied by this session; token/cost
// session text lives in the hover/focus popover so the composer stays clean.
// Data: pi's get_session_stats (state.stats, per-session).
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
  return { percentUsed, label: percentUsed + "% used" };
}

/** The hover popover body — pure for tests. "" when context is unknown. */
export function statsPopoverHtml(stats: SessionStats): string {
  const ctx = stats.context;
  const ctxInfo = contextLabel(ctx);
  if (!ctx || !ctxInfo) return "";
  const used = (ctx.tokens !== null ? formatTokens(ctx.tokens) + " of " : "") + formatTokens(ctx.contextWindow) + " tokens";
  const summary = statsSummary(stats);
  return (
    '<div class="stats-popover" role="tooltip">' +
    '<div class="sp-title">Context</div>' +
    '<div class="sp-big">' + ctxInfo.percentUsed + "%<span> used</span></div>" +
    '<div class="sp-bar"><span style="width:' + ctxInfo.percentUsed + '%"></span></div>' +
    '<div class="sp-row"><span>Used</span><span>' + escapeHtml(used) + "</span></div>" +
    '<div class="sp-row"><span>Session</span><span>' + escapeHtml(summary) + "</span></div>" +
    "</div>"
  );
}

/** Called from render(). Hidden until the session has context data. */
export function renderSessionStats(): void {
  const stats = state.stats;
  const ctxInfo = stats ? contextLabel(stats.context) : undefined;
  if (!stats || !ctxInfo) {
    sessionStatsEl.hidden = true;
    sessionStatsEl.dataset.sig = "";
    return;
  }
  const summary = statsSummary(stats);
  const sig = summary + "|" + ctxInfo.percentUsed;
  sessionStatsEl.hidden = false;
  if (sessionStatsEl.dataset.sig === sig) return; // unrelated renders don't rewrite (keeps hover stable)
  sessionStatsEl.dataset.sig = sig;

  const tone = ctxInfo.percentUsed > 80 ? "var(--error)" : "var(--accent)";
  sessionStatsEl.innerHTML =
    '<span class="ctx-gauge" style="background: conic-gradient(' + tone + " " +
    ctxInfo.percentUsed + '%, color-mix(in srgb, var(--fg) 14%, transparent) 0)">' +
    '<b class="ctx-gauge-num">' + ctxInfo.percentUsed + "%</b></span>" +
    statsPopoverHtml(stats);
}
