// Pure helpers shared across the host units (no vscode/fs/runtime state — unit-testable).

/** Pulls the `sessionFile` path out of a pi state record, guarding the loose `unknown` shape. */
export function readSessionFile(state: Record<string, unknown> | undefined): string | undefined {
  return typeof state?.sessionFile === "string" ? state.sessionFile : undefined;
}

// Cap a tool's output before sending it to the webview so a huge bash/read result can't
// bloat the message channel or the persisted session view.
export function truncateToolOutput(text: string): string {
  const MAX_CHARS = 4000;
  const MAX_LINES = 40;
  let out = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + "\n…(truncated)" : text;
  const lines = out.split("\n");
  if (lines.length > MAX_LINES) out = lines.slice(0, MAX_LINES).join("\n") + "\n…(truncated)";
  return out;
}

// Short provenance badge for a command, mirroring pi's own getAutocompleteSourceTag:
// scope prefix (user→u / project→p / else→t), then the package source for npm installs.
// Git URLs collapse to the bare scope prefix here (full git formatting is omitted as it's
// a rare case for slash commands and the badge is only a hint).
export function buildSourceTag(sourceInfo: Record<string, unknown> | undefined): string | undefined {
  if (!sourceInfo) return undefined;
  const scope = sourceInfo.scope;
  const prefix = scope === "user" ? "u" : scope === "project" ? "p" : "t";
  const source = typeof sourceInfo.source === "string" ? sourceInfo.source.trim() : "";
  if (source.startsWith("npm:")) return `${prefix}:${source}`;
  return prefix;
}
