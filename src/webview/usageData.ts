// Webview store + formatters for provider usage data pushed by the vscode-usage-bridge
// (pi extension) via setStatus("vscode-usage", json). Codex-style "Usage remaining" rows
// for the stats popover. Tolerant decoder — junk payloads are ignored; no data simply
// means no rows (providers/plans that send no rate-limit headers).
import { formatTokens } from "./util";

export interface UsageRow {
  label: string;
  value: string;
}

/** One row of the Codex-style usage menu: label / big value / reset time columns. */
export interface UsageMenuRow {
  /** "5h", "Weekly", "Requests", … */
  label: string;
  /** "98%" (percent REMAINING for subscription windows) or "4.9k of 5k" for limits. */
  value: string;
  /** "11:24 PM" / "Jun 13" / "" when the provider sent no reset. */
  reset: string;
}

interface UnifiedWindow {
  window: string;
  utilization?: number;
  status?: string;
  reset?: number;
}

interface Limit {
  kind: string;
  remaining?: number;
  limit?: number;
  reset?: number;
}

let unified: UnifiedWindow[] = [];
let limits: Limit[] = [];

const listeners = new Set<() => void>();

export function subscribeUsageData(listener: () => void): void {
  listeners.add(listener);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function setUsageData(payload: unknown): void {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : undefined;
  unified = Array.isArray(record?.unified)
    ? (record!.unified as unknown[])
        .filter((w): w is Record<string, unknown> => !!w && typeof w === "object")
        .map((w) => ({
          window: typeof w.window === "string" ? w.window : "overall",
          utilization: num(w.utilization),
          status: typeof w.status === "string" ? w.status : undefined,
          reset: num(w.reset),
        }))
    : [];
  limits = Array.isArray(record?.limits)
    ? (record!.limits as unknown[])
        .filter((l): l is Record<string, unknown> => !!l && typeof l === "object")
        .map((l) => ({
          kind: typeof l.kind === "string" ? l.kind : "limit",
          remaining: num(l.remaining),
          limit: num(l.limit),
          reset: num(l.reset),
        }))
    : [];
  for (const listener of listeners) listener();
}

export function hasUsageData(): boolean {
  return unified.length > 0 || limits.length > 0;
}

function windowLabel(window: string): string {
  if (window === "5h") return "5h";
  if (window === "7d") return "Weekly";
  if (window === "overall") return "Plan";
  return window;
}

function resetLabel(reset: number | undefined): string {
  if (!reset) return "";
  const date = new Date(reset);
  const sameDay = new Date().toDateString() === date.toDateString();
  try {
    return sameDay
      ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
      : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

function kindLabel(kind: string): string {
  return kind
    .split("-")
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(" ");
}

/** Rows for the "Usage remaining" popover section — empty when no data arrived. */
export function usageSummaryRows(): UsageRow[] {
  const rows: UsageRow[] = [];
  for (const w of unified) {
    const parts: string[] = [];
    if (w.utilization !== undefined) parts.push(Math.round(w.utilization) + "% used");
    else if (w.status) parts.push(w.status);
    const reset = resetLabel(w.reset);
    if (reset) parts.push("resets " + reset);
    if (parts.length) rows.push({ label: windowLabel(w.window), value: parts.join(" · ") });
  }
  for (const l of limits) {
    const parts: string[] = [];
    if (l.remaining !== undefined && l.limit !== undefined) {
      parts.push(formatTokens(l.remaining) + " of " + formatTokens(l.limit) + " left");
    } else if (l.remaining !== undefined) {
      parts.push(formatTokens(l.remaining) + " left");
    }
    const reset = resetLabel(l.reset);
    if (reset) parts.push("resets " + reset);
    if (parts.length) rows.push({ label: kindLabel(l.kind), value: parts.join(" · ") });
  }
  return rows;
}

/** Rows for the Codex-style click menu: subscription windows show the percent REMAINING
 *  ("5h · 98% · 11:24 PM"), API limits show remaining-of-limit. Empty = no data yet. */
export function usageMenuRows(): UsageMenuRow[] {
  const rows: UsageMenuRow[] = [];
  for (const w of unified) {
    const value =
      w.utilization !== undefined
        ? Math.max(0, Math.min(100, Math.round(100 - w.utilization))) + "%"
        : w.status ?? "";
    if (value) rows.push({ label: windowLabel(w.window), value, reset: resetLabel(w.reset) });
  }
  for (const l of limits) {
    const value =
      l.remaining !== undefined && l.limit !== undefined
        ? formatTokens(l.remaining) + " of " + formatTokens(l.limit)
        : l.remaining !== undefined
        ? formatTokens(l.remaining) + " left"
        : "";
    if (value) rows.push({ label: kindLabel(l.kind), value, reset: resetLabel(l.reset) });
  }
  return rows;
}
