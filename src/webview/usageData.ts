// Webview store for provider usage data pushed by the vscode-usage-bridge (pi extension)
// via setStatus("vscode-usage", json), plus the row formatter for the always-visible
// usage gauge bars. Tolerant decoder — junk payloads are ignored; no data simply means
// no bars (providers/plans without subscription windows).

/** One always-visible gauge bar: "5h" / "1w" with the percent REMAINING (battery
 *  metaphor — 1% used renders a 99% bar) and the reset time for its hover popover. */
export interface UsageBarRow {
  label: string;
  /** 0-100, percent remaining. */
  remainingPercent: number;
  /** "11:24 PM" / "Jun 13" / "" when the provider sent no reset. */
  reset: string;
}

interface UnifiedWindow {
  window: string;
  utilization?: number;
  status?: string;
  reset?: number;
}

let unified: UnifiedWindow[] = [];

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
  // The payload's `limits` (API rate limits) are intentionally not rendered anywhere —
  // the usage UI is scoped to subscription windows — so they are not retained either.
  for (const listener of listeners) listener();
}

export function hasUsageData(): boolean {
  return unified.some((w) => w.utilization !== undefined);
}

function windowLabel(window: string): string {
  if (window === "5h") return "5h";
  if (window === "7d") return "1w";
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

/** Rows for the gauge bars — subscription windows only; empty when no data arrived. */
export function usageBarRows(): UsageBarRow[] {
  const rows: UsageBarRow[] = [];
  for (const w of unified) {
    if (w.utilization === undefined) continue;
    rows.push({
      label: windowLabel(w.window),
      remainingPercent: Math.max(0, Math.min(100, Math.round(100 - w.utilization))),
      reset: resetLabel(w.reset),
    });
  }
  return rows;
}
