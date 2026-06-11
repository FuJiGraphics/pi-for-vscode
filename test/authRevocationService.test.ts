import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthRevocationService } from "../src/authRevocationService";

type AnyRecord = Record<string, unknown>;

// A pi client stub whose get_commands reports the given command names; everything else (the
// /refresh-auth prompt) just succeeds. Records every request so tests can assert the refresh.
function makeRuntime(commands: string[]): { rt: any; requests: AnyRecord[] } {
  const requests: AnyRecord[] = [];
  const client = {
    isStarted: true,
    request: async (command: AnyRecord) => {
      requests.push(command);
      if (command.type === "get_commands") {
        return { success: true, data: { commands: commands.map((name) => ({ name })) } };
      }
      return { success: true };
    },
  };
  return { rt: { id: "rt", client, isRunning: false, authDirty: false }, requests };
}

function makeService(opts: {
  rt: any;
  selectedModel?: AnyRecord;
  models: Array<{ provider: string; modelId: string }>;
}): { service: AuthRevocationService; posts: AnyRecord[] } {
  const posts: AnyRecord[] = [];
  const service = new AuthRevocationService(
    { post: (message: AnyRecord) => posts.push(message) } as any,
    {
      activeRuntime: () => opts.rt,
      forEachRuntime: (cb: (rt: any) => void) => cb(opts.rt),
      requestState: async () => ({ model: opts.selectedModel }),
      fetchModels: async () => opts.models as any,
    },
  );
  return { service, posts };
}

test("revoked provider (other models remain) → /refresh-auth then modelInvalidated", async () => {
  const { rt, requests } = makeRuntime(["login", "logout", "refresh-auth"]);
  const { service, posts } = makeService({
    rt,
    selectedModel: { provider: "anthropic", id: "claude-x", name: "Claude X" },
    models: [{ provider: "openai", modelId: "gpt-5.1" }],
  });

  await service.onAuthFileChanged();

  assert.ok(requests.some((r) => r.type === "prompt" && r.message === "/refresh-auth"), "forces a registry refresh");
  const invalidated = posts.find((p) => p.type === "modelInvalidated");
  assert.ok(invalidated, "prompts the user");
  assert.equal(invalidated!.previousModel, "Claude X");
  assert.equal(rt.authDirty, false, "dirty flag cleared after draining");
});

test("still-valid selection → no modelInvalidated", async () => {
  const { rt } = makeRuntime(["refresh-auth"]);
  const { service, posts } = makeService({
    rt,
    selectedModel: { provider: "anthropic", id: "claude-x", name: "Claude X" },
    models: [{ provider: "anthropic", modelId: "claude-x" }, { provider: "openai", modelId: "gpt-5.1" }],
  });

  await service.onAuthFileChanged();

  assert.equal(posts.find((p) => p.type === "modelInvalidated"), undefined);
});

test("no models left → no modelInvalidated (the onboarding gate handles 0 models)", async () => {
  const { rt } = makeRuntime(["refresh-auth"]);
  const { service, posts } = makeService({
    rt,
    selectedModel: { provider: "anthropic", id: "claude-x", name: "Claude X" },
    models: [],
  });

  await service.onAuthFileChanged();

  assert.equal(posts.find((p) => p.type === "modelInvalidated"), undefined);
});

test("a running runtime is deferred, not refreshed mid-turn", async () => {
  const { rt, requests } = makeRuntime(["refresh-auth"]);
  rt.isRunning = true;
  const { service, posts } = makeService({
    rt,
    selectedModel: { provider: "anthropic", id: "claude-x", name: "Claude X" },
    models: [{ provider: "openai", modelId: "gpt-5.1" }],
  });

  await service.onAuthFileChanged();

  assert.equal(requests.length, 0, "no RPC while running");
  assert.equal(posts.length, 0, "no prompt while running");
  assert.equal(rt.authDirty, true, "stays dirty for a later idle drain");
});

test("a dead active client still validates (fetchModels revives it) instead of bailing", async () => {
  // Broker reaped while backgrounded → client.isStarted false. maybeDrain must NOT bail on this: a
  // fresh pi spawned by fetchModels reads auth.json at construction, so validation reaches a verdict.
  const { rt, requests } = makeRuntime(["login", "logout", "refresh-auth"]);
  rt.client.isStarted = false; // dead client
  rt.authDirty = true;
  const { service, posts } = makeService({
    rt,
    selectedModel: { provider: "anthropic", id: "claude-x", name: "Claude X" },
    models: [], // revived pi re-read auth.json → no providers authed → empty list
  });

  await service.onAuthFileChanged();

  // Draining (not bailing) clears the dirty flag in the finally block; the old guard returned
  // before that, leaving it set. forceRefresh self-guards on the dead client → no prompt sent.
  assert.equal(rt.authDirty, false, "drained to a verdict rather than bailing on the dead client");
  assert.equal(requests.some((r) => r.type === "prompt"), false, "no prompt to a dead client");
  assert.equal(posts.find((p) => p.type === "modelInvalidated"), undefined, "empty list → gate, no modal");
});

test("missing /refresh-auth command is not sent as a literal prompt", async () => {
  const { rt, requests } = makeRuntime(["login", "logout"]); // bridge present but no refresh-auth
  const { service } = makeService({
    rt,
    selectedModel: { provider: "anthropic", id: "claude-x", name: "Claude X" },
    models: [{ provider: "openai", modelId: "gpt-5.1" }],
  });

  await service.onAuthFileChanged();

  assert.equal(requests.some((r) => r.type === "prompt"), false, "never sends an unregistered slash command");
});
