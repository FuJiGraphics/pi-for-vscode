import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSourceTag, readSessionFile, truncateToolOutput } from "../src/stateHelpers";

test("readSessionFile pulls a string sessionFile, else undefined", () => {
  assert.equal(readSessionFile({ sessionFile: "/a/b.jsonl" }), "/a/b.jsonl");
  assert.equal(readSessionFile({ sessionFile: 42 }), undefined);
  assert.equal(readSessionFile({}), undefined);
  assert.equal(readSessionFile(undefined), undefined);
});

test("truncateToolOutput caps by chars and lines", () => {
  assert.equal(truncateToolOutput("short"), "short");

  const longChars = "x".repeat(5000);
  const byChars = truncateToolOutput(longChars);
  assert.ok(byChars.length < 5000);
  assert.ok(byChars.endsWith("…(truncated)"));

  const manyLines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
  const byLines = truncateToolOutput(manyLines);
  assert.equal(byLines.split("\n").length, 41); // 40 kept + the truncation marker line
  assert.ok(byLines.endsWith("…(truncated)"));
});

test("buildSourceTag maps scope to prefix and appends npm source", () => {
  assert.equal(buildSourceTag(undefined), undefined);
  assert.equal(buildSourceTag({ scope: "user" }), "u");
  assert.equal(buildSourceTag({ scope: "project" }), "p");
  assert.equal(buildSourceTag({ scope: "temporary" }), "t");
  assert.equal(buildSourceTag({ scope: "user", source: "npm:foo" }), "u:npm:foo");
  assert.equal(buildSourceTag({ scope: "project", source: "git+https://x" }), "p");
});
