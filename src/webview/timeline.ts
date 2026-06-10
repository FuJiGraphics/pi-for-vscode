// Keyed timeline rendering. Derives one {key, sig, html} spec per row from an activity
// and reconciles the specs against the live DOM, so a step event costs O(changed rows)
// instead of a full message innerHTML rebuild. That's what makes an UNCAPPED timeline
// affordable: every step renders (nothing is sliced away or hidden), element identity
// survives unrelated updates (hover and running CSS animations keep working), and an
// inserted row can carry a one-shot entry animation (`tl-new`) without replaying on later
// renders. render.ts owns when to reconcile vs fully rebuild (its two-part render key).
import { escapeHtml, formatDuration } from "./util";
import { cardFor, effectiveExpanded, isCardCollapsible, stepDetail, timelineRow } from "./cards";
import { deriveTodos, isTodoStep, todoCardHtml } from "./cardsTodo";
import { isTextStep, textStepRowHtml } from "./textSteps";
import { isThinkingStep } from "./thinkingSteps";
import { toolTheme } from "./toolTheme";
import type { Activity, ActivityStep } from "./types";

export interface TimelineRowSpec {
  key: string;
  /** Structural signature: when unchanged the row's DOM is left untouched. */
  sig: string;
  /** Built lazily — unchanged rows never pay the string/card construction. */
  html: () => string;
}

/** Per-step structural signature — the exact fragment messageRenderKey folds, shared so
 *  the row-level and message-level keys can never drift apart. step.thinkingText stays out
 *  (volatile, painter-owned); a text step folds only its LENGTH (immutable after creation). */
export function stepSig(s: ActivityStep): string {
  return (
    s.id + "|" + s.status + "|" + s.label + "|" + (s.tool || "") + "|" + s.detail + "|" +
    (s.output ? "O" : "") + (effectiveExpanded(s) ? "X" : "") +
    (s.kind === "text" ? "T" + (s.text?.length || 0) : "")
  );
}

/** Stamp the row's root element with its reconcile key. Every row builder emits a single
 *  `<div …>` root, so the attribute can be injected uniformly here instead of threading a
 *  key parameter through each builder. */
function withKey(html: string, key: string): string {
  return html.replace(/^<div /, '<div data-key="' + escapeHtml(key) + '" ');
}

export function rowsForActivity(activity: Activity, highlightVersion: number): TimelineRowSpec[] {
  const steps = activity.steps;
  const rows: TimelineRowSpec[] = [];
  // Lead "Thought for Xs" node — the time spent before the first step ran (Claude-style).
  // Suppressed when real thinking steps exist: they carry their own timed rows, and the
  // synthetic lead would double-count the same seconds.
  const firstStart = steps.length ? steps[0].startedAt : activity.endedAt || Date.now();
  if (firstStart - activity.startedAt >= 1500 && !steps.some(isThinkingStep)) {
    const label = "Thought for " + formatDuration(activity.startedAt, firstStart);
    rows.push({ key: "lead", sig: "lead|" + label, html: () => withKey(timelineRow({ status: "done", label }), "lead") });
  }
  if (!steps.length) {
    if (rows.length === 0) {
      rows.push({ key: "prep", sig: "prep", html: () => withKey(timelineRow({ status: "running", label: "Preparing context" }), "prep") });
    }
    return rows;
  }
  // All `todo` calls collapse into ONE consolidated checklist (Claude-style), folded once
  // and rendered at the position of the most recent todo step.
  const hasTodos = steps.some(isTodoStep);
  const todos = hasTodos ? deriveTodos(steps) : [];
  const todoSig = hasTodos ? "todos|" + steps.filter(isTodoStep).map(stepSig).join(";") : "";
  let lastTodoIndex = -1;
  for (let i = 0; i < steps.length; i++) if (isTodoStep(steps[i])) lastTodoIndex = i;

  steps.forEach((step, index) => {
    if (isTodoStep(step)) {
      if (index === lastTodoIndex) {
        rows.push({ key: "todos", sig: todoSig + "@" + highlightVersion, html: () => withKey(todoCardHtml(todos), "todos") });
      }
      return;
    }
    if (isTextStep(step)) {
      rows.push({ key: step.id, sig: stepSig(step) + "@" + highlightVersion, html: () => withKey(textStepRowHtml(step), step.id) });
      return;
    }
    rows.push({
      key: step.id,
      sig: stepSig(step) + "@" + highlightVersion,
      html: () => {
        const theme = toolTheme(step.tool, step.kind);
        return withKey(
          timelineRow({
            id: step.id,
            status: step.status,
            label: step.label,
            detail: stepDetail(step),
            // A done thinking row's label already reads "Thought for Xs" — a time chip would repeat it.
            time: step.endedAt && !isThinkingStep(step) ? formatDuration(step.startedAt, step.endedAt) : "",
            tokens: step.tokens,
            cost: step.cost,
            gen: step.kind === "generation",
            output: step.output,
            expanded: effectiveExpanded(step),
            card: cardFor(step),
            cardCollapsible: isCardCollapsible(step),
            tone: theme.tone || undefined,
            icon: theme.icon,
          }),
          step.id,
        );
      },
    });
  });
  return rows;
}

