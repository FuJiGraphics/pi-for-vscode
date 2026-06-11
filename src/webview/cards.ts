// Pure, DOM-free builders for the activity timeline: per-tool detail text, the rich card
// bodies (Edit diff / Write preview / Update-Todos checklist), and the timeline row markup.
// Kept free of `state`/`document` so they unit-test directly (string in → string out) and so
// adding a new tool card is a one-line registry entry. render.ts owns the DOM/paint side.
import { escapeHtml, formatTokens, formatCost } from "./util";
import { highlightToLines, langForPath } from "./highlight";
import { thinkingCardHtml } from "./cardsThinking";
import { isThinkingStep } from "./thinkingSteps";
import { normalizeEdits, parsePiDiff, type DiffStats } from "./diffStats";
import type { ActivityStep } from "./types";

// Shorten a step detail for the timeline: file paths collapse to their basename,
// long commands/queries are truncated. Keeps each row to a single readable line.
export function shortenDetail(detail: string): string {
  const d = detail.trim();
  if (!d) return "";
  if (/[\\/]/.test(d) && !/\s/.test(d)) {
    const base = d.split(/[\\/]/).filter(Boolean).pop() || d;
    return base.length > 40 ? base.slice(0, 39) + "…" : base;
  }
  return d.length > 52 ? d.slice(0, 51) + "…" : d;
}

export function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

// Raw pi tool name (e.g. "edit", "web_search") if known, else the pretty label —
// the label collapses many tools into one verb, so cards key off the raw name.
export function toolName(step: ActivityStep): string {
  return (step.tool || step.label || "").toLowerCase();
}

function webQuery(input: Record<string, unknown>): string {
  if (typeof input.query === "string" && input.query) return input.query;
  if (Array.isArray(input.queries)) return input.queries.filter((q): q is string => typeof q === "string" && !!q).join(", ");
  return "";
}

function webUrl(input: Record<string, unknown>): string {
  if (typeof input.url === "string" && input.url) return input.url;
  if (Array.isArray(input.urls)) return input.urls.filter((u): u is string => typeof u === "string" && !!u).join(", ");
  if (typeof input.responseId === "string" && input.responseId) return input.responseId;
  return "";
}

// Claude-style per-tool detail from the raw input args: Read shows "file (lines A–B)",
// Bash shows the command, Edit/Write the file, web tools the query/URL. Falls back to
// the summarized detail for other tools.
export function stepDetail(step: ActivityStep): string {
  // A thinking row carries NO detail: the reasoning must only appear when the row is
  // clicked open (the .tl-thinking card) — a first-line preview here leaked the thought
  // into the step row itself. (The live "Thinking… <last line>" header chip is separate
  // and intentional; see statusLine.ts.)
  if (isThinkingStep(step)) return "";
  const input = step.input || {};
  const t = toolName(step);
  if (t === "read" && typeof input.path === "string" && input.path) {
    const base = basename(input.path);
    // pi's read offset is 1-based (offset:1 == line 1), so use it directly.
    const offset = Number(input.offset);
    const start = Number.isFinite(offset) && offset > 0 ? offset : 1;
    const limit = Number(input.limit);
    const hasLimit = Number.isFinite(limit) && limit > 0;
    const text = step.output?.text;
    if (typeof text === "string" && text.length) {
      // Show the ACTUAL captured range, not the requested limit (a 6-line file read with
      // limit 50 should read "lines 1–6"). Host truncation caps display at 40 lines / 4000
      // chars and appends a "…(truncated)" marker — when that's present the true end is
      // unknown, so fall back to the requested limit range.
      const lines = text.split("\n");
      const truncated = lines[lines.length - 1] === "…(truncated)";
      const count = Math.max((truncated ? lines.length - 1 : lines.length), 1);
      const end = truncated && hasLimit ? start + limit - 1 : start + count - 1;
      return `${base} (lines ${start}–${end})`;
    }
    if (hasLimit) return `${base} (lines ${start}–${start + limit - 1})`;
    return base;
  }
  if (t === "bash" && typeof input.command === "string" && input.command) return input.command;
  if ((t === "edit" || t === "write") && typeof input.path === "string" && input.path) return basename(input.path);
  if (t === "web_search") return webQuery(input) || step.detail;
  if (t === "code_search" && typeof input.query === "string" && input.query) return input.query;
  if (t === "fetch_content" || t === "get_search_content") return webUrl(input) || step.detail;
  return step.detail;
}

