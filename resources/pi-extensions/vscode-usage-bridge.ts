// VS Code usage bridge — loaded into pi via `-e` by pi-for-vscode (never installed into
// the user's pi settings). Subscribes to pi's official `after_provider_response` extension
// event, which carries the provider's HTTP response headers, and forwards any rate-limit /
// subscription-usage information to the VS Code webview through `ctx.ui.setStatus`
// (RPC `extension_ui_request{method:"setStatus", statusKey:"vscode-usage"}` — the webview
// intercepts that key and renders a Codex-style "Usage remaining" section).
//
// Tolerant by design: header sets differ per provider/plan (Anthropic subscription sends
// `anthropic-ratelimit-unified-*`, API keys send `anthropic-ratelimit-{requests,…}-*`,
// OpenAI sends `x-ratelimit-*`); anything absent is simply omitted. The whole handler is
// wrapped so a parse failure can never disturb pi's run.

type AnyRecord = Record<string, any>;

export interface UnifiedWindowUsage {
  /** e.g. "5h", "7d", "overall" (headers without a window segment). */
  window: string;
  /** Percent used, 0-100 (normalized from either a 0-1 ratio or a percent value). */
  utilization?: number;
  status?: string;
  /** Reset time, ms since epoch. */
  reset?: number;
}

export interface LimitUsage {
  /** e.g. "requests", "input-tokens", "output-tokens", "tokens". */
  kind: string;
  remaining?: number;
  limit?: number;
  /** Reset time, ms since epoch. */
  reset?: number;
}

export interface UsagePayload {
  at: number;
  unified: UnifiedWindowUsage[];
  limits: LimitUsage[];
}

function num(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** Ratio (0-1) or percent → percent 0-100. Values ≤ 1.5 are treated as ratios. */
function toPercent(value: number): number {
  const pct = value <= 1.5 ? value * 100 : value;
  return Math.min(100, Math.max(0, pct));
}

/** Unix seconds, unix ms, or an RFC3339 date string → ms since epoch. */
function toEpochMs(value: unknown): number | undefined {
  const n = num(value);
  if (n !== undefined && n > 0) return n < 10_000_000_000 ? n * 1000 : n;
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** OpenAI-style reset durations: "1s", "6m20s", "1h2m3s", "250ms" → ms-from-now offset. */
export function parseDurationMs(value: string): number | undefined {
  const text = value.trim();
  if (!text) return undefined;
  let total = 0;
  let matched = false;
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    matched = true;
    const amount = Number(m[1]);
    total += m[2] === "h" ? amount * 3_600_000 : m[2] === "m" ? amount * 60_000 : m[2] === "ms" ? amount : amount * 1000;
  }
  return matched ? total : undefined;
}

/** Parse provider rate-limit headers (lowercase keys) into the usage payload, or
 *  undefined when nothing usage-related is present. Pure — unit-tested directly. */
export function parseUsageHeaders(headers: Record<string, unknown> | undefined, now: number): UsagePayload | undefined {
  if (!headers || typeof headers !== "object") return undefined;

  const windows = new Map<string, UnifiedWindowUsage>();
  const limits = new Map<string, LimitUsage>();
  const windowOf = (segments: string[]): UnifiedWindowUsage => {
    const key = segments.length ? segments.join("-") : "overall";
    let entry = windows.get(key);
    if (!entry) {
      entry = { window: key };
      windows.set(key, entry);
    }
    return entry;
  };
  const limitOf = (kind: string): LimitUsage => {
    let entry = limits.get(kind);
    if (!entry) {
      entry = { kind };
      limits.set(kind, entry);
    }
    return entry;
  };

  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.toLowerCase();
    const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;

    // Anthropic subscription windows: anthropic-ratelimit-unified[-<window>]-<field>
    if (key.startsWith("anthropic-ratelimit-unified-")) {
      const parts = key.slice("anthropic-ratelimit-unified-".length).split("-");
      const field = parts.pop() ?? "";
      const entry = windowOf(parts);
      if (field === "utilization") {
        const n = num(value);
        if (n !== undefined) entry.utilization = toPercent(n);
      } else if (field === "status") {
        if (typeof value === "string" && value) entry.status = value;
      } else if (field === "reset") {
        entry.reset = toEpochMs(value);
      }
      continue;
    }

    // Anthropic API limits: anthropic-ratelimit-<kind>-{remaining,limit,reset}
    const anthropic = /^anthropic-ratelimit-(.+)-(remaining|limit|reset)$/.exec(key);
    if (anthropic) {
      const entry = limitOf(anthropic[1]);
      if (anthropic[2] === "remaining") entry.remaining = num(value);
      else if (anthropic[2] === "limit") entry.limit = num(value);
      else entry.reset = toEpochMs(value);
      continue;
    }

    // OpenAI: x-ratelimit-{remaining,limit,reset}-{requests,tokens}
    const openai = /^x-ratelimit-(remaining|limit|reset)-(.+)$/.exec(key);
    if (openai) {
      const entry = limitOf(openai[2]);
      if (openai[1] === "remaining") entry.remaining = num(value);
      else if (openai[1] === "limit") entry.limit = num(value);
      else if (typeof value === "string") {
        const offset = parseDurationMs(value);
        entry.reset = offset !== undefined ? now + offset : toEpochMs(value);
      }
    }
  }

  const unified = [...windows.values()].filter((w) => w.utilization !== undefined || w.status || w.reset);
  const limitList = [...limits.values()].filter((l) => l.remaining !== undefined || l.limit !== undefined);
  if (unified.length === 0 && limitList.length === 0) return undefined;
  return { at: now, unified, limits: limitList };
}

export default function vscodeUsageBridge(pi: AnyRecord): void {
  if (!pi || typeof pi.on !== "function") return;

  let lastSent = "";
  pi.on("after_provider_response", async (event: AnyRecord, ctx: AnyRecord) => {
    try {
      const payload = parseUsageHeaders(event?.headers, Date.now());
      if (!payload) return;
      // Serialize without the timestamp for change detection — identical limits across
      // calls shouldn't re-post.
      const sig = JSON.stringify({ unified: payload.unified, limits: payload.limits });
      if (sig === lastSent) return;
      lastSent = sig;
      if (typeof ctx?.ui?.setStatus === "function") {
        ctx.ui.setStatus("vscode-usage", JSON.stringify(payload));
      }
    } catch {
      // Never let usage reporting disturb the run.
    }
  });
}
