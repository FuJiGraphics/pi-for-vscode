// Pure, DOM-free builders for the activity timeline: per-tool detail text, the rich card
// bodies (Edit diff / Write preview / Update-Todos checklist), and the timeline row markup.
// Kept free of `state`/`document` so they unit-test directly (string in → string out) and so
// adding a new tool card is a one-line registry entry. render.ts owns the DOM/paint side.
import { escapeHtml, formatTokens, formatCost } from "./util";
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
  const input = step.input || {};
  const t = toolName(step);
  if (t === "read" && typeof input.path === "string" && input.path) {
    const base = basename(input.path);
    const limit = Number(input.limit);
    if (Number.isFinite(limit) && limit > 0) {
      // pi's read offset is 1-based (offset:1 == line 1), so use it directly.
      const offset = Number(input.offset);
      const start = Number.isFinite(offset) && offset > 0 ? offset : 1;
      return `${base} (lines ${start}–${start + limit - 1})`;
    }
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

// Normalize pi's edit args into [{oldText,newText}]: the schema is an `edits` array, but
// some models send it as a JSON string, and the legacy shape is a flat oldText/newText.
export function normalizeEdits(input: Record<string, unknown>): Array<{ oldText: string; newText: string }> {
  let edits: unknown = input.edits;
  if (typeof edits === "string") {
    try {
      edits = JSON.parse(edits);
    } catch {
      edits = undefined;
    }
  }
  if (Array.isArray(edits)) {
    return edits
      .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
      .map((e) => ({ oldText: typeof e.oldText === "string" ? e.oldText : "", newText: typeof e.newText === "string" ? e.newText : "" }));
  }
  if (typeof input.oldText === "string" || typeof input.newText === "string") {
    return [{ oldText: typeof input.oldText === "string" ? input.oldText : "", newText: typeof input.newText === "string" ? input.newText : "" }];
  }
  return [];
}

const DIFF_MAX = 40;
const READ_MAX = 40;
const WRITE_MAX = 30;

// One gutter row: a right-aligned line-number column, a +/-/space sign column, and the code.
// `kind` drives the full-height colored band (add=green / del=red / ctx,code=neutral).
function gutterRow(lineNo: string, sign: " " | "+" | "-", code: string, kind: "add" | "del" | "ctx" | "code"): string {
  return (
    '<div class="gl gl-' + kind + '">' +
    '<span class="ln">' + escapeHtml(lineNo) + "</span>" +
    '<span class="sg">' + (sign === " " ? "" : sign) + "</span>" +
    '<span class="cc">' + escapeHtml(code) + "</span>" +
    "</div>"
  );
}

function moreRow(n: number): string {
  return '<div class="diff-more">… +' + n + " more</div>";
}

// Parse pi's real edit diff (details.diff): lines are "<sign><lineNo> <content>", sign one of
// space/+/-. Non-matching lines render as neutral context with no number.
function parsePiDiff(diff: string): Array<{ lineNo: string; sign: " " | "+" | "-"; content: string }> {
  const out: Array<{ lineNo: string; sign: " " | "+" | "-"; content: string }> = [];
  for (const line of diff.split("\n")) {
    const m = /^([ +-])(\d+) ?(.*)$/.exec(line);
    if (m) out.push({ sign: m[1] as " " | "+" | "-", lineNo: m[2], content: m[3] });
    else if (line.length) out.push({ sign: " ", lineNo: "", content: line });
  }
  return out;
}

// Edit diff card (HYBRID): once pi's real line-numbered unified diff arrives (step.output.diff),
// render it with TRUE file line numbers; until then render the args (oldText/newText) as a
// sign-banded diff with no numbers (they fill in when the diff is enriched a beat later).
export function editDiffHtml(step: ActivityStep): string {
  const realDiff = step.output?.diff;
  if (realDiff) {
    const parsed = parsePiDiff(realDiff);
    const rows = parsed
      .slice(0, DIFF_MAX)
      .map((r) => gutterRow(r.lineNo, r.sign, r.content, r.sign === "+" ? "add" : r.sign === "-" ? "del" : "ctx"));
    if (parsed.length > DIFF_MAX) rows.push(moreRow(parsed.length - DIFF_MAX));
    return '<div class="tl-card tl-diff">' + rows.join("") + "</div>";
  }

  const edits = normalizeEdits(step.input || {});
  if (!edits.length) return "";
  const rows: string[] = [];
  let count = 0;
  let extra = 0;
  const push = (text: string, sign: "+" | "-", kind: "add" | "del") => {
    for (const line of text.split("\n")) {
      if (count < DIFF_MAX) {
        rows.push(gutterRow("", sign, line, kind));
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
  return '<div class="tl-card tl-diff">' + rows.join("") + "</div>";
}

// A line-numbered code block card (capped): file content with a gutter starting at `startLine`.
// Shared by Write (new file, 1..N) and Read (offset..offset+N).
function numberedCodeCard(cssClass: string, content: string, startLine: number, max: number): string {
  if (!content) return "";
  const lines = content.split("\n");
  const rows = lines.slice(0, max).map((line, i) => gutterRow(String(startLine + i), " ", line, "code"));
  const more = lines.length > max ? moreRow(lines.length - max) : "";
  return '<div class="tl-card ' + cssClass + '">' + rows.join("") + more + "</div>";
}

// Write card: the file content being written, line-numbered 1..N (a new file's real lines).
export function writePreviewHtml(step: ActivityStep): string {
  const content = typeof step.input?.content === "string" ? (step.input.content as string) : "";
  return numberedCodeCard("tl-write", content, 1, WRITE_MAX);
}

// Read card: the fetched content with REAL line numbers from the 1-based `offset` arg. Only
// rendered once the content arrives via enrichment (step.output.text); until then, no body.
export function readCardHtml(step: ActivityStep): string {
  const text = step.output?.text;
  if (!text) return "";
  const offset = Number(step.input?.offset);
  const start = Number.isFinite(offset) && offset > 0 ? offset : 1;
  return numberedCodeCard("tl-read", text, start, READ_MAX);
}

// Tool-card registry: maps a raw tool name to its always-visible card body. Adding a card for
// a new tool = one entry here + its pure builder above. Tools with no entry render no body.
type CardRenderer = (step: ActivityStep) => string;
const CARD_RENDERERS: Record<string, CardRenderer> = {
  edit: editDiffHtml,
  write: writePreviewHtml,
  read: readCardHtml,
};

/** The always-visible card body for a step's tool, or "" when the tool has none. */
export function cardFor(step: ActivityStep): string {
  const render = CARD_RENDERERS[toolName(step)];
  return render ? render(step) : "";
}

// ---- todo checklist (consolidated from the turn's `todo` tool calls) ----

export interface DerivedTodo {
  id: string;
  subject: string;
  status: string;
  activeForm?: string;
}

export function isTodoStep(step: ActivityStep): boolean {
  return (step.tool || "").toLowerCase() === "todo";
}

// pi's `todo` tool mutates one task per call (create/update/delete/clear); fold the whole
// sequence into the current list, like Claude's single "Update Todos" checklist. The created
// id only appears in the tool's output ("Created #N"), so create rows resolve once enriched.
export function deriveTodos(steps: ActivityStep[]): DerivedTodo[] {
  const map = new Map<string, DerivedTodo>();
  const order: string[] = [];
  for (const step of steps) {
    if (!isTodoStep(step)) continue;
    const a = step.input || {};
    const action = String(a.action || "");
    if (action === "clear") {
      map.clear();
      order.length = 0;
      continue;
    }
    if (action === "list" || action === "get") continue;
    if (action === "create") {
      const matched = step.output?.text ? /#(\d+)/.exec(step.output.text) : null;
      const id = matched ? matched[1] : "new:" + (typeof a.subject === "string" ? a.subject : order.length);
      if (!map.has(id)) order.push(id);
      map.set(id, {
        id,
        subject: typeof a.subject === "string" ? a.subject : "(task)",
        status: typeof a.status === "string" ? a.status : "pending",
        activeForm: typeof a.activeForm === "string" ? a.activeForm : undefined,
      });
      continue;
    }
    const id = a.id != null ? String(a.id) : "";
    if (!id) continue;
    if (action === "delete") {
      map.delete(id);
      const at = order.indexOf(id);
      if (at !== -1) order.splice(at, 1);
      continue;
    }
    if (action === "update") {
      const cur = map.get(id) || { id, subject: "#" + id, status: "pending" };
      if (!map.has(id)) order.push(id);
      if (typeof a.status === "string") cur.status = a.status;
      if (typeof a.subject === "string") cur.subject = a.subject;
      if (typeof a.activeForm === "string") cur.activeForm = a.activeForm;
      map.set(id, cur);
    }
  }
  return order.map((id) => map.get(id)).filter((t): t is DerivedTodo => !!t);
}

function todoGlyph(status: string): string {
  if (status === "completed") return "☑";
  if (status === "in_progress") return "◐";
  if (status === "deleted") return "☒";
  return "☐";
}

// Renders the consolidated checklist from an already-derived todo list (caller folds once).
export function todoCardHtml(todos: DerivedTodo[]): string {
  const done = todos.filter((t) => t.status === "completed").length;
  const body = todos.length
    ? todos
        .map((t) => {
          const text = t.status === "in_progress" && t.activeForm ? t.activeForm : t.subject;
          return '<div class="todo-item todo-' + escapeHtml(t.status) + '"><span class="todo-box">' + todoGlyph(t.status) + '</span><span class="todo-text">' + escapeHtml(text) + "</span></div>";
        })
        .join("")
    : '<div class="todo-item todo-empty"><span class="todo-text">No active todos</span></div>';
  const count = todos.length ? '<span class="tl-detail">' + done + "/" + todos.length + "</span>" : "";
  return (
    '<div class="tl-step tl-done tl-todo"><span class="tl-node"></span>' +
    '<span class="tl-row"><span class="tl-label">Update Todos</span>' + count + "</span>" +
    '<div class="tl-card todo-list">' + body + "</div></div>"
  );
}

// ---- timeline row ----

// One node in the Claude-style vertical timeline: a status dot on a connecting rail,
// the terse verb (Read/Edit/Bash…) with its target, and a trailing chip — the tokens a
// generation checkpoint spent, or how long a tool step took.
export interface TimelineRow {
  id?: string;
  status: "running" | "done" | "error";
  label: string;
  detail?: string;
  time?: string;
  tokens?: number;
  cost?: number;
  gen?: boolean;
  output?: { text: string; isError: boolean };
  expanded?: boolean;
  /** Always-visible rich body (Edit diff / Write preview), rendered below the row line. */
  card?: string;
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

export function timelineRow(row: TimelineRow): string {
  const detailHtml = row.detail ? '<span class="tl-detail">' + escapeHtml(shortenDetail(row.detail)) + "</span>" : "";
  let rightHtml = "";
  if (row.tokens) {
    rightHtml = '<span class="tl-tok">' + escapeHtml(tokCost(row.tokens, row.cost)) + "</span>";
  } else if (row.time) {
    rightHtml = '<span class="tl-time">' + escapeHtml(row.time) + "</span>";
  }
  // A finished tool with output is a clickable card: the row toggles an OUT block below it.
  // When the row already has an always-visible card body (Edit diff / Write / Read content),
  // that IS the output view — so skip the redundant chevron + raw OUT toggle.
  const hasOutput = !!(row.output && row.output.text) && !row.card;
  const chevron = hasOutput ? '<span class="tl-chevron">›</span>' : "";
  const rowAttrs = hasOutput ? ' data-action="toggle-step" data-step-id="' + escapeHtml(row.id || "") + '"' : "";
  const outputHtml =
    hasOutput && row.expanded
      ? '<pre class="tl-output' + (row.output!.isError ? " error" : "") + '">' + escapeHtml(row.output!.text) + "</pre>"
      : "";
  const cls =
    "tl-step tl-" + row.status + (row.gen ? " tl-gen" : "") + (hasOutput ? " tl-expandable" : "") + (row.expanded ? " expanded" : "");
  return (
    '<div class="' + cls + '"><span class="tl-node"></span>' +
    '<span class="tl-row"' + rowAttrs + '><span class="tl-label">' + escapeHtml(row.label) + "</span>" + detailHtml + rightHtml + chevron + "</span>" +
    (row.card || "") +
    outputHtml +
    "</div>"
  );
}