// ---- rich card bodies (rendered visible below a timeline row) ----
// (Diff/edit-args parsing lives in diffStats.ts — shared with the +N/-N badge counts.)

const DIFF_MAX = 40;
const READ_MAX = 40;
const WRITE_MAX = 30;

// One gutter row: a right-aligned line-number column, a +/-/space sign column, and the code.
// `codeHtml` MUST already be safe HTML — either escapeHtml(code) for plaintext or a fragment
// from highlightToLines (Shiki output is pre-escaped). `kind` drives the full-height colored
// band (add=green / del=red / ctx,code=neutral).
function gutterRow(lineNo: string, sign: " " | "+" | "-", codeHtml: string, kind: "add" | "del" | "ctx" | "code"): string {
  return (
    '<div class="gl gl-' + kind + '">' +
    '<span class="ln">' + escapeHtml(lineNo) + "</span>" +
    '<span class="sg">' + (sign === " " ? "" : sign) + "</span>" +
    '<span class="cc">' + codeHtml + "</span>" +
    "</div>"
  );
}

function moreRow(n: number): string {
  return '<div class="diff-more">… +' + n + " more</div>";
}

// Hover-revealed control that opens the card in a full-panel scrollable overlay (see cardOverlay.ts).
// Carries the step id so the host-side click handler can rebuild the full card body.
function expandButton(stepId: string | undefined): string {
  if (!stepId) return "";
  return (
    '<button class="tl-expand" data-action="expand-card" data-step-id="' +
    escapeHtml(stepId) +
    '" title="Expand" aria-label="Expand">⤢</button>'
  );
}

// Hover-revealed control that jumps to the touched file in the editor — Edit lands on the
// first changed line (the enriched output.firstChangedLine), Write/Read on the file top.
// Reuses the existing open-file action (messageActions → host fileOpener), so no new wiring.
function openInEditorButton(path: unknown, line?: number): string {
  if (typeof path !== "string" || !path) return "";
  return (
    '<button class="tl-expand tl-open" data-action="open-file" data-path="' +
    escapeHtml(path) +
    '"' +
    (typeof line === "number" && line > 0 ? ' data-line="' + line + '"' : "") +
    ' title="Open in editor" aria-label="Open in editor">↗</button>'
  );
}

// Edit diff card (HYBRID): once pi's real line-numbered unified diff arrives (step.output.diff),
// render it with TRUE file line numbers; until then render the args (oldText/newText) as a
// sign-banded diff with no numbers (they fill in when the diff is enriched a beat later).
export function editDiffHtml(step: ActivityStep): string {
  // Diff lines are syntax-highlighted per-line (GitHub-style): the inline token colors override
  // the .cc text color, while the add/del row background + sign still carry the change meaning.
  // Per-line (not whole-block) because pi's diff lines are non-contiguous old/new versions.
  const lang = langForPath(step.input?.path);
  const cell = (line: string): string => highlightToLines(line, lang)?.[0] ?? escapeHtml(line);
  const openButton = openInEditorButton(step.input?.path, step.output?.firstChangedLine);
  const realDiff = step.output?.diff;
  if (realDiff) {
    const parsed = parsePiDiff(realDiff);
    const rows = parsed
      .slice(0, DIFF_MAX)
      .map((r) => gutterRow(r.lineNo, r.sign, cell(r.content), r.sign === "+" ? "add" : r.sign === "-" ? "del" : "ctx"));
    if (parsed.length > DIFF_MAX) rows.push(moreRow(parsed.length - DIFF_MAX));
    return '<div class="tl-card tl-diff">' + expandButton(step.id) + openButton + rows.join("") + "</div>";
  }

  const edits = normalizeEdits(step.input || {});
  if (!edits.length) return "";
  const rows: string[] = [];
  let count = 0;
  let extra = 0;
  const push = (text: string, sign: "+" | "-", kind: "add" | "del") => {
    for (const line of text.split("\n")) {
      if (count < DIFF_MAX) {
        rows.push(gutterRow("", sign, cell(line), kind));
        count++;
      } else {
        extra++;
      }
    }
  };
  for (const edit of edits) {
    if (edit.oldText) push(edit.oldText, "-", "del");
    if (edit.newText) push(edit.newText, "+", "add");
  }
  if (extra) rows.push(moreRow(extra));
  return '<div class="tl-card tl-diff">' + expandButton(step.id) + openButton + rows.join("") + "</div>";
}