/** Full-string render of the timeline — the first-mount path (message innerHTML rebuild).
 *  Rows produced here carry the same data-key attributes the reconciler matches on. */
export function timelineRowsHtml(activity: Activity, highlightVersion: number): string {
  return rowsForActivity(activity, highlightVersion).map((row) => row.html()).join("");
}

const rowSigs = new WeakMap<Element, string>();
let scratch: HTMLElement | undefined;
function elementFromHtml(html: string): HTMLElement {
  if (!scratch) scratch = document.createElement("div");
  scratch.innerHTML = html;
  const el = scratch.firstElementChild as HTMLElement;
  scratch.innerHTML = "";
  return el;
}

/** Reconcile the container's children against the row specs: insert missing rows at their
 *  index, rewrite an existing row in place ONLY when its sig changed (element identity —
 *  and with it hover state — survives), drop leftovers (e.g. pruned empty thinking steps).
 *  Returns the inserted/rewritten elements so the caller can scope overflow re-checks. */
export function reconcileTimeline(container: HTMLElement, rows: TimelineRowSpec[]): HTMLElement[] {
  const byKey = new Map<string, HTMLElement>();
  for (const child of Array.from(container.children) as HTMLElement[]) {
    const key = child.dataset.key;
    if (key && !byKey.has(key)) byKey.set(key, child);
  }
  const touched: HTMLElement[] = [];
  const hadRows = container.children.length > 0;
  rows.forEach((row, index) => {
    let el = byKey.get(row.key);
    if (el) {
      byKey.delete(row.key);
      if (rowSigs.get(el) !== row.sig) {
        const next = elementFromHtml(row.html());
        // A live running→finished flip gets the one-shot completion animation; gating it
        // here (not in CSS on .tl-done) keeps full rebuilds from replaying every dot.
        const completed = el.classList.contains("tl-running") && !next.classList.contains("tl-running");
        // In-place rewrite: status classes live on the root, body in the children.
        el.className = next.className + (completed ? " tl-completed" : "");
        if (next.dataset.tone) el.dataset.tone = next.dataset.tone;
        el.innerHTML = next.innerHTML;
        rowSigs.set(el, row.sig);
        touched.push(el);
      }
    } else {
      el = elementFromHtml(row.html());
      rowSigs.set(el, row.sig);
      // Entry animation only for a LIVE insertion into a populated timeline — a full
      // rebuild re-creates every row and must not replay the whole cascade.
      if (hadRows) el.classList.add("tl-new");
      touched.push(el);
    }
    const current = container.children[index] as HTMLElement | undefined;
    if (current !== el) container.insertBefore(el, current ?? null);
  });
  for (const leftover of byKey.values()) leftover.remove();
  while (container.children.length > rows.length) container.lastElementChild!.remove();
  return touched;
}
