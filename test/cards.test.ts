import { test } from "node:test";
import assert from "node:assert/strict";
import { stepDetail, normalizeEdits, editDiffHtml, writePreviewHtml, cardFor, isCardCollapsible, cardDefaultExpanded, effectiveExpanded, timelineRow, tokCost } from "../src/webview/cards";
import { deriveTodos, isTodoStep } from "../src/webview/cardsTodo";
import { langForPath, highlightToLines } from "../src/webview/highlight";
import type { ActivityStep } from "../src/webview/types";

function step(partial: Partial<ActivityStep>): ActivityStep {
  return { id: "s", label: "", detail: "", status: "done", startedAt: 0, ...partial };
}

test("stepDetail: Read uses the 1-based offset for the line range", () => {
  const s = step({ tool: "read", label: "Read", input: { path: "src/a/b.ts", offset: 5, limit: 10 } });
  assert.equal(stepDetail(s), "b.ts (lines 5–14)");
  // offset defaults to 1 when absent
  assert.equal(stepDetail(step({ tool: "read", input: { path: "x.ts", limit: 3 } })), "x.ts (lines 1–3)");
});

test("stepDetail: Bash → command, Edit/Write → basename, web_search → query", () => {
  assert.equal(stepDetail(step({ tool: "bash", input: { command: "ls -la" } })), "ls -la");
  assert.equal(stepDetail(step({ tool: "edit", input: { path: "/p/q/file.ts" } })), "file.ts");
  assert.equal(stepDetail(step({ tool: "web_search", detail: "x", input: { query: "react vs vue" } })), "react vs vue");
});

test("normalizeEdits handles array, JSON-string, and legacy flat shapes", () => {
  assert.deepEqual(normalizeEdits({ edits: [{ oldText: "a", newText: "b" }] }), [{ oldText: "a", newText: "b" }]);
  assert.deepEqual(normalizeEdits({ edits: '[{"oldText":"a","newText":"b"}]' }), [{ oldText: "a", newText: "b" }]);
  assert.deepEqual(normalizeEdits({ oldText: "x", newText: "y" }), [{ oldText: "x", newText: "y" }]);
  assert.deepEqual(normalizeEdits({}), []);
});

test("editDiffHtml (args/synthetic): banded del then add rows, no line numbers yet", () => {
  const html = editDiffHtml(step({ tool: "edit", input: { edits: [{ oldText: "old", newText: "new" }] } }));
  assert.match(html, /tl-card tl-diff/);
  assert.match(html, /gl gl-del/);
  assert.match(html, /gl gl-add/);
  assert.match(html, /old<\/span>/);
  assert.match(html, /new<\/span>/);
});

