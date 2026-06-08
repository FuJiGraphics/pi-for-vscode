// The `todo` tool's checklist: folding pi's per-call todo mutations into one consolidated
// "Update Todos" card (Claude-style). Pure, DOM-free string builders — same contract as cards.ts
// (string in → string out) so it unit-tests directly. Split out of cards.ts as its own
// responsibility (todo folding ≠ the diff/write/read code-card builders).
import { escapeHtml } from "./util";
import type { ActivityStep } from "./types";

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
