import { test } from "node:test";
import assert from "node:assert/strict";
// Stubs MUST come before any webview module (modelPicker's import chain reaches dom.ts).
import "./_bridgeStub";
import "./_domStub";
import { groupedListHtml, itemHtml, itemTooltip, metaLabel, priceLabel } from "../src/webview/modelPicker";
import type { ModelListItem } from "../src/protocol";

function model(extra: Partial<ModelListItem> = {}): ModelListItem {
  return {
    id: "anthropic/claude-sonnet-4",
    modelId: "claude-sonnet-4",
    model: "Claude Sonnet 4",
    provider: "anthropic",
    thinking: true,
    isCurrent: false,
    ...extra,
  };
}

test("priceLabel: compact $in/out; free or unreported → omitted", () => {
  assert.equal(priceLabel({ input: 3, output: 15 }), "$3/15");
  assert.equal(priceLabel({ input: 0.33, output: 2.75 }), "$0.33/2.75");
  assert.equal(priceLabel({ input: 0, output: 0 }), ""); // local/free model
  assert.equal(priceLabel(undefined), ""); // older pi
});

test("itemHtml renders one dense row: data column, thinking glyph, full tooltip", () => {
  const html = itemHtml(model({
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200_000,
    maxTokens: 64_000,
    vision: true,
  }));
  assert.ok(html.includes('<span class="model-data">$3/15 · 200k</span>'));
  assert.ok(html.includes('class="model-think"')); // thinking:true → glyph
  assert.equal(html.includes("model-cap"), false); // no capability chips
  assert.ok(html.includes("Cache read $0.3 / write $3.75 per Mtok"));
  assert.ok(html.includes("Context 200k · Max output 64k"));
});

test("itemHtml omits the data column when pi reported no enrichment (older pi)", () => {
  const html = itemHtml(model({ thinking: false }));
  assert.equal(html.includes("model-data"), false);
  assert.equal(html.includes('title="'), false); // no tooltip without data (glyph absent too)
  assert.equal(itemTooltip(model()), "");
  assert.equal(metaLabel(model()), "");
});

test("groupedListHtml inserts one provider header per catalog run", () => {
  const html = groupedListHtml([
    model({ id: "anthropic/a", modelId: "a" }),
    model({ id: "anthropic/b", modelId: "b" }),
    model({ id: "openai/c", modelId: "c", provider: "openai" }),
  ]);
  const heads = html.match(/model-group-head/g) ?? [];
  assert.equal(heads.length, 2);
  assert.ok(html.indexOf("anthropic") < html.indexOf("openai"));
});

test("itemHtml escapes provider-supplied strings", () => {
  const html = itemHtml(model({ model: '<img src=x onerror=1>"', provider: "a&b" }));
  assert.equal(html.includes("<img"), false);
  assert.ok(html.includes("&lt;img"));
  assert.ok(html.includes("a&amp;b"));
});
