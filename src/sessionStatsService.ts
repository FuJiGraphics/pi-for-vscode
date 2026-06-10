// Fetches pi's authoritative session stats (cumulative tokens/cost + compaction-aware
// context usage) and posts them to the webview, tagged with the runtime id so the
// per-session view routing (withSession) applies for free. Pi computes everything —
// the extension never re-derives cost or context percentages (thin wrapper).
import type { SessionStats } from "./protocol";
import { asRecord } from "./sessionFormat";
import type { SessionRuntime } from "./sessionRuntime";
import type { WebviewPresenter } from "./webviewPresenter";

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Pure, tolerant mapper from pi's get_session_stats payload. Accepts both the v0.78
 *  contextUsage shape ({tokens, percent}) and the alternate field names
 *  ({contextTokens, contextPercentage}) so a pi-side rename degrades gracefully. */
export function sessionStatsFromRpc(data: unknown): SessionStats | undefined {
  const record = asRecord(data);
  if (!record) return undefined;
  const tokens = asRecord(record.tokens);
  const stats: SessionStats = {
    tokens: {
      input: num(tokens?.input),
      output: num(tokens?.output),
      cacheRead: num(tokens?.cacheRead),
      cacheWrite: num(tokens?.cacheWrite),
      total: num(tokens?.total),
    },
    cost: num(record.cost),
  };
  const usage = asRecord(record.contextUsage);
  if (usage) {
    const contextWindow = num(usage.contextWindow);
    if (contextWindow > 0) {
      stats.context = {
        tokens: numOrNull(usage.tokens ?? usage.contextTokens),
        contextWindow,
        percent: numOrNull(usage.percent ?? usage.contextPercentage),
      };
    }
  }
  return stats;
}

export class SessionStatsService {
  constructor(private readonly presenter: WebviewPresenter) {}

  /** Fetch + post the runtime's stats. Silent no-op on any failure (an older pi without
   *  the RPC just leaves the stats bar hidden). No throttling needed: callers fire once
   *  per agent_end / compaction_end / activate — never per LLM call. */
  async postStats(rt: SessionRuntime | undefined): Promise<void> {
    const client = rt?.client;
    if (!rt || !client?.isStarted) return;
    const response = await client.request({ type: "get_session_stats" }, 10_000).catch(() => undefined);
    if (!response || response.success === false) return;
    if (rt.client !== client) return; // runtime reaped/reconnected mid-flight — stale guard
    const stats = sessionStatsFromRpc(response.data);
    if (stats) this.presenter.post({ type: "sessionStats", sessionId: rt.id, stats });
  }
}
