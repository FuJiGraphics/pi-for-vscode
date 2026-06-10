// VS Code usage bridge — loaded into pi via `-e` by pi-for-vscode (never installed into
// the user's pi settings). Forwards ChatGPT-Codex subscription usage to the VS Code
// webview through `ctx.ui.setStatus` (RPC `extension_ui_request{method:"setStatus",
// statusKey:"vscode-usage"}` — the webview intercepts that key and renders a Codex-style
// "Usage remaining" menu, shown only while an openai-codex OAuth login exists).
//
// Two sources, both via pi's official extension API:
//  1. `GET <codex baseUrl root>/wham/usage` — the same backend endpoint Codex CLI itself
//     uses (codex-rs backend-client). Fetched on session_start / agent_end with a cooldown,
//     authorized through ctx.modelRegistry.getApiKeyAndHeaders (pi owns token refresh).
//     This works regardless of pi's streaming transport (WebSocket or SSE).
//  2. `after_provider_response` HTTP headers — instant per-request refresh. Codex sends
//     `x-codex-{primary,secondary}-*` (SSE transport only; the WebSocket path surfaces no
//     headers), Anthropic sends `anthropic-ratelimit-*`, OpenAI API sends `x-ratelimit-*`.
//
// Tolerant by design: anything absent is simply omitted, every handler is wrapped, and a
// parse/network failure can never disturb pi's run.

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

/** Codex window length → the unified window names the UI already knows: 300 → "5h",
 *  10080 → "7d"; anything else keeps a readable unit, or the raw name when absent. */
