import { test } from "node:test";
import assert from "node:assert/strict";
import authBridge from "../resources/pi-extensions/vscode-auth-bridge";

test("auth bridge registers login and logout commands", () => {
  const registered: Record<string, unknown> = {};
  authBridge({
    registerCommand(name: string, options: unknown) {
      registered[name] = options;
    },
  });
  assert.equal(typeof registered.login, "object");
  assert.equal(typeof registered.logout, "object");
});

test("auth bridge saves API keys through Pi authStorage", async () => {
  const registered: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }> = {};
  const stored: unknown[] = [];
  let refreshed = false;
  const selections = ["Use an API key", "Anthropic (anthropic)"];
  authBridge({
    registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      registered[name] = options;
    },
  });

  await registered.login.handler("", {
    modelRegistry: {
      authStorage: {
        set(provider: string, credential: unknown) {
          stored.push({ provider, credential });
        },
        login: async () => undefined,
        logout: () => undefined,
        getOAuthProviders: () => [],
      },
      getAll: () => [{ provider: "anthropic", id: "claude-sonnet-4-20250514" }],
      getProviderDisplayName: () => "Anthropic",
      refresh: () => {
        refreshed = true;
      },
    },
    ui: {
      select: async () => selections.shift(),
      input: async () => "sk-test",
      notify: () => undefined,
    },
  });

  assert.deepEqual(stored, [{ provider: "anthropic", credential: { type: "api_key", key: "sk-test" } }]);
  assert.equal(refreshed, true);
});

test("auth bridge logs out through Pi authStorage", async () => {
  const registered: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }> = {};
  let loggedOut = "";
  let refreshed = false;
  authBridge({
    registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      registered[name] = options;
    },
  });

  await registered.logout.handler("", {
    modelRegistry: {
      authStorage: {
        set: () => undefined,
        login: async () => undefined,
        logout: (provider: string) => {
          loggedOut = provider;
        },
        list: () => ["anthropic"],
        get: () => ({ type: "api_key", key: "sk-test" }),
        getOAuthProviders: () => [],
      },
      getProviderDisplayName: () => "Anthropic",
      refresh: () => {
        refreshed = true;
      },
    },
    ui: {
      select: async () => "Anthropic (anthropic)",
      notify: () => undefined,
    },
  });

  assert.equal(loggedOut, "anthropic");
  assert.equal(refreshed, true);
});
