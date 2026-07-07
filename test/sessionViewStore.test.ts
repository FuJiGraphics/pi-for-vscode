import { test } from "node:test";
import assert from "node:assert/strict";
// IMPORTANT: import the stub FIRST — it installs globalThis.acquireVsCodeApi before
// sessionStore→bridge is evaluated (ESM runs dependencies in import order).
import { setPersisted } from "./_bridgeStub";
import { SessionViewStore } from "../src/webview/sessionStore";

test("activateSession swaps the active view, caches the old one, reports change", () => {
  setPersisted(undefined);
  const store = new SessionViewStore();
  assert.equal(store.activateSession("a"), true);
  store.activeView.sessionName = "alpha";
  assert.equal(store.activateSession("b"), true);
  store.activeView.sessionName = "beta";
  assert.equal(store.activateSession("b"), false); // already active → no change
  store.activateSession("a"); // switching back restores a's cached view
  assert.equal(store.activeView.sessionName, "alpha");
});

test("beginProvisionalSession swaps in a fresh composer view instantly; promoteProvisional re-keys it", () => {
  setPersisted(undefined);
  const store = new SessionViewStore();
  store.activateSession("a");
  store.activeView.sessionName = "alpha";
  store.activeView.messages.push({ id: "m", role: "user", text: "hi", createdAt: 0 } as any);

  assert.equal(store.beginProvisionalSession(), true);
  assert.equal(store.getActiveSessionId(), "");
  assert.equal(store.activeView.messages.length, 0); // fresh composer
  assert.equal(store.openViews().some(({ id }) => id === "a"), true); // old tab survives

  // Already on the fresh provisional → no-op (prevents session spam on repeated +).
  assert.equal(store.beginProvisionalSession(), false);

  // The host's activate re-keys the provisional view to the real runtime id.
  store.activeView.messages.push({ id: "m2", role: "user", text: "first", createdAt: 0 } as any);
  assert.equal(store.promoteProvisional("b"), true);
  assert.equal(store.getActiveSessionId(), "b");
  assert.equal(store.activeView.messages.length, 1); // optimistic content survived the commit
});

test("withSession mutates a background view, suppresses render, and restores by id", () => {
  setPersisted(undefined);
  const store = new SessionViewStore();
  store.activateSession("active");
  store.activeView.sessionName = "ACTIVE";
  let suppressedDuring = false;
  store.withSession("bg", () => {
    suppressedDuring = store.isRenderSuppressed();
    store.activeView.sessionName = "BG";
  });
  assert.equal(suppressedDuring, true); // background mutation ran suppressed
  assert.equal(store.isRenderSuppressed(), false); // restored after
  assert.equal(store.getActiveSessionId(), "active"); // active id unchanged
  assert.equal(store.activeView.sessionName, "ACTIVE"); // active view re-resolved by id
});

test("adoptPersistedView restores the crash view; consumeRestored is one-shot", () => {
  setPersisted({
    activeSessionFile: "",
    bySessionFile: {
      "/f.jsonl": { messages: [{ id: "m1", role: "assistant", text: "hi", createdAt: 0 }], sessionTokens: 7 },
    },
  });
  const store = new SessionViewStore();
  store.activateSession("rt1");
  store.activeView.sessionFile = "/f.jsonl";
  assert.equal(store.adoptPersistedView("rt1", "/f.jsonl"), true);
  assert.equal(store.activeView.messages.length, 1);
  assert.equal(store.activeView.sessionTokens, 7);
  assert.equal(store.consumeRestored("rt1"), true);
  assert.equal(store.consumeRestored("rt1"), false);
  assert.equal(store.adoptPersistedView("rt1", "/f.jsonl"), false); // already consumed
});

test("openViews lists open sessions in insertion order and never resurrects a dropped one", () => {
  setPersisted(undefined);
  const store = new SessionViewStore();
  store.activateSession("a");
  store.activeView.sessionName = "alpha";
  store.activateSession("b");
  store.withSession("c", () => {});
  assert.deepEqual(store.openViews().map((v) => v.id), ["a", "b", "c"]);
  // The active entry reads the LIVE view object.
  store.activeView.sessionName = "beta";
  assert.equal(store.openViews().find((v) => v.id === "b")?.view.sessionName, "beta");
  // Close the active tab (host: dropSession → activate next): the dropped view must not
  // come back as a zombie when the next activation re-caches the outgoing view.
  store.dropSession("b");
  assert.deepEqual(store.openViews().map((v) => v.id), ["a", "c"]);
  store.activateSession("c");
  assert.deepEqual(store.openViews().map((v) => v.id), ["a", "c"]);
});

// Chrome-like tab behavior: closing active selects the right neighbor first; drag/drop only
// changes the hot-path tab order, never the underlying session contents.
test("closeSessionTab and moveSessionTab support instant Chrome-style tab UX", () => {
  setPersisted(undefined);
  const store = new SessionViewStore();
  store.activateSession("a");
  store.activeView.sessionName = "alpha";
  store.activateSession("b");
  store.activeView.sessionName = "beta";
  store.activateSession("c");
  store.activeView.sessionName = "gamma";
  assert.deepEqual(store.openViews().map((v) => v.id), ["a", "b", "c"]);

  assert.equal(store.moveSessionTab("c", "a", false), true);
  assert.deepEqual(store.openViews().map((v) => v.id), ["c", "a", "b"]);

  store.activateSession("a");
  assert.equal(store.closeSessionTab("a"), "b");
  assert.equal(store.getActiveSessionId(), "b");
  assert.equal(store.activeView.sessionName, "beta");
  assert.deepEqual(store.openViews().map((v) => v.id), ["c", "b"]);
});

test("sanitizeView drops legacy 'Generated' checkpoint steps from persisted views", () => {
  setPersisted({
    activeSessionFile: "/g.jsonl",
    bySessionFile: {
      "/g.jsonl": {
        messages: [
          {
            id: "a", role: "assistant", text: "done", createdAt: 1,
            activity: {
              startedAt: 1, endedAt: 2, expanded: true,
              steps: [
                { id: "t1", label: "Read", detail: "", status: "done", startedAt: 1, tool: "read" },
                { id: "gen-1", label: "Generated", detail: "", status: "done", startedAt: 1, kind: "generation", tokens: 99 },
              ],
            },
          },
        ],
      },
    },
  });
  const store = new SessionViewStore();
  const steps = store.activeView.messages[0].activity?.steps ?? [];
  assert.deepEqual(steps.map((s) => s.id), ["t1"]);
});

test("a mid-turn persisted view is sanitized: running cleared + last assistant interrupted", () => {
  setPersisted({
    activeSessionFile: "/run.jsonl",
    bySessionFile: {
      "/run.jsonl": {
        running: true,
        messages: [
          { id: "u", role: "user", text: "go", createdAt: 0 },
          { id: "a", role: "assistant", text: "...", createdAt: 1 },
        ],
      },
    },
  });
  const store = new SessionViewStore();
  assert.equal(store.activeView.running, false);
  const lastAssistant = store.activeView.messages.find((m) => m.role === "assistant");
  assert.equal(lastAssistant?.interrupted, true);
});