function codexWindowLabel(minutes: number | undefined, fallback: string): string {
  if (minutes === undefined || minutes <= 0) return fallback;
  if (minutes % 1440 === 0) return minutes / 1440 + "d";
  if (minutes % 60 === 0) return minutes / 60 + "h";
  return minutes + "m";
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
  // Codex fields arrive across several headers and the window NAME depends on one of
  // them (window-minutes), so collect per primary/secondary first, convert after the loop.
  const codex = new Map<string, { usedPercent?: number; windowMinutes?: number; resetAt?: number; resetAfterMs?: number }>();
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

    // ChatGPT Codex subscription windows: x-codex-(primary|secondary)-<field>.
    // used-percent is already a percent (e.g. "1" = 1%) — never ratio-normalized.
    const codexHeader = /^x-codex-(primary|secondary)-(used-percent|window-minutes|reset-at|reset-after-seconds)$/.exec(key);
    if (codexHeader) {
      let entry = codex.get(codexHeader[1]);
      if (!entry) {
        entry = {};
        codex.set(codexHeader[1], entry);
      }
      const n = num(value);
      if (codexHeader[2] === "used-percent") {
        if (n !== undefined) entry.usedPercent = Math.min(100, Math.max(0, n));
      } else if (codexHeader[2] === "window-minutes") {
        entry.windowMinutes = n;
      } else if (codexHeader[2] === "reset-at") {
        entry.resetAt = toEpochMs(value);
      } else if (n !== undefined) {
        entry.resetAfterMs = n * 1000;
      }
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

  // Codex windows join the unified list under duration labels so the existing UI
  // naming ("5h" / 7d→Weekly) applies unchanged.
  for (const [name, c] of codex) {
    if (c.usedPercent === undefined && c.resetAt === undefined && c.resetAfterMs === undefined) continue;
    const entry = windowOf([codexWindowLabel(c.windowMinutes, name)]);
    if (c.usedPercent !== undefined) entry.utilization = c.usedPercent;
    const reset = c.resetAt ?? (c.resetAfterMs !== undefined ? now + c.resetAfterMs : undefined);
    if (reset !== undefined) entry.reset = reset;
  }

  const unified = [...windows.values()].filter((w) => w.utilization !== undefined || w.status || w.reset);
  const limitList = [...limits.values()].filter((l) => l.remaining !== undefined || l.limit !== undefined);
  if (unified.length === 0 && limitList.length === 0) return undefined;
  return { at: now, unified, limits: limitList };
}

/** `<codex baseUrl>` (e.g. "https://chatgpt.com/backend-api", possibly with a trailing
 *  /codex or /codex/responses segment) → the usage endpoint Codex CLI reads. */
export function codexUsageUrl(baseUrl: unknown): string {
  const raw = typeof baseUrl === "string" && baseUrl.trim() ? baseUrl.trim() : "https://chatgpt.com/backend-api";
  const root = raw.replace(/\/+$/, "").replace(/\/codex(\/responses)?$/, "");
  return root + "/wham/usage";
}

/** ChatGPT account id from the OAuth access token's JWT claims (same claim pi-ai reads).
 *  Undefined on any irregularity — the header is then simply omitted, like Codex CLI. */
export function extractAccountId(token: string): string | undefined {
  try {
    const part = token.split(".")[1] ?? "";
    const payload = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    const accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof accountId === "string" && accountId ? accountId : undefined;
  } catch {
    return undefined;
  }
}

/** Parse the `GET …/wham/usage` response (codex-rs RateLimitStatusPayload) into the
 *  bridge payload, or undefined when no window data is present. Pure — unit-tested. */
export function parseCodexUsageResponse(body: unknown, now: number): UsagePayload | undefined {
  const rateLimit = (body as AnyRecord)?.rate_limit;
  if (!rateLimit || typeof rateLimit !== "object") return undefined;
  const unified: UnifiedWindowUsage[] = [];
  for (const [name, window] of [["primary", rateLimit.primary_window], ["secondary", rateLimit.secondary_window]] as const) {
    if (!window || typeof window !== "object") continue;
    const used = num(window.used_percent);
    const windowSeconds = num(window.limit_window_seconds);
    const resetAt = toEpochMs(window.reset_at);
    const resetAfter = num(window.reset_after_seconds);
    const entry: UnifiedWindowUsage = {
      window: codexWindowLabel(windowSeconds !== undefined ? windowSeconds / 60 : undefined, name),
    };
    if (used !== undefined) entry.utilization = Math.min(100, Math.max(0, used));
    const reset = resetAt ?? (resetAfter !== undefined ? now + resetAfter * 1000 : undefined);
    if (reset !== undefined) entry.reset = reset;
    if (entry.utilization !== undefined || entry.reset !== undefined) unified.push(entry);
  }
  if (unified.length === 0) return undefined;
  return { at: now, unified, limits: [] };
}

const ENDPOINT_COOLDOWN_MS = 30_000;

export default function vscodeUsageBridge(pi: AnyRecord): void {
  if (!pi || typeof pi.on !== "function") return;

  const post = (ctx: AnyRecord, payload: UsagePayload): void => {
    if (typeof ctx?.ui?.setStatus === "function") {
      ctx.ui.setStatus("vscode-usage", JSON.stringify(payload));
    }
  };

  // Source 1: the Codex usage endpoint — transport-independent. Skipped silently when
  // no openai-codex auth is configured (the webview hides the menu in that case too).
  let lastFetchAt = 0;
  let fetching = false;
  const refreshFromEndpoint = async (ctx: AnyRecord): Promise<void> => {
    if (fetching || Date.now() - lastFetchAt < ENDPOINT_COOLDOWN_MS) return;
    fetching = true;
    try {
      const registry = ctx?.modelRegistry;
      if (typeof registry?.getAll !== "function" || typeof registry?.getApiKeyAndHeaders !== "function") return;
      const model = registry.getAll().find(
        (m: AnyRecord) => m?.provider === "openai-codex" && registry.hasConfiguredAuth?.(m),
      );
      if (!model) return;
      lastFetchAt = Date.now();
      const auth = await registry.getApiKeyAndHeaders(model);
      if (!auth?.ok || !auth.apiKey) return;
      const headers: Record<string, string> = { Authorization: `Bearer ${auth.apiKey}`, originator: "pi" };
      const accountId = extractAccountId(auth.apiKey);
      if (accountId) headers["chatgpt-account-id"] = accountId;
      const response = await fetch(codexUsageUrl(model.baseUrl), { headers, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return;
      const payload = parseCodexUsageResponse(await response.json(), Date.now());
      if (payload) post(ctx, payload);
    } catch {
      // Offline / endpoint change / auth hiccup: usage is cosmetic, never disturb the run.
    } finally {
      fetching = false;
    }
  };
  pi.on("session_start", async (_event: AnyRecord, ctx: AnyRecord) => refreshFromEndpoint(ctx));
  pi.on("agent_end", async (_event: AnyRecord, ctx: AnyRecord) => refreshFromEndpoint(ctx));

  // Source 2: rate-limit response headers — posted on EVERY response that carries usage
  // info (idempotent, one JSON line per provider call). No change dedup, so a webview
  // that was closed when an update went out simply catches the next one.
  pi.on("after_provider_response", async (event: AnyRecord, ctx: AnyRecord) => {
    try {
      const payload = parseUsageHeaders(event?.headers, Date.now());
      if (!payload) return;
      post(ctx, payload);
    } catch {
      // Never let usage reporting disturb the run.
    }
  });
}
