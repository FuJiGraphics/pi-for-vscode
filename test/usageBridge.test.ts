import { test } from "node:test";
import assert from "node:assert/strict";
import usageBridge, {
  codexUsageUrl,
  extractAccountId,
  parseCodexUsageResponse,
  parseDurationMs,
  parseUsageHeaders,
} from "../resources/pi-extensions/vscode-usage-bridge";

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

test("parseUsageHeaders: ChatGPT Codex windows (golden sample captured from a real SSE response)", () => {
  const payload = parseUsageHeaders(
    {
      "x-codex-active-limit": "premium", // ignored
      "x-codex-plan-type": "plus", // ignored
      "x-codex-credits-balance": "", // ignored
      "x-codex-primary-over-secondary-limit-percent": "0", // ignored
      "x-codex-primary-used-percent": "1",
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-at": "1781123517", // unix seconds — wins over reset-after-seconds
      "x-codex-primary-reset-after-seconds": "16750",
      "x-codex-secondary-used-percent": "69",
      "x-codex-secondary-window-minutes": "10080",
      "x-codex-secondary-reset-at": "1781288387",
      "x-codex-secondary-reset-after-seconds": "181620",
      "content-type": "text/event-stream", // ignored
    },
    NOW,
  )!;
  const byWindow = Object.fromEntries(payload.unified.map((w) => [w.window, w]));
  // 300min → "5h", 10080min → "7d": the labels the menu already maps (5h / Weekly).
  assert.equal(byWindow["5h"].utilization, 1); // "1" is already a percent, NOT a ratio
  assert.equal(byWindow["5h"].reset, 1_781_123_517_000);
  assert.equal(byWindow["7d"].utilization, 69);
  assert.equal(byWindow["7d"].reset, 1_781_288_387_000);
  assert.deepEqual(payload.limits, []);
});

test("parseUsageHeaders: Codex fallbacks — reset-after-seconds without reset-at, missing window-minutes", () => {
  const payload = parseUsageHeaders(
    {
      "x-codex-primary-used-percent": "12",
      "x-codex-primary-reset-after-seconds": "600",
      "x-codex-secondary-used-percent": "40",
      "x-codex-secondary-window-minutes": "90",
    },
    NOW,
  )!;
  const byWindow = Object.fromEntries(payload.unified.map((w) => [w.window, w]));
  assert.equal(byWindow["primary"].utilization, 12); // no window-minutes → raw name kept
  assert.equal(byWindow["primary"].reset, NOW + 600_000);
  assert.equal(byWindow["90m"].utilization, 40); // not a whole hour/day → minutes label
});

test("parseUsageHeaders: no usage headers / junk → undefined (nothing posted)", () => {
  assert.equal(parseUsageHeaders({ "content-type": "application/json" }, NOW), undefined);
  assert.equal(parseUsageHeaders(undefined, NOW), undefined);
  assert.equal(
    parseUsageHeaders({ "anthropic-ratelimit-unified-5h-utilization": "not-a-number" }, NOW),
    undefined,
  );
});

test("parseCodexUsageResponse: wham/usage payload (codex-rs RateLimitStatusPayload shape)", () => {
  const payload = parseCodexUsageResponse(
    {
      plan_type: "plus",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 1, limit_window_seconds: 18000, reset_after_seconds: 16750, reset_at: 1781123517 },
        secondary_window: { used_percent: 69, limit_window_seconds: 604800, reset_after_seconds: 181620, reset_at: 1781288387 },
      },
      credits: null,
    },
    NOW,
  )!;
  const byWindow = Object.fromEntries(payload.unified.map((w) => [w.window, w]));
  assert.equal(byWindow["5h"].utilization, 1); // 18000s = 300min → "5h"
  assert.equal(byWindow["5h"].reset, 1_781_123_517_000);
  assert.equal(byWindow["7d"].utilization, 69); // 604800s = 10080min → "7d"
  assert.equal(byWindow["7d"].reset, 1_781_288_387_000);
  assert.deepEqual(payload.limits, []);
});

test("parseCodexUsageResponse: fallbacks — reset_after_seconds without reset_at, missing windows → undefined", () => {
  const payload = parseCodexUsageResponse(
    { rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 12, reset_after_seconds: 600 } } },
    NOW,
  )!;
  assert.equal(payload.unified[0].window, "primary"); // no limit_window_seconds → raw name
  assert.equal(payload.unified[0].utilization, 12);
  assert.equal(payload.unified[0].reset, NOW + 600_000);

  assert.equal(parseCodexUsageResponse({ plan_type: "plus" }, NOW), undefined);
  assert.equal(parseCodexUsageResponse({ rate_limit: {} }, NOW), undefined);
  assert.equal(parseCodexUsageResponse(undefined, NOW), undefined);
});

test("codexUsageUrl derives the usage endpoint from any codex baseUrl form", () => {
  assert.equal(codexUsageUrl("https://chatgpt.com/backend-api"), "https://chatgpt.com/backend-api/wham/usage");
  assert.equal(codexUsageUrl("https://chatgpt.com/backend-api/codex"), "https://chatgpt.com/backend-api/wham/usage");
  assert.equal(codexUsageUrl("https://chatgpt.com/backend-api/codex/responses/"), "https://chatgpt.com/backend-api/wham/usage");
  assert.equal(codexUsageUrl(undefined), "https://chatgpt.com/backend-api/wham/usage");
});

test("extractAccountId reads the chatgpt_account_id JWT claim, tolerates junk", () => {
  const claims = { "https://api.openai.com/auth": { chatgpt_account_id: "acc-123" } };
  const token = "x." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".y";
  assert.equal(extractAccountId(token), "acc-123");
  assert.equal(extractAccountId("not-a-jwt"), undefined);
  assert.equal(extractAccountId(""), undefined);
});

test("parseDurationMs handles compound durations", () => {
  assert.equal(parseDurationMs("1s"), 1000);
  assert.equal(parseDurationMs("6m20s"), 380_000);
  assert.equal(parseDurationMs("1h2m3s"), 3_723_000);
  assert.equal(parseDurationMs("250ms"), 250);
  assert.equal(parseDurationMs("soon"), undefined);
});

test("bridge posts setStatus on every response with usage headers, never throws on junk events", async () => {
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

  // No dedup: identical payloads re-post so a recreated webview catches the next one.
  await handlers["after_provider_response"](event, ctx);
  await handlers["after_provider_response"](event, ctx);
  assert.equal(posted.length, 2);
  assert.equal(posted[0][0], "vscode-usage");
  assert.equal(JSON.parse(posted[0][1]).unified[0].utilization, 50);

  // Headers without usage info → nothing posted.
  await handlers["after_provider_response"]({ headers: { "content-type": "application/json" } }, ctx);
  assert.equal(posted.length, 2);

  // Junk event / missing ui must not throw.
  await handlers["after_provider_response"](undefined, {});
  await handlers["after_provider_response"]({ headers: { "anthropic-ratelimit-unified-7d-utilization": "0.9" } }, { ui: {} });
});
