// Pure string/format helpers used while rendering the chat. No DOM access.

export function uid(prefix: string): string {
  return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
}

export function escapeHtml(text: unknown): string {
  return String(text ?? "").replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return ch;
    }
  });
}

export function roleLabel(role: string): string {
  if (role === "assistant") return "Pi";
  if (role === "tool") return "Tool";
  return role;
}

export function formatTime(value: number | undefined): string {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString(undefined, { weekday: "long", hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

export function formatDuration(startedAt: number | undefined, endedAt: number | null | undefined): string {
  if (!startedAt) return "";
  const seconds = Math.max(0, Math.round(((endedAt || Date.now()) - startedAt) / 1000));
  if (seconds < 60) return seconds + "s";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes + "m " + rest + "s";
}

// Compact token count: 5286 → "5.3k", 1_200_000 → "1.2M".
export function formatTokens(tokens: number | undefined): string {
  const n = typeof tokens === "number" && Number.isFinite(tokens) ? tokens : 0;
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + "k";
  return (n / 1_000_000).toFixed(1) + "M";
}

// USD cost: rounds to cents, with a "$0.01" floor for tiny non-zero amounts.
export function formatCost(cost: number | undefined): string {
  const n = typeof cost === "number" && Number.isFinite(cost) ? cost : 0;
  if (n <= 0) return "";
  const cents = Math.max(1, Math.round(n * 100));
  return "$" + (cents / 100).toFixed(2);
}
