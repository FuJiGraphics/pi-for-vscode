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

export function renderMarkdown(text: string): string {
  let html = escapeHtml(text);
  html = html.replace(new RegExp("[*][*]([^*]+)[*][*]", "g"), "<strong>$1</strong>");
  html = html.replace(new RegExp("(https?://[^ )]+)", "g"), '<a href="$1">$1</a>');
  return html;
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
