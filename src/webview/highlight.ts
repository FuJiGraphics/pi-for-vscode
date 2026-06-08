// Syntax highlighting for the code shown in Read/Write tool cards. Uses Shiki with the
// JavaScript regex engine (NOT the WASM engine) so it runs under the webview CSP, which has
// no 'wasm-unsafe-eval'. Grammars are bundled (curated set); the THEME is supplied by the
// host (it resolves the user's active VS Code theme JSON) so highlighting tracks the editor.
//
// The highlighter loads asynchronously. Until it is ready (and on a theme change), the cards
// render escaped plaintext; `highlightToLines` returns null in that window. When the
// highlighter or theme becomes ready, we notify the renderer to force a re-paint of the cards
// (see setHighlightNotifier / the highlightVersion key in render.ts) — without that nudge the
// render key never changes and the colors would never appear.
// Runtime Shiki values are loaded via dynamic import() inside initHighlighter (esbuild inlines
// them into the bundle). Only TYPES are imported statically — those are erased at compile, so
// merely importing this module (e.g. from cards.ts in a unit test) never pulls in Shiki.
import type { HighlighterCore } from "shiki/core";
import type { ThemedToken } from "@shikijs/types";
// Metadata + per-grammar dynamic-import thunks for ALL ~332 bundled languages. Importing this is
// cheap (just the id/alias table + tiny loader fns); each grammar's actual weight lives behind its
// `() => import('@shikijs/langs/<id>')` thunk, which esbuild (esm + splitting) emits as a separate
// chunk fetched only on demand. The JS regex engine (CSP-safe) is still used.
import { bundledLanguagesBase, bundledLanguagesInfo } from "shiki/langs";
import { escapeHtml } from "./util";

export type ThemeKind = "light" | "dark" | "highContrast" | "highContrastLight";

let highlighter: HighlighterCore | undefined;
let currentTheme = "dark-plus";
let pending: { theme?: unknown; kind: ThemeKind } | undefined;
let notify: () => void = () => {};

/** Wired by main.ts to render.ts's bumpHighlightVersion so a ready/theme change forces a repaint. */
export function setHighlightNotifier(fn: () => void): void {
  notify = fn;
}

export async function initHighlighter(): Promise<void> {
  if (highlighter) return;
  const [core, jsEngine] = await Promise.all([import("shiki/core"), import("shiki/engine/javascript")]);
  // ES2018 target keeps the generated RegExp on the `u` flag (no ES2024 `v` flag), so it runs on
  // older engines; `forgiving` degrades an unsupported grammar pattern to best-effort instead of
  // throwing. Only `new RegExp` is used at runtime — no eval/WASM — so the CSP is satisfied.
  const engine = jsEngine.createJavaScriptRegexEngine({ target: "ES2018", forgiving: true });
  highlighter = await core.createHighlighterCore({
    engine,
    themes: [import("@shikijs/themes/dark-plus"), import("@shikijs/themes/light-plus")],
    // Only the small CORE_LANGS set ships eagerly (instant highlighting for the dominant
    // languages). Every other grammar is loaded on demand via ensureLanguage(). Keep this list
    // in sync with CORE_LANGS below.
    langs: [
      import("@shikijs/langs/typescript"),
      import("@shikijs/langs/javascript"),
      import("@shikijs/langs/json"),
      import("@shikijs/langs/python"),
      import("@shikijs/langs/css"),
      import("@shikijs/langs/html"),
      import("@shikijs/langs/bash"),
      import("@shikijs/langs/markdown"),
    ],
  });
  for (const id of CORE_LANGS) loaded.add(id);
  if (pending) {
    await applyTheme(pending.theme, pending.kind);
    pending = undefined;
  }
  notify();
}

function bundledThemeFor(kind: ThemeKind): string {
  return kind === "light" || kind === "highContrastLight" ? "light-plus" : "dark-plus";
}

async function applyTheme(theme: unknown, kind: ThemeKind): Promise<void> {
  if (!highlighter) return;
  if (theme && typeof theme === "object") {
    try {
      await highlighter.loadTheme(theme as Parameters<HighlighterCore["loadTheme"]>[0]);
      const name = (theme as { name?: unknown }).name;
      currentTheme = typeof name === "string" && name ? name : bundledThemeFor(kind);
      return;
    } catch {
      // Malformed/unsupported theme JSON — fall back to the bundled default for this kind.
    }
  }
  currentTheme = bundledThemeFor(kind);
}

