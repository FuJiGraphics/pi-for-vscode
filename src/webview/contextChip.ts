// The composer's editor-context chip: shows the active file (and selected line range)
// that the host mirrors via `editorContext` messages, Claude-Code-style — in the
// composer actions row right of the attach button, behind a vertical divider. Clicking
// the chip toggles whether the reference is appended to outgoing prompts (default OFF,
// sticky once on — the lit state shows exactly what the next prompt will carry). Only a
// path:line reference is ever sent; reading the file stays with pi's read tool.
import { actionDividerEl, contextChipEl } from "./dom";
import { escapeHtml } from "./util";

const FILE_ICON =
  '<svg class="context-chip-icon" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 1.8H4.6a1 1 0 0 0-1 1v10.4a1 1 0 0 0 1 1h6.8a1 1 0 0 0 1-1V4.7z"/><path d="M9.4 1.9v2.9h3"/></svg>';

export interface EditorContext {
  path?: string;
  startLine?: number;
  endLine?: number;
}

let current: EditorContext = {};
let include = false;

/** "src/main.ts", "src/main.ts:12", or "src/main.ts:12-34" — also the chip's label. */
export function formatContextLabel(context: EditorContext): string {
  if (!context.path) return "";
  const { startLine, endLine } = context;
  if (!startLine || !endLine) return context.path;
  return context.path + ":" + (startLine === endLine ? startLine : startLine + "-" + endLine);
}

/** The reference to append to the next prompt, or "" when off / no editor context. */
export function contextReference(): string {
  return include ? formatContextLabel(current) : "";
}

export function updateEditorContext(context: EditorContext): void {
  current = context || {};
  renderChip();
}

export function toggleContextInclude(): void {
  include = !include;
  renderChip();
}

/** Switching to a DIFFERENT session detaches the reference: the toggle was a decision
 *  made for the previous conversation and must not silently follow into this one.
 *  (The editor context itself is global — the chip stays visible, just unlit.) */
export function resetContextInclude(): void {
  if (!include) return;
  include = false;
  renderChip();
}

function renderChip(): void {
  const label = formatContextLabel(current);
  if (!label) {
    contextChipEl.hidden = true;
    actionDividerEl.hidden = true;
    return;
  }
  contextChipEl.hidden = false;
  actionDividerEl.hidden = false;
  contextChipEl.classList.toggle("on", include);
  contextChipEl.title = include
    ? "Attached to your next prompt - click to detach"
    : "Click to attach this file reference to your next prompt";
  contextChipEl.innerHTML = FILE_ICON + '<span class="context-chip-label">' + escapeHtml(label) + "</span>";
}

export function initContextChip(): void {
  contextChipEl.addEventListener("click", toggleContextInclude);
}
