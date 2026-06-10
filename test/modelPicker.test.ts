import { test } from "node:test";
import assert from "node:assert/strict";
// Stubs MUST come before any webview module (modelPicker's import chain reaches dom.ts).
import "./_bridgeStub";
import "./_domStub";
import { itemHtml, itemTooltip, priceLabel } from "../src/webview/modelPicker";
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

test("priceLabel: compact $in/$out per Mtok; free or unreported → omitted", () => {
  assert.equal(priceLabel({ input: 3, output: 15 }), "$3/$15 Mtok");
  assert.equal(priceLabel({ input: 0.33, output: 2.75 }), "$0.33/$2.75 Mtok");
  assert.equal(priceLabel({ input: 0, output: 0 }), ""); // local/free model
  assert.equal(priceLabel(undefined), ""); // older pi
});

test("itemHtml renders price/ctx/vision chips and a multi-line tooltip", () => {
  const html = itemHtml(model({
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200_000,
    maxTokens: 64_000,
    vision: true,
  }));
  assert.ok(html.includes('<span class="model-price">$3/$15 Mtok</span>'));
  assert.ok(html.includes('<span class="model-ctx">200k ctx</span>'));
  assert.ok(html.includes('<span class="model-cap">vision</span>'));
  assert.ok(html.includes("Cache read $0.3 / write $3.75 per Mtok"));
  assert.ok(html.includes("Context 200k · Max output 64k"));
});

test("itemHtml omits chips when pi reported no enrichment (older pi)", () => {
  const html = itemHtml(model());
  assert.equal(html.includes("model-price"), false);
  assert.equal(html.includes("model-ctx"), false);
  assert.equal(html.includes('title="'), false); // no tooltip without data
  assert.equal(itemTooltip(model()), "");
});

test("itemHtml escapes provider-supplied strings", () => {
  const html = itemHtml(model({ model: '<img src=x onerror=1>"', provider: "a&b" }));
  assert.equal(html.includes("<img"), false);
  assert.ok(html.includes("&lt;img"));
  assert.ok(html.includes("a&amp;b"));
});
