import { test } from "node:test";
import assert from "node:assert/strict";
import { stepDetail, normalizeEdits, editDiffHtml, writePreviewHtml, cardFor, deriveTodos, isTodoStep, tokCost } from "../src/webview/cards";
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