test("editDiffHtml (hybrid): pi's real diff wins, with TRUE line numbers in the gutter", () => {
  const s = step({ tool: "edit", input: { edits: [{ oldText: "x", newText: "y" }] }, output: { text: "ok", isError: false, diff: " 92 context\n-93 removed\n+97 added" } });
  const html = editDiffHtml(s);
  assert.match(html, /ln">92<\/span>/); // real file line number
  assert.match(html, /gl-del.*ln">93/s);
  assert.match(html, /gl-add.*ln">97/s);
  assert.match(html, /added<\/span>/);
});

test("cardFor routes via the registry (edit→diff, write→preview; read needs output)", () => {
  assert.match(cardFor(step({ tool: "edit", input: { edits: [{ oldText: "a", newText: "b" }] } })), /tl-diff/);
  assert.match(cardFor(step({ tool: "write", input: { content: "line1\nline2" } })), /tl-write/);
  assert.equal(cardFor(step({ tool: "read", input: { path: "x" } })), ""); // no body until content arrives
  assert.match(cardFor(step({ tool: "read", input: { path: "x", offset: 5 }, output: { text: "a\nb", isError: false } })), /tl-read/);
});

test("readCardHtml numbers lines from the 1-based offset", () => {
  const html = cardFor(step({ tool: "read", input: { path: "x", offset: 5 }, output: { text: "first\nsecond", isError: false } }));
  assert.match(html, /ln">5<\/span>.*first/s);
  assert.match(html, /ln">6<\/span>.*second/s);
});

test("writePreviewHtml numbers 1..N and caps with a '+N more' footer", () => {
  const content = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  const html = writePreviewHtml(step({ tool: "write", input: { content } }));
  assert.match(html, /tl-write/);
  assert.match(html, /ln">1<\/span>/);
  assert.match(html, /\+10 more/);
});

test("deriveTodos folds create/update/delete/clear into the current list", () => {
  const steps: ActivityStep[] = [
    step({ tool: "todo", input: { action: "create", subject: "A", status: "pending" }, output: { text: "Created #1", isError: false } }),
    step({ tool: "todo", input: { action: "create", subject: "B", status: "pending" }, output: { text: "Created #2", isError: false } }),
    step({ tool: "todo", input: { action: "update", id: 1, status: "completed" } }),
    step({ tool: "todo", input: { action: "delete", id: 2 } }),
  ];
  const todos = deriveTodos(steps);
  assert.equal(todos.length, 1);
  assert.equal(todos[0].subject, "A");
  assert.equal(todos[0].status, "completed");

  // clear empties everything
  const cleared = deriveTodos([...steps, step({ tool: "todo", input: { action: "clear" } })]);
  assert.equal(cleared.length, 0);
});

test("isTodoStep + tokCost", () => {
  assert.equal(isTodoStep(step({ tool: "todo" })), true);
  assert.equal(isTodoStep(step({ tool: "edit" })), false);
  assert.equal(tokCost(1), "1 token");
  assert.match(tokCost(5300, 0.03), /5\.3k tokens \| \$0\.03/);
});

test("stepDetail: Read header reflects the ACTUAL returned line count, not the requested limit", () => {
  // 3-line file requested with limit 50 → "(lines 1–3)", not "1–50".
  const s = step({ tool: "read", input: { path: "x.ts", offset: 1, limit: 50 }, output: { text: "a\nb\nc", isError: false } });
  assert.equal(stepDetail(s), "x.ts (lines 1–3)");
  // Truncated output (host cap marker present) → fall back to the requested limit range.
  const t = step({ tool: "read", input: { path: "x.ts", offset: 1, limit: 50 }, output: { text: "a\nb\n…(truncated)", isError: false } });
  assert.equal(stepDetail(t), "x.ts (lines 1–50)");
});

test("isCardCollapsible: read/edit/write cards all collapse behind the row chevron", () => {
  assert.equal(isCardCollapsible(step({ tool: "read" })), true);
  assert.equal(isCardCollapsible(step({ tool: "edit" })), true);
  assert.equal(isCardCollapsible(step({ tool: "write" })), true);
  assert.equal(isCardCollapsible(step({ tool: "bash" })), false);
});

test("thinking steps route through the card layer: open while streaming, collapsed once done", () => {
  const running = step({ kind: "thinking", status: "running", thinkingText: "reasoning…" });
  const done = step({ kind: "thinking", status: "done", thinkingText: "first line\nsecond line", label: "Thought for 4s" });
  assert.match(cardFor(running), /tl-thinking live/);
  assert.match(cardFor(done), /tl-thinking/);
  assert.equal(isCardCollapsible(running), true);
  assert.equal(cardDefaultExpanded(running), true); // live reasoning visible
  assert.equal(cardDefaultExpanded(done), false); // auto-collapse on end
  assert.equal(effectiveExpanded({ ...done, expanded: true }), true); // user toggle wins
  assert.equal(stepDetail(done), "first line"); // collapsed row preview
  assert.equal(stepDetail(running), ""); // live card shows the text itself
  assert.equal(stepDetail(step({ kind: "thinking", status: "done", thinkingText: "x", redacted: true })), "");
});

test("cardDefaultExpanded/effectiveExpanded: Edit/Write open by default, Read collapses; explicit toggle wins", () => {
  // Default-open state (no explicit toggle yet): the change-bearing cards show, Read hides.
  assert.equal(cardDefaultExpanded(step({ tool: "edit" })), true);
  assert.equal(cardDefaultExpanded(step({ tool: "write" })), true);
  assert.equal(cardDefaultExpanded(step({ tool: "read" })), false);
  // effectiveExpanded falls back to the default until step.expanded is set explicitly.
  assert.equal(effectiveExpanded(step({ tool: "write" })), true);
  assert.equal(effectiveExpanded(step({ tool: "read" })), false);
  // An explicit toggle overrides the default in BOTH directions.
  assert.equal(effectiveExpanded(step({ tool: "write", expanded: false })), false);
  assert.equal(effectiveExpanded(step({ tool: "read", expanded: true })), true);
});

test("timelineRow: collapsible card is hidden until expanded and toggles via the row", () => {
  const card = '<div class="tl-card tl-read">body</div>';
  const collapsed = timelineRow({ id: "s1", status: "done", label: "Read", card, cardCollapsible: true, expanded: false });
  assert.match(collapsed, /data-action="toggle-step"/);
  assert.match(collapsed, /tl-chevron/);
  assert.doesNotMatch(collapsed, /tl-card tl-read/); // body withheld while collapsed
  const open = timelineRow({ id: "s1", status: "done", label: "Read", card, cardCollapsible: true, expanded: true });
  assert.match(open, /tl-card tl-read/);
  // A non-collapsible card (bash output, todos) is always rendered, no toggle.
  const fixed = timelineRow({ id: "s2", status: "done", label: "Todos", card: '<div class="tl-card todo-list">d</div>', cardCollapsible: false });
  assert.match(fixed, /tl-card todo-list/);
  assert.doesNotMatch(fixed, /data-action="toggle-step"/);
});

test("timelineRow: a collapsed Write card shows the chevron but withholds its (large) body", () => {
  const card = '<div class="tl-card tl-write">200 lines…</div>';
  const collapsed = timelineRow({ id: "w1", status: "done", label: "Write", card, cardCollapsible: true, expanded: false });
  assert.match(collapsed, /data-action="toggle-step"/);
  assert.match(collapsed, /tl-chevron/);
  assert.doesNotMatch(collapsed, /tl-card tl-write/); // huge preview not glued open
  const open = timelineRow({ id: "w1", status: "done", label: "Write", card, cardCollapsible: true, expanded: true });
  assert.match(open, /tl-card tl-write/);
});

test("cards carry an expand control that opens the overlay", () => {
  const html = cardFor(step({ tool: "write", input: { content: "x" } }));
  assert.match(html, /data-action="expand-card"/);
  assert.match(html, /data-step-id="s"/);
});

test("langForPath maps extensions to Shiki languages, unknown → plaintext", () => {
  assert.equal(langForPath("src/a/b.ts"), "typescript");
  assert.equal(langForPath("x.tsx"), "typescript");
  assert.equal(langForPath("s.py"), "python");
  assert.equal(langForPath("data.json"), "json");
  assert.equal(langForPath("run.sh"), "bash");
  assert.equal(langForPath("notes.unknownext"), "");
  assert.equal(langForPath("Makefile"), "");
  assert.equal(langForPath(undefined), "");
});

test("highlightToLines returns null before the highlighter is initialized (cards fall back to plaintext)", () => {
  assert.equal(highlightToLines("const x = 1;", "typescript"), null);
  assert.equal(highlightToLines("plain", ""), null);
});