// A line-numbered code block card (capped): file content with a gutter starting at `startLine`.
// Shared by Write (new file, 1..N) and Read (offset..offset+N). The whole block is tokenized
// once via Shiki (per-line HTML); when highlighting is unavailable the line falls back to
// escaped plaintext. `lang` is a Shiki language id ("" → plaintext).
function numberedCodeCard(cssClass: string, content: string, startLine: number, max: number, lang: string, stepId: string | undefined, controls = ""): string {
  if (!content) return "";
  const lines = content.split("\n");
  const highlighted = highlightToLines(content, lang);
  const rows = lines
    .slice(0, max)
    .map((line, i) => gutterRow(String(startLine + i), " ", highlighted?.[i] ?? escapeHtml(line), "code"));
  const more = lines.length > max ? moreRow(lines.length - max) : "";
  return '<div class="tl-card ' + cssClass + '">' + expandButton(stepId) + controls + rows.join("") + more + "</div>";
}

// Write card: the file content being written, line-numbered 1..N (a new file's real lines).
export function writePreviewHtml(step: ActivityStep): string {
  const content = typeof step.input?.content === "string" ? (step.input.content as string) : "";
  return numberedCodeCard("tl-write", content, 1, WRITE_MAX, langForPath(step.input?.path), step.id, openInEditorButton(step.input?.path));
}

// Read card: the fetched content with REAL line numbers from the 1-based `offset` arg. Only
// rendered once the content arrives via enrichment (step.output.text); until then, no body.
export function readCardHtml(step: ActivityStep): string {
  const text = step.output?.text;
  if (!text) return "";
  const offset = Number(step.input?.offset);
  const start = Number.isFinite(offset) && offset > 0 ? offset : 1;
  return numberedCodeCard("tl-read", text, start, READ_MAX, langForPath(step.input?.path), step.id);
}

// Tool-card registry: maps a raw tool name to its always-visible card body. Adding a card for
// a new tool = one entry here + its pure builder above. Tools with no entry render no body.
type CardRenderer = (step: ActivityStep) => string;
const CARD_RENDERERS: Record<string, CardRenderer> = {
  edit: editDiffHtml,
  write: writePreviewHtml,
  read: readCardHtml,
};

// Cards the timeline row can collapse behind a chevron. Edit/Write are collapsible too — a long
// Write preview shouldn't be permanently glued open with no way to dismiss it. They differ only
// in default-open state (see cardDefaultExpanded), not in collapsibility.
const COLLAPSIBLE_CARDS = new Set(["read", "edit", "write"]);

// Default open state for a collapsible card BEFORE the user toggles it. Edit (diff) and Write
// (new-file content) open by default so the change is visible at a glance — they're now just
// collapsible too (the chevron dismisses a long Write). Read defaults closed.
const DEFAULT_EXPANDED_CARDS = new Set(["edit", "write"]);

/** The card body for a step's tool, or "" when the tool has none. */
export function cardFor(step: ActivityStep): string {
  if (isThinkingStep(step)) return thinkingCardHtml(step);
  const render = CARD_RENDERERS[toolName(step)];
  return render ? render(step) : "";
}

/** Whether this step's card is collapsible behind the row's expand chevron. */
export function isCardCollapsible(step: ActivityStep): boolean {
  if (isThinkingStep(step)) return true;
  return COLLAPSIBLE_CARDS.has(toolName(step));
}

/** A collapsible card's open state when the user hasn't toggled it yet. */
export function cardDefaultExpanded(step: ActivityStep): boolean {
  // Thinking streams open (Claude-style live reasoning), then auto-collapses on end;
  // an explicit user toggle still wins via effectiveExpanded.
  if (isThinkingStep(step)) return step.status === "running";
  return DEFAULT_EXPANDED_CARDS.has(toolName(step));
}

// Effective open state of a step's card/output: an explicit user toggle (step.expanded) wins;
// otherwise fall back to the per-tool default. Shared by render (display + render-key) and the
// toggle handler so the FIRST click always flips what the user actually sees — without this a
// default-open card whose step.expanded is still `undefined` would no-op on its first toggle.
export function effectiveExpanded(step: ActivityStep): boolean {
  return typeof step.expanded === "boolean" ? step.expanded : cardDefaultExpanded(step);
}

// ---- timeline row ----

