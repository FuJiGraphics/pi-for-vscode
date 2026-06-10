// The bottom status strip's stats cluster: "12.3k tokens · $0.42" plus a circular
// context gauge with the remaining % in its center. Hovering (or focusing) the cluster
// opens a context-only popover — big remaining figure, progress bar, used-of-window
// line. Session token split / cost detail intentionally stay out: the strip summary
// already carries them and the popover reads better saying one thing.
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
  return { percentUsed, label: 100 - percentUsed + "% left" };
}

/** The hover popover body — context only, pure for tests. "" when context is unknown. */
export function statsPopoverHtml(stats: SessionStats): string {
  const ctx = stats.context;
  const ctxInfo = contextLabel(ctx);
  if (!ctx || !ctxInfo) return "";
  const used = (ctx.tokens !== null ? formatTokens(ctx.tokens) + " of " : "") + formatTokens(ctx.contextWindow) + " tokens";
  return (
    '<div class="stats-popover" role="tooltip">' +
    '<div class="sp-title">Context</div>' +
    '<div class="sp-big">' + (100 - ctxInfo.percentUsed) + "%<span> left</span></div>" +
    '<div class="sp-bar"><span style="width:' + ctxInfo.percentUsed + '%"></span></div>' +
    '<div class="sp-row"><span>Used</span><span>' + escapeHtml(used) + "</span></div>" +
    "</div>"
  );
}

/** Called from render(). Hidden until the session has real usage. */
export function renderSessionStats(): void {
  const stats = state.stats;
  if (!stats || (stats.tokens.total <= 0 && stats.cost <= 0)) {
    sessionStatsEl.hidden = true;
    sessionStatsEl.dataset.sig = "";
    return;
  }
  const ctxInfo = contextLabel(stats.context);
  const summary = statsSummary(stats);
  const sig = summary + "|" + (ctxInfo ? ctxInfo.percentUsed : "");
  sessionStatsEl.hidden = false;
  if (sessionStatsEl.dataset.sig === sig) return; // unrelated renders don't rewrite (keeps hover stable)
  sessionStatsEl.dataset.sig = sig;

  let html = '<span class="stats-summary">' + escapeHtml(summary) + "</span>";
  if (ctxInfo) {
    const tone = ctxInfo.percentUsed > 80 ? "var(--error)" : "var(--accent)";
    html +=
      '<span class="ctx-gauge" style="background: conic-gradient(' + tone + " " +
      ctxInfo.percentUsed + '%, color-mix(in srgb, var(--fg) 14%, transparent) 0)">' +
      '<b class="ctx-gauge-num">' + (100 - ctxInfo.percentUsed) + "%</b></span>";
  }
  html += statsPopoverHtml(stats);
  sessionStatsEl.innerHTML = html;
}
