import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionStatsService, sessionStatsFromRpc } from "../src/sessionStatsService";
// Stubs MUST come before any webview module (sessionStatsBar's import chain reaches dom.ts).
import "./_bridgeStub";
import "./_domStub";
import { contextLabel, statsPopoverHtml, statsSummary } from "../src/webview/sessionStatsBar";

const V078_PAYLOAD = {
  sessionFile: "/x/s.jsonl",
  sessionId: "abc",
  userMessages: 3,
  assistantMessages: 4,
  toolCalls: 7,
  toolResults: 7,
  totalMessages: 21,
  tokens: { input: 1200, output: 800, cacheRead: 50_000, cacheWrite: 2000, total: 54_000 },
  cost: 0.42,
  contextUsage: { tokens: 78_300, contextWindow: 200_000, percent: 39.15 },
};

test("sessionStatsFromRpc maps the v0.78 payload 1:1", () => {
  const stats = sessionStatsFromRpc(V078_PAYLOAD)!;
  assert.deepEqual(stats.tokens, { input: 1200, output: 800, cacheRead: 50_000, cacheWrite: 2000, total: 54_000 });
  assert.equal(stats.cost, 0.42);
  assert.deepEqual(stats.context, { tokens: 78_300, contextWindow: 200_000, percent: 39.15 });
});

test("sessionStatsFromRpc: post-compaction nulls survive; alt field names accepted; junk → undefined", () => {
  const postCompaction = sessionStatsFromRpc({ ...V078_PAYLOAD, contextUsage: { tokens: null, contextWindow: 200_000, percent: null } })!;
  assert.deepEqual(postCompaction.context, { tokens: null, contextWindow: 200_000, percent: null });

  const altNames = sessionStatsFromRpc({ ...V078_PAYLOAD, contextUsage: { contextTokens: 1000, contextWindow: 8000, contextPercentage: 12.5 } })!;
  assert.deepEqual(altNames.context, { tokens: 1000, contextWindow: 8000, percent: 12.5 });

  const noWindow = sessionStatsFromRpc({ ...V078_PAYLOAD, contextUsage: undefined })!;
  assert.equal("context" in noWindow, false);

  assert.equal(sessionStatsFromRpc(null), undefined);
  assert.equal(sessionStatsFromRpc("nope"), undefined);
});

test("SessionStatsService posts tagged stats; RPC failure posts nothing", async () => {
  const posts: any[] = [];
  const presenter = { post: (m: unknown) => posts.push(m) } as any;

  const okClient = { isStarted: true, request: async () => ({ success: true, data: V078_PAYLOAD }) };
  const okRt: any = { id: "rt-1", client: okClient };
  await new SessionStatsService(presenter).postStats(okRt);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].type, "sessionStats");
  assert.equal(posts[0].sessionId, "rt-1");
  assert.equal(posts[0].stats.cost, 0.42);

  const failClient = { isStarted: true, request: async () => ({ success: false, error: "unknown command" }) };
  await new SessionStatsService(presenter).postStats({ id: "rt-2", client: failClient } as any);
  assert.equal(posts.length, 1); // older pi → silent no-op

  await new SessionStatsService(presenter).postStats(undefined);
  assert.equal(posts.length, 1);
});

test("statsPopoverHtml: context bar, token split, Est. cost label, and usage-remaining rows", () => {
  const stats = sessionStatsFromRpc(V078_PAYLOAD)!;
  const html = statsPopoverHtml(stats, [{ label: "5h limit", value: "1% used · resets 11:24 PM" }]);
  assert.ok(html.includes(">Context<"));
  assert.ok(html.includes("78k of 200k tokens")); // formatTokens drops decimals ≥10k
  assert.ok(html.includes("61% left"));
  assert.ok(html.includes('style="width:39%"')); // mini bar
  assert.ok(html.includes(">Session<"));
  assert.ok(html.includes("Cache read"));
  assert.ok(html.includes("Est. API cost")); // honest label — pi converts via price table
  assert.ok(html.includes(">Usage remaining<"));
  assert.ok(html.includes("5h limit"));

  // No usage data → section omitted entirely.
  const noUsage = statsPopoverHtml(stats, []);
  assert.equal(noUsage.includes("Usage remaining"), false);
  // Post-compaction (percent null) → no Context section, Session still renders.
  const postCompaction = statsPopoverHtml({ ...stats, context: { tokens: null, contextWindow: 200_000, percent: null } }, []);
  assert.equal(postCompaction.includes(">Context<"), false);
  assert.ok(postCompaction.includes(">Session<"));
});

test("statsSummary and contextLabel format Claude-style", () => {
  const stats = sessionStatsFromRpc(V078_PAYLOAD)!;
  assert.equal(statsSummary(stats), "54k tokens · $0.42");
  assert.deepEqual(contextLabel(stats.context), { percentUsed: 39, label: "61% left" });
  // Free model: cost segment omitted.
  assert.equal(statsSummary({ ...stats, cost: 0 }), "54k tokens");
  // Post-compaction unknown → segment omitted.
  assert.equal(contextLabel({ tokens: null, contextWindow: 200_000, percent: null }), undefined);
  assert.equal(contextLabel(undefined), undefined);
});
