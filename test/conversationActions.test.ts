import { test } from "node:test";
import assert from "node:assert/strict";
import { ConversationActionsService } from "../src/conversationActions";

// Minimal fakes: a pi client scripted per RPC type, a manager exposing it as the active
// runtime, and a presenter capturing system posts — same style as the other service tests.
function harness(options: {
  forkMessages?: Array<{ entryId: string; text: string }>;
  forkResult?: { success?: boolean; error?: string; data?: unknown };
  exportResult?: { success?: boolean; error?: string; data?: unknown };
}) {
  const calls: Array<Record<string, unknown>> = [];
  const systems: string[] = [];
  const prompted: Array<{ text: string; images?: unknown }> = [];
  const opened: string[] = [];
  let reseeded = 0;

  const client = {
    isStarted: true,
    request: async (message: Record<string, unknown>) => {
      calls.push(message);
      if (message.type === "get_fork_messages") {
        return { success: true, data: { messages: options.forkMessages ?? [] } };
      }
      if (message.type === "fork") return options.forkResult ?? { success: true, data: {} };
      if (message.type === "export_html") return options.exportResult ?? { success: true, data: { path: "/tmp/out.html" } };
      return { success: true, data: {} };
    },
  };
  const rt = { id: "rt", client, cwd: "/w", isRunning: false } as any;
  const manager = {
    active: rt,
    seedRuntime: async () => { reseeded++; },
    getClientState: async () => ({}),
    postSessionList: async () => undefined,
    postState: async () => undefined,
  } as any;
  const posts: Array<Record<string, unknown>> = [];
  const presenter = { postSystem: (text: string) => systems.push(text), post: (m: Record<string, unknown>) => posts.push(m) } as any;
  const service = new ConversationActionsService(manager, presenter, {
    prompt: async (text, images) => { prompted.push({ text, images }); },
    openExported: (path) => { opened.push(path); },
  });
  return { service, calls, systems, prompted, opened, posts, reseeded: () => reseeded };
}

test("editMessage forks at the ordinal's entry and resends the edited text", async () => {
  const h = harness({
    forkMessages: [
      { entryId: "e1", text: "first" },
      { entryId: "e2", text: "second question" },
    ],
  });
  await h.service.editMessage(1, "second question", "second question, but better");
  const fork = h.calls.find((call) => call.type === "fork");
  assert.equal(fork?.entryId, "e2");
  assert.deepEqual(h.prompted, [{ text: "second question, but better", images: undefined }]);
  assert.equal(h.reseeded(), 0);
  // The branched sessionFile is pushed to the webview so crash-save persists under it.
  const statePost = h.posts.find((p) => p.type === "state");
  assert.ok(statePost, "expected a state post carrying the new sessionFile");
});

test("editMessage falls back to a unique text match when the ordinal drifted", async () => {
  const h = harness({
    forkMessages: [
      { entryId: "e1", text: "alpha" },
      { entryId: "e2", text: "beta" },
    ],
  });
  // Ordinal points at e1, but the original text says the user edited "beta".
  await h.service.editMessage(0, "beta", "beta v2");
  const fork = h.calls.find((call) => call.type === "fork");
  assert.equal(fork?.entryId, "e2");
});

test("editMessage re-seeds (restores the truncated view) when the entry cannot be found", async () => {
  const h = harness({ forkMessages: [{ entryId: "e1", text: "alpha" }] });
  await h.service.editMessage(5, "no such message", "edited");
  assert.equal(h.calls.some((call) => call.type === "fork"), false);
  assert.equal(h.prompted.length, 0);
  assert.equal(h.reseeded(), 1);
  assert.match(h.systems[0], /Could not locate/);
});

test("editMessage re-seeds when pi rejects the fork", async () => {
  const h = harness({
    forkMessages: [{ entryId: "e1", text: "alpha" }],
    forkResult: { success: false, error: "nope" },
  });
  await h.service.editMessage(0, "alpha", "edited");
  assert.equal(h.prompted.length, 0);
  assert.equal(h.reseeded(), 1);
  assert.match(h.systems[0], /Failed to rewind/);
});

test("exportHtml reports the exported path and opens it", async () => {
  const h = harness({});
  await h.service.exportHtml();
  assert.match(h.systems[0], /\/tmp\/out\.html/);
  assert.deepEqual(h.opened, ["/tmp/out.html"]);
});
