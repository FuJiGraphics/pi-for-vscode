import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveAuthStatus, providersFromAuthJson } from "../src/authStatusService";

test("deriveAuthStatus verdict matrix", () => {
  const stored = [{ id: "anthropic", authType: "oauth" as const }];
  // Positive signals win.
  assert.equal(deriveAuthStatus("models", []), "authenticated");
  assert.equal(deriveAuthStatus("models", stored), "authenticated");
  assert.equal(deriveAuthStatus("unknown", stored), "authenticated"); // file says yes even when pi is unreachable
  // Only a CONFIRMED empty (fetch succeeded, zero models, no stored creds) is unauthenticated.
  assert.equal(deriveAuthStatus("empty", []), "unauthenticated");
  assert.equal(deriveAuthStatus("empty", stored), "authenticated"); // stored creds outrank an empty list
  // No signal at all → unknown (fails open: the gate never mounts on it).
  assert.equal(deriveAuthStatus("unknown", []), "unknown");
});

test("providersFromAuthJson reads metadata only and never throws", () => {
  const raw = JSON.stringify({
    anthropic: { type: "oauth", accessToken: "SECRET-A", refreshToken: "SECRET-B" },
    openai: { type: "api_key", key: "SECRET-K" },
    weird: { something: true },
  });
  const providers = providersFromAuthJson(raw);
  assert.deepEqual(providers, [
    { id: "anthropic", authType: "oauth" },
    { id: "openai", authType: "api_key" },
    { id: "weird", authType: "api_key" },
  ]);
  // Key material never crosses into the output.
  assert.equal(JSON.stringify(providers).includes("SECRET"), false);

  assert.deepEqual(providersFromAuthJson("not json {{{"), []);
  assert.deepEqual(providersFromAuthJson("[]"), []);
  assert.deepEqual(providersFromAuthJson("null"), []);
  assert.deepEqual(providersFromAuthJson(JSON.stringify({ a: "string-cred" })), []);
});
