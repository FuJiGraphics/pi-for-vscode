import { test } from "node:test";
import assert from "node:assert/strict";
import usageBridge, { parseDurationMs, parseUsageHeaders } from "../resources/pi-extensions/vscode-usage-bridge";

const NOW = 1_750_000_000_000;

test("parseUsageHeaders: Anthropic subscription unified windows (5h/7d) normalize ratios and unix resets", () => {
  const payload = parseUsageHeaders(
    {
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-reset": "1750003600", // unix seconds
      "anthropic-ratelimit-unified-5h-utilization": "0.01", // ratio → 1%
      "anthropic-ratelimit-unified-7d-utilization": "32", // already percent
      "anthropic-ratelimit-unified-7d-reset": "1750300000",
      "content-type": "application/json", // ignored
    },
    NOW,
  )!;
  assert.ok(payload);
  const byWindow = Object.fromEntries(payload.unified.map((w) => [w.window, w]));
  assert.equal(byWindow["overall"].status, "allowed");
  assert.equal(byWindow["overall"].reset, 1_750_003_600_000);
  assert.equal(byWindow["5h"].utilization, 1);
  assert.equal(byWindow["7d"].utilization, 32);
  assert.equal(byWindow["7d"].reset, 1_750_300_000_000);
  assert.deepEqual(payload.limits, []);
});

test("parseUsageHeaders: Anthropic API key limits (requests / token kinds, RFC3339 reset)", () => {
  const payload = parseUsageHeaders(
    {
      "anthropic-ratelimit-requests-remaining": "4980",
      "anthropic-ratelimit-requests-limit": "5000",
      "anthropic-ratelimit-requests-reset": "2026-06-10T12:00:00Z",
      "anthropic-ratelimit-input-tokens-remaining": "39000",
      "anthropic-ratelimit-input-tokens-limit": "40000",
    },
    NOW,
  )!;
  const byKind = Object.fromEntries(payload.limits.map((l) => [l.kind, l]));
  assert.equal(byKind["requests"].remaining, 4980);
  assert.equal(byKind["requests"].limit, 5000);
  assert.equal(byKind["requests"].reset, Date.parse("2026-06-10T12:00:00Z"));
  assert.equal(byKind["input-tokens"].remaining, 39000);
});

test("parseUsageHeaders: OpenAI x-ratelimit with duration resets", () => {
  const payload = parseUsageHeaders(
    {
      "x-ratelimit-remaining-requests": "59",
      "x-ratelimit-limit-requests": "60",
      "x-ratelimit-reset-requests": "1m30s",
    },
    NOW,
  )!;
  assert.equal(payload.limits[0].kind, "requests");
  assert.equal(payload.limits[0].remaining, 59);
  assert.equal(payload.limits[0].reset, NOW + 90_000);
});

test("parseUsageHeaders: no usage headers / junk → undefined (nothing posted)", () => {
  assert.equal(parseUsageHeaders({ "content-type": "application/json" }, NOW), undefined);
  assert.equal(parseUsageHeaders(undefined, NOW), undefined);
  assert.equal(
    parseUsageHeaders({ "anthropic-ratelimit-unified-5h-utilization": "not-a-number" }, NOW),
    undefined,
  );
});

test("parseDurationMs handles compound durations", () => {
  assert.equal(parseDurationMs("1s"), 1000);
  assert.equal(parseDurationMs("6m20s"), 380_000);
  assert.equal(parseDurationMs("1h2m3s"), 3_723_000);
  assert.equal(parseDurationMs("250ms"), 250);
  assert.equal(parseDurationMs("soon"), undefined);
});

test("bridge posts setStatus once per change, never throws on junk events", async () => {
  const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<void>> = {};
  usageBridge({
    on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) {
      handlers[event] = handler;
    },
  });
  assert.equal(typeof handlers["after_provider_response"], "function");

  const posted: Array<[string, string]> = [];
  const ctx = { ui: { setStatus: (key: string, text: string) => posted.push([key, text]) } };
  const event = { type: "after_provider_response", status: 200, headers: { "anthropic-ratelimit-unified-5h-utilization": "0.5" } };

  await handlers["after_provider_response"](event, ctx);
  await handlers["after_provider_response"](event, ctx); // identical → deduped
  assert.equal(posted.length, 1);
  assert.equal(posted[0][0], "vscode-usage");
  assert.equal(JSON.parse(posted[0][1]).unified[0].utilization, 50);

  // Junk event / missing ui must not throw.
  await handlers["after_provider_response"](undefined, {});
  await handlers["after_provider_response"]({ headers: { "anthropic-ratelimit-unified-7d-utilization": "0.9" } }, { ui: {} });
});
