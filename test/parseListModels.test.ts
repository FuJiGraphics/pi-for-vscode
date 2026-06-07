import { test } from "node:test";
import assert from "node:assert/strict";
import { parseListModels } from "../src/modelStore";

test("parseListModels drops header / blank / no-match rows and parses cells", () => {
  const stdout = [
    "provider   model        context  max-out  thinking  images",
    "openai     gpt-5.5      400000   128000   yes       yes",
    "anthropic  claude-opus  200000   64000    no        yes",
    "",
  ].join("\n");
  const models = parseListModels(stdout);
  assert.equal(models.length, 2);
  assert.deepEqual(models[0], { provider: "openai", model: "gpt-5.5", id: "openai/gpt-5.5", thinking: true });
  assert.equal(models[1].thinking, false);
  assert.equal(models[1].id, "anthropic/claude-opus");
});

test("parseListModels returns [] for the no-models line", () => {
  assert.deepEqual(parseListModels('No models matching "zzz"'), []);
  assert.deepEqual(parseListModels(""), []);
});
