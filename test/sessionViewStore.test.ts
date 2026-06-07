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
