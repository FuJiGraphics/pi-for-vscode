import { test } from "node:test";
import assert from "node:assert/strict";
import { linkifyFileRefs } from "../src/webview/fileLinks";

// linkifyFileRefs operates on already-HTML-escaped text (a markdown-it text token). The inputs
// below are plain ASCII so escaping is a no-op.

test("path with :line:col → anchor carries path/line/col", () => {
  const out = linkifyFileRefs("at src/a/b.ts:42:5 now");
  assert.match(out, /class="file-link"/);
  assert.match(out, /data-action="open-file"/);
  assert.match(out, /data-path="src\/a\/b\.ts"/);
  assert.match(out, /data-line="42"/);
  assert.match(out, /data-col="5"/);
});

test("path with a separator but no line is linkified (no data-line)", () => {
  const out = linkifyFileRefs("open src/foo.ts here");
  assert.match(out, /data-path="src\/foo\.ts"/);
  assert.doesNotMatch(out, /data-line=/);
});

test("bare filename with an explicit :line is linkified (high-confidence)", () => {
  const out = linkifyFileRefs("foo.ts:10 failed");
  assert.match(out, /data-path="foo\.ts"/);
  assert.match(out, /data-line="10"/);
});

test("conservative: no separator and no line → left as plain text", () => {
  for (const s of ["Node.js", "e.g. this", "see app.config.js", "version 4.2.1", "a file.ts here"]) {
    assert.equal(linkifyFileRefs(s), s, `should not linkify: ${s}`);
  }
});

test("URLs are not turned into file links", () => {
  const url = "https://example.com/path/file.ts";
  assert.equal(linkifyFileRefs(url), url);
});

test("multi-dot filename resolves to the whole name, not a truncated prefix", () => {
  const out = linkifyFileRefs("src/app.config.js:3");
  assert.match(out, /data-path="src\/app\.config\.js"/);
  assert.match(out, /data-line="3"/);
});
