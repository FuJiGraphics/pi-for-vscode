// Per-tool visual identity for the timeline: a small inline-SVG glyph and a color tone
// keyed off the RAW pi tool name (labels collapse several tools into one verb, so theming
// must never key off them — same rule as cards.ts toolName). Icons are trusted constant
// markup (currentColor strokes, no external resources — CSP-safe); tones map to CSS
// custom properties in chat.css (`.tl-step[data-tone=…] { --tool-accent: … }`).
// Unknown/MCP tools fall back to a neutral glyph with the default accent.
import type { ActivityStep } from "./types";

export interface ToolTheme {
  /** Inline SVG markup (trusted constant — emitted unescaped inside .tl-icon). */
  icon: string;
  /** Tone name consumed by chat.css; "" = default accent. */
  tone: string;
}

const SVG_OPEN =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';

function svg(body: string): string {
  return SVG_OPEN + body + "</svg>";
}

const ICONS = {
  read: svg('<path d="M4 1.5h5.5L13 5v9.5H4z"/><path d="M9.5 1.5V5H13"/>'),
  bash: svg('<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M4.5 6l2.5 2-2.5 2"/><path d="M8.5 10.5h3"/>'),
  edit: svg('<path d="M3 13l.8-3.2 7.4-7.4a1.3 1.3 0 0 1 1.8 0l.6.6a1.3 1.3 0 0 1 0 1.8L6.2 12.2z"/><path d="M9.8 3.8l2.4 2.4"/>'),
  write: svg('<path d="M4 1.5h5.5L13 5v9.5H4z"/><path d="M6.5 9.5h4"/><path d="M8.5 7.5v4"/>'),
  search: svg('<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>'),
  folder: svg('<path d="M1.5 3.5h4l1.5 2h7.5v7h-13z"/>'),
  list: svg('<path d="M5.5 4h8M5.5 8h8M5.5 12h8"/><circle cx="2.6" cy="4" r=".9" fill="currentColor" stroke="none"/><circle cx="2.6" cy="8" r=".9" fill="currentColor" stroke="none"/><circle cx="2.6" cy="12" r=".9" fill="currentColor" stroke="none"/>'),
  todo: svg('<rect x="2" y="2" width="12" height="12" rx="2.5"/><path d="M5 8.2l2.2 2.2L11.5 6"/>'),
  globe: svg('<circle cx="8" cy="8" r="6"/><path d="M2 8h12"/><path d="M8 2c2 1.8 2 10.2 0 12-2-1.8-2-10.2 0-12z"/>'),
  fetch: svg('<path d="M8 2v7"/><path d="M5 6.5L8 9.5l3-3"/><path d="M2.5 11v2.5h11V11"/>'),
  think: svg('<path d="M8 1.8l1.2 3.4 3.4 1.2-3.4 1.2L8 11l-1.2-3.4L3.4 6.4l3.4-1.2z"/>'),
  gen: svg('<path d="M8.8 1.5L3.5 9h3.5l-.8 5.5L11.5 7H8z"/>'),
  dots: svg('<circle cx="3.5" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="12.5" cy="8" r="1" fill="currentColor" stroke="none"/>'),
};

// Ground-truth pi built-ins (read/bash/edit/write/grep/find/ls) plus the bundled todo and
// pi-web-access tools. Anything else (user/MCP tools) takes the neutral fallback.
const TOOL_THEMES: Record<string, ToolTheme> = {
  read: { icon: ICONS.read, tone: "read" },
  bash: { icon: ICONS.bash, tone: "bash" },
  edit: { icon: ICONS.edit, tone: "edit" },
  write: { icon: ICONS.write, tone: "edit" },
  grep: { icon: ICONS.search, tone: "search" },
  glob: { icon: ICONS.search, tone: "search" },
  find: { icon: ICONS.folder, tone: "search" },
  ls: { icon: ICONS.list, tone: "search" },
  code_search: { icon: ICONS.search, tone: "search" },
  todo: { icon: ICONS.todo, tone: "todo" },
  web_search: { icon: ICONS.globe, tone: "web" },
  fetch_content: { icon: ICONS.fetch, tone: "web" },
  get_search_content: { icon: ICONS.fetch, tone: "web" },
};

const FALLBACK: ToolTheme = { icon: ICONS.dots, tone: "" };
const THINKING_THEME: ToolTheme = { icon: ICONS.think, tone: "think" };
const GENERATION_THEME: ToolTheme = { icon: ICONS.gen, tone: "gen" };

export function toolTheme(tool: string | undefined, kind?: ActivityStep["kind"]): ToolTheme {
  if (kind === "thinking") return THINKING_THEME;
  if (kind === "generation") return GENERATION_THEME;
  if (!tool) return FALLBACK;
  return TOOL_THEMES[tool.toLowerCase()] ?? FALLBACK;
}
