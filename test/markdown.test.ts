import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../src/webview/markdown";

// markdown.ts is pure (string → string): markdown-it is real, Shiki's highlightToLines returns
// null in Node (highlighter never initialized) so fenced blocks fall back to escaped plaintext.
// No DOM/bridge needed.

test("headings, paragraphs, lists render as block HTML", () => {
  const html = renderMarkdown("# Title\n\nintro\n\n- one\n- two");
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<p>intro<\/p>/);
  assert.match(html, /<ul>\s*<li>one<\/li>\s*<li>two<\/li>\s*<\/ul>/);
});

test("inline code with no path shape renders as a plain <code> chip", () => {
  const html = renderMarkdown("call `doStuff()` here");
  assert.match(html, /<code>doStuff\(\)<\/code>/);
  assert.doesNotMatch(html, /file-link/);
});

test("fenced code block: card header (lang label + Copy/Insert/Apply), language class, plaintext fallback when Shiki is cold", () => {
  const html = renderMarkdown("```ts\nconst y = 1;\n```");
  assert.match(html, /<div class="md-code-block">/);
  assert.match(html, /<span class="md-code-lang">typescript<\/span>/); // ts → canonical label
  assert.match(html, /data-action="copy-code"/);
  assert.match(html, /data-action="insert-code"/);
  assert.match(html, /data-action="apply-code"/);
  assert.match(html, /<pre class="md-code"><code class="language-typescript">/);
  assert.match(html, /const y = 1;/);
  assert.doesNotMatch(html, /file-link/); // paths inside code are never linkified
});

test("unlabeled fence shows 'text', diff fence carries the diff language class", () => {
  assert.match(renderMarkdown("```\nplain\n```"), /<span class="md-code-lang">text<\/span>/);
  assert.match(renderMarkdown("```diff\n+added\n-removed\n```"), /class="language-diff"/);
});

test("GFM task lists render as read-only checkboxes", () => {
  const html = renderMarkdown("- [ ] todo\n- [x] done");
  assert.match(html, /class="contains-task-list"/);
  assert.match(html, /class="task-list-item-checkbox"[^>]*disabled/);
  assert.match(html, /checked/); // the [x] item
});

test("tables and strikethrough are enabled (GFM defaults)", () => {
  const table = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |");
  assert.match(table, /<table>/);
  assert.match(table, /<th>a<\/th>/);
  assert.match(table, /<td>1<\/td>/);
  assert.match(renderMarkdown("~~gone~~"), /<s>gone<\/s>/);
});

test("raw HTML in model output is escaped (html:false) — no live tags injected", () => {
  const html = renderMarkdown("<script>alert(1)</script>");
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("bare URLs autolink (linkify)", () => {
  assert.match(renderMarkdown("visit https://example.com now"), /<a href="https:\/\/example\.com"/);
});

test("fuzzy linking off: bare TLD-extension tokens (deploy.sh, config.io) are NOT external links", () => {
  assert.doesNotMatch(renderMarkdown("run deploy.sh to ship"), /<a href=/);
  assert.doesNotMatch(renderMarkdown("see config.io for details"), /<a href=/);
});

test("file references in prose become clickable file-link anchors", () => {
  const html = renderMarkdown("see src/foo.ts:42 please");
  assert.match(html, /class="file-link"/);
  assert.match(html, /data-action="open-file"/);
  assert.match(html, /data-path="src\/foo\.ts"/);
  assert.match(html, /data-line="42"/);
});

test("a file path written as INLINE CODE is also linkified (but bare identifiers stay plain)", () => {
  const path = renderMarkdown("edited `Assets/A_Scripts/Foo.cs` today");
  assert.match(path, /<code><a class="file-link"[^>]*data-path="Assets\/A_Scripts\/Foo\.cs"/);
  // a code identifier with no separator / line is NOT linkified
  assert.doesNotMatch(renderMarkdown("use `HashSet` here"), /file-link/);
});
