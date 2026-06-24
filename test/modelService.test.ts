import { test } from "node:test";
import assert from "node:assert/strict";
import { modelListItemsFromRpc, isCurrentModelItem } from "../src/modelService";
import { ModelService } from "../src/modelService";
import { BROKER_COMMANDS } from "../src/protocol";

test("modelListItemsFromRpc maps Pi full model objects to picker items", () => {
  const items = modelListItemsFromRpc(
    [
      {
        provider: "anthropic",
        id: "claude-sonnet-4-20250514",
        name: "Claude Sonnet 4",
        reasoning: true,
      },
      {
        provider: "openai",
        id: "gpt-5.1",
        displayName: "GPT 5.1",
        thinkingLevelMap: { off: null, medium: "medium" },
      },
      { provider: "", id: "skip-me" },
      { provider: "bad" },
    ],
    { provider: "anthropic", id: "claude-sonnet-4-20250514" },
  );

  assert.deepEqual(items, [
    {
      id: "anthropic/claude-sonnet-4-20250514",
      modelId: "claude-sonnet-4-20250514",
      model: "Claude Sonnet 4",
      provider: "anthropic",
      thinking: true,
      isCurrent: true,
    },
    {
      id: "openai/gpt-5.1",
      modelId: "gpt-5.1",
      model: "GPT 5.1",
      provider: "openai",
      thinking: true,
      isCurrent: false,
    },
  ]);
});

test("modelListItemsFromRpc passes through pricing/context/vision; omits them for older pi", () => {
  const items = modelListItemsFromRpc([
    {
      provider: "anthropic",
      id: "claude-opus-4-1-20250805",
      name: "Claude Opus 4.1",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
      contextWindow: 200000,
      maxTokens: 32000,
    },
    // Older pi: no cost/contextWindow/input fields at all.
    { provider: "openai", id: "gpt-old", name: "GPT Old" },
    // Malformed cost (string values) → omitted, not NaN'd through.
    { provider: "x", id: "weird", cost: { input: "3", output: "15" } },
  ]);

  assert.deepEqual(items[0].cost, { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 });
  assert.equal(items[0].contextWindow, 200000);
  assert.equal(items[0].maxTokens, 32000);
  assert.equal(items[0].vision, true);
  assert.equal("cost" in items[1], false);
  assert.equal("contextWindow" in items[1], false);
  assert.equal("vision" in items[1], false);
  assert.equal("cost" in items[2], false);
});

test("isCurrentModelItem accepts bare or qualified current model ids", () => {
  const item = { id: "openai/gpt-5.1", provider: "openai", modelId: "gpt-5.1" };
  assert.equal(isCurrentModelItem(item, { id: "openai/gpt-5.1" }), true);
  assert.equal(isCurrentModelItem(item, { provider: "openai", id: "gpt-5.1" }), true);
  assert.equal(isCurrentModelItem(item, { provider: "anthropic", id: "gpt-5.1" }), false);
});

test("broker command set does not intercept Pi set_model", () => {
  assert.equal(BROKER_COMMANDS.has("set_model"), false);
});

test("ModelService.setModel sends official provider/modelId RPC", async () => {
  const requests: unknown[] = [];
  const posts: unknown[] = [];
  const client = {
    request: async (command: unknown) => {
      requests.push(command);
      if ((command as { type?: string }).type === "get_available_models") {
        return { success: true, data: { models: [] } };
      }
      return { success: true };
    },
  };
  const service = new ModelService(
    {
      post: (message: unknown) => posts.push(message),
      postSystem: (message: string) => posts.push({ type: "system", message }),
    } as any,
    {
      ensureRuntime: async () => ({ id: "rt", client } as any),
      requestState: async () => ({ model: { provider: "anthropic", id: "claude-sonnet-4-20250514" } }),
      postState: async () => undefined,
      reportRuntimeError: () => undefined,
    },
  );

  await service.setModel("anthropic", "claude-sonnet-4-20250514");

  assert.deepEqual(requests[0], {
    type: "set_model",
    provider: "anthropic",
    modelId: "claude-sonnet-4-20250514",
  });
  assert.equal("model" in (requests[0] as Record<string, unknown>), false);
  assert.equal("secrets" in (requests[0] as Record<string, unknown>), false);
});
