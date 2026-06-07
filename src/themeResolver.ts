// Resolves the user's active VS Code color theme so the webview's Shiki highlighter can match
// the editor. There is no public API for a theme's syntax token colors, so we locate the theme
// file contributed by an installed extension and read its tokenColors. This is best-effort: on
// any failure the webview falls back to a bundled theme chosen by `kind`. Host-only — uses vscode
// + fs, never Shiki (the tsc-only host ships no node_modules).
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

export type ThemeKind = "light" | "dark" | "highContrast" | "highContrastLight";

export interface ResolvedTheme {
  /** Raw VS Code theme JSON (name/type/colors/tokenColors) when resolvable; else undefined. */
  theme?: unknown;
  kind: ThemeKind;
}

export function activeThemeKind(): ThemeKind {
  switch (vscode.window.activeColorTheme.kind) {
    case vscode.ColorThemeKind.Light:
      return "light";
    case vscode.ColorThemeKind.HighContrast:
      return "highContrast";
    case vscode.ColorThemeKind.HighContrastLight:
      return "highContrastLight";
    default:
      return "dark";
  }
}

export function resolveActiveTheme(): ResolvedTheme {
  const kind = activeThemeKind();
  try {
    const label = vscode.workspace.getConfiguration("workbench").get<string>("colorTheme");
    if (!label) return { kind };
    const file = findThemeFile(label);
    if (!file) return { kind };
    return { theme: loadThemeFile(file, 0), kind };
  } catch {
    return { kind };
  }
}

// Find the on-disk theme file for a theme label/id among installed extensions' contributions.
function findThemeFile(label: string): string | undefined {
  for (const ext of vscode.extensions.all) {
    const themes = ext.packageJSON?.contributes?.themes;
    if (!Array.isArray(themes)) continue;
    for (const theme of themes) {
      if ((theme?.label === label || theme?.id === label) && typeof theme?.path === "string") {
        return path.join(ext.extensionPath, theme.path);
      }
    }
  }
  return undefined;
}

// Read a theme JSON, following at most one `include`. Returns undefined for tmTheme/string
// tokenColors (not a JSON theme Shiki can consume directly).
function loadThemeFile(file: string, depth: number): unknown {
  const parsed = parseJsonc(fs.readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object") return undefined;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.tokenColors === "string") return undefined;
  const include = obj.include;
  if (typeof include === "string" && depth < 1) {
    const base = loadThemeFile(path.join(path.dirname(file), include), depth + 1);
    if (base && typeof base === "object") return mergeTheme(base as Record<string, unknown>, obj);
  }
  return obj;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function mergeTheme(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  return {
    ...base,
    ...over,
    colors: { ...(base.colors as object), ...(over.colors as object) },
    tokenColors: [...asArray(base.tokenColors), ...asArray(over.tokenColors)],
    semanticTokenColors: { ...(base.semanticTokenColors as object), ...(over.semanticTokenColors as object) },
  };
}

function parseJsonc(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Fall through to the comment/trailing-comma strip.
  }
  try {
    return JSON.parse(stripJsonc(text));
  } catch {
    return undefined;
  }
}

// String-aware JSONC → JSON: drop // and /* */ comments only OUTSIDE string literals (so `//`
// or commas inside scope/color strings survive), then remove trailing commas.
function stripJsonc(text: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === "*" && n === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === "/" && n === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (c === "/" && n === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}