/** Apply the active editor theme. Queues if the highlighter is still loading. */
export function setTheme(theme: unknown, kind: ThemeKind): void {
  if (!highlighter) {
    pending = { theme, kind };
    return;
  }
  void applyTheme(theme, kind).then(notify);
}

// Map a file path to a bundled Shiki language id. Unknown/extensionless → "" (plaintext).
const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json",
  py: "python", pyi: "python",
  css: "css", scss: "css",
  html: "html", htm: "html", xml: "html", svg: "html", vue: "html",
  sh: "bash", bash: "bash", zsh: "bash",
  md: "markdown", markdown: "markdown",
  yml: "yaml", yaml: "yaml",
  cs: "csharp",
  java: "java", kt: "kotlin", kts: "kotlin",
  go: "go",
  rs: "rust",
  c: "c", h: "c",
  cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hxx: "cpp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  sql: "sql",
  toml: "toml",
};

export function langForPath(path: unknown): string {
  if (typeof path !== "string" || !path) return "";
  const base = path.split(/[\\/]/).pop() || path;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "";
  return LANG_BY_EXT[base.slice(dot + 1).toLowerCase()] || "";
}

// Resolve a fenced-code-block info string / language alias to a canonical Shiki language id,
// covering ALL bundled grammars + their aliases (e.g. ts→typescript, shell→bash, c++→cpp). Built
// once from Shiki's own table, so it stays correct across the full ~332-language set. Unknown /
// plaintext / "" → "" (the fence renders as escaped plaintext).
const CANONICAL = new Map<string, string>();
for (const info of bundledLanguagesInfo) {
  CANONICAL.set(info.id, info.id);
  for (const alias of info.aliases || []) CANONICAL.set(alias, info.id);
}

export function normalizeLang(id: unknown): string {
  if (typeof id !== "string") return "";
  const key = id.trim().toLowerCase();
  return key ? CANONICAL.get(key) || "" : "";
}

// On-demand grammar loading. Only CORE_LANGS ship in the entry bundle; any other language's
// grammar chunk is fetched the first time it appears, after which the affected code block repaints
// (notify → bumpHighlightVersion). `loaded` = ready to tokenize; `loading` = chunk in flight.
const CORE_LANGS = ["typescript", "javascript", "json", "python", "css", "html", "bash", "markdown"];
const loaded = new Set<string>();
const loading = new Set<string>();

function ensureLanguage(canon: string): void {
  if (!highlighter || loaded.has(canon) || loading.has(canon)) return;
  const loader = bundledLanguagesBase[canon];
  if (!loader) return; // not a known grammar → stays plaintext
  loading.add(canon);
  highlighter
    .loadLanguage(loader)
    .then(() => {
      loaded.add(canon);
      loading.delete(canon);
      notify();
    })
    .catch(() => loading.delete(canon)); // load failed → leave as plaintext
}

// Build one token's <span> with an inline style. Shiki's color/fontStyle come from the loaded
// (trusted) theme; content is escaped. Inline styles are allowed by the webview CSP
// (style-src 'unsafe-inline'). bgColor is intentionally dropped so it never fights the card's
// code background or the diff add/del bands.
function tokenSpan(token: ThemedToken): string {
  const styles: string[] = [];
  if (token.color) styles.push("color:" + token.color);
  const fontStyle = token.fontStyle ?? 0;
  if (fontStyle & 1) styles.push("font-style:italic");
  if (fontStyle & 2) styles.push("font-weight:600");
  if (fontStyle & 4) styles.push("text-decoration:underline");
  const style = styles.length ? ' style="' + escapeHtml(styles.join(";")) + '"' : "";
  return "<span" + style + ">" + escapeHtml(token.content) + "</span>";
}

// Per-line highlighted HTML (one string per source line), or null when highlighting is
// unavailable (highlighter not ready, no language, or tokenization failed) — callers then fall
// back to escapeHtml. Returning lines (not one block) maps 1:1 onto the gutter row builder.
export function highlightToLines(code: string, lang: string): string[] | null {
  if (!highlighter || !lang) return null;
  const canon = CANONICAL.get(lang) || lang;
  if (!loaded.has(canon)) {
    ensureLanguage(canon); // fetch the grammar chunk; the block repaints when it's ready
    return null; // plaintext fallback until then
  }
  try {
    const { tokens } = highlighter.codeToTokens(code, { lang: canon, theme: currentTheme });
    return tokens.map((line) => line.map(tokenSpan).join(""));
  } catch {
    return null;
  }
}