// One node in the Claude-style vertical timeline: a status dot on a connecting rail,
// the terse verb (Read/Edit/Bash…) with its target, and a trailing chip showing how
// long a tool step took. (Token usage rolls up in the status header, not per-row.)
export interface TimelineRow {
  id?: string;
  status: "running" | "done" | "error";
  label: string;
  detail?: string;
  time?: string;
  output?: { text: string; isError: boolean };
  expanded?: boolean;
  /** Rich body (Edit diff / Write preview / Read content), rendered below the row line. */
  card?: string;
  /** When true the card is collapsed by default and the row toggles it (read-only tools). */
  cardCollapsible?: boolean;
  /** Tone name (toolTheme) emitted as data-tone — chat.css maps it to --tool-accent. */
  tone?: string;
  /** TRUSTED inline-SVG glyph (toolTheme constants only) rendered before the label. */
  icon?: string;
  /** Added/removed line counts (Edit/Write) — renders the Codex-style "+N -N" badge. */
  diff?: DiffStats;
}

// The token/cost pair inside a chip uses a vertical bar so it reads like one compact metric.
const METRIC_SEP = " | ";
function tokenLabel(tokens: number): string {
  return formatTokens(tokens) + (tokens === 1 ? " token" : " tokens");
}
export function tokCost(tokens: number, cost?: number): string {
  const formattedCost = formatCost(cost);
  return tokenLabel(tokens) + (formattedCost ? METRIC_SEP + formattedCost : "");
}

/** Hover breakdown for a usage chip — zero segments omitted. */
export function usageTitle(usage: { input: number; output: number; cacheRead: number; cacheWrite: number }): string {
  const parts: string[] = [];
  if (usage.input) parts.push("Input " + formatTokens(usage.input));
  if (usage.output) parts.push("Output " + formatTokens(usage.output));
  if (usage.cacheRead) parts.push("Cache read " + formatTokens(usage.cacheRead));
  if (usage.cacheWrite) parts.push("Cache write " + formatTokens(usage.cacheWrite));
  return parts.join(" · ");
}

// Codex-style "+N -N" badge for Edit/Write rows. Each count carries data-target so the
// post-reconcile pass (render.ts → counters.ts) can roll it up from the previous value.
function diffStatHtml(diff: DiffStats | undefined): string {
  if (!diff || (!diff.added && !diff.removed)) return "";
  const part = (cls: string, prefix: string, n: number): string =>
    n ? '<span class="' + cls + '" data-target="' + n + '">' + prefix + n + "</span>" : "";
  return '<span class="diff-stat">' + part("ds-add", "+", diff.added) + part("ds-del", "-", diff.removed) + "</span>";
}

export function timelineRow(row: TimelineRow): string {
  const detailHtml = row.detail ? '<span class="tl-detail">' + escapeHtml(shortenDetail(row.detail)) + "</span>" : "";
  const rightHtml = row.time ? '<span class="tl-time">' + escapeHtml(row.time) + "</span>" : "";
  // Two kinds of row toggle:
  //  - generic OUTPUT (bash stdout / web result): no rich card → the row toggles a <pre> block.
  //  - collapsible CARD (read-only tools like Read): the row toggles the rich card body.
  // File-changing cards (Edit/Write) are non-collapsible — always visible, no chevron.
  const hasOutput = !!(row.output && row.output.text) && !row.card;
  const collapsibleCard = !!row.card && !!row.cardCollapsible;
  const toggleable = hasOutput || collapsibleCard;
  const chevron = toggleable ? '<span class="tl-chevron">›</span>' : "";
  const rowAttrs = toggleable ? ' data-action="toggle-step" data-step-id="' + escapeHtml(row.id || "") + '"' : "";
  const outputHtml =
    hasOutput && row.expanded
      ? '<pre class="tl-output' + (row.output!.isError ? " error" : "") + '">' + escapeHtml(row.output!.text) + "</pre>"
      : "";
  const cardHtml = row.card ? (collapsibleCard ? (row.expanded ? row.card : "") : row.card) : "";
  const cls =
    "tl-step tl-" + row.status + (toggleable ? " tl-expandable" : "") + (row.expanded ? " expanded" : "");
  const toneAttr = row.tone ? ' data-tone="' + escapeHtml(row.tone) + '"' : "";
  const iconHtml = row.icon ? '<span class="tl-icon" aria-hidden="true">' + row.icon + "</span>" : "";
  return (
    '<div class="' + cls + '"' + toneAttr + '><span class="tl-node"></span>' +
    '<span class="tl-row"' + rowAttrs + ">" + iconHtml + '<span class="tl-label">' + escapeHtml(row.label) + "</span>" + detailHtml + diffStatHtml(row.diff) + rightHtml + chevron + "</span>" +
    cardHtml +
    outputHtml +
    "</div>"
  );
}
