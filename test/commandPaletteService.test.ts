import { test } from "node:test";
import assert from "node:assert/strict";
import { CommandPaletteService } from "../src/commandPaletteService";

function serviceWith(commands: unknown[] | { fail: true }) {
  const posts: any[] = [];
  const client = {
    request: async () => {
      if (!Array.isArray(commands)) return { success: false };
      return { success: true, data: { commands } };
    },
  };
  const service = new CommandPaletteService(
    { post: (message: unknown) => posts.push(message) } as any,
    { ensureRuntime: async () => ({ id: "rt", client } as any) },
  );
  return { service, posts };
}

test("commandList carries authAvailable=true when the bridge's login command is present", async () => {
  const { service, posts } = serviceWith([
    { name: "login", description: "Sign in", source: "extension" },
    { name: "review", description: "", source: "prompt" },
  ]);
  await service.postCommandList();
  assert.equal(posts[0].type, "commandList");
  assert.equal(posts[0].authAvailable, true);
  assert.equal(posts[0].commands.length, 2);
});

test("commandList carries authAvailable=false when login is missing (bridge failed to load)", async () => {
  const { service, posts } = serviceWith([{ name: "review", description: "", source: "prompt" }]);
  await service.postCommandList();
  assert.equal(posts[0].authAvailable, false);
});

test("a failed get_commands posts an empty list WITHOUT an authAvailable verdict", async () => {
  const { service, posts } = serviceWith({ fail: true });
  await service.postCommandList();
  assert.deepEqual(posts[0], { type: "commandList", commands: [] });
  assert.equal("authAvailable" in posts[0], false);
});
