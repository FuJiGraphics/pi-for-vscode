// The composer's thinking-level (effort) control: a labeled chip ("Thinking: high") that
// opens a popover listing ALL standard levels with one-line descriptions — levels the
// current model doesn't support render disabled, which teaches the control's range even
// when unavailable. Selection passes straight through to pi's set_thinking_level (the
// host's ModelService); pi remains the authority on what each level means per model.
import { state } from "./state";
import { appEl, thinkingControlEl, thinkingListEl, thinkingPanelEl } from "./dom";
import { post } from "./bridge";
import { escapeHtml } from "./util";

export const THINKING_LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

// UI copy describing the LEVELS' semantics (not model data — no thin-wrapper violation).
const LEVEL_DESCRIPTIONS: Record<string, string> = {
  off: "No extended thinking",
  minimal: "Fastest, minimal reasoning",
  low: "Brief reasoning",
  medium: "Balanced speed and depth",
  high: "Thorough reasoning",
  xhigh: "Maximum reasoning effort",
};

/** Mirrors pi's getSupportedThinkingLevels exactly (pi-ai models.js): non-reasoning
 *  models support nothing (control hidden); a level mapped to null is excluded; and
 *  xhigh is offered ONLY when the model maps it explicitly — pi silently clamps an
 *  unmapped xhigh down, so offering it would misrepresent the model. */
export function supportedThinkingLevels(model: unknown): string[] {
  const m = model as { reasoning?: unknown; thinkingLevelMap?: unknown } | undefined;
  if (!m || m.reasoning !== true) return [];
  const map = m.thinkingLevelMap && typeof m.thinkingLevelMap === "object"
    ? (m.thinkingLevelMap as Record<string, unknown>)
    : undefined;
  return THINKING_LEVEL_ORDER.filter((level) => {
    const mapped = map?.[level];
    if (mapped === null) return false;
    if (level === "xhigh") return mapped !== undefined;
    return true;
  });
}

/** The popover body — pure for tests. Lists every standard level; unsupported ones are
 *  disabled rows so the control's full range stays discoverable. */
export function thinkingPanelHtml(levels: string[], current: string): string {
  return THINKING_LEVEL_ORDER.map((level) => {
    const supported = levels.includes(level);
    const isCurrent = level === current;
    const cls = "thinking-option" + (isCurrent ? " current" : "") + (supported ? "" : " unsupported");
    const attrs = supported
      ? ' data-action="set-thinking-level" data-level="' + escapeHtml(level) + '"'
      : ' aria-disabled="true" title="Not supported by the current model"';
    return (
      '<div class="' + cls + '" role="menuitemradio" aria-checked="' + isCurrent + '"' + attrs + ">" +
      '<span class="thinking-option-name">' + escapeHtml(level) + "</span>" +
      '<span class="thinking-option-desc">' + escapeHtml(LEVEL_DESCRIPTIONS[level] || "") + "</span>" +
      "</div>"
    );
  }).join("");
}

const CHIP_ICON =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.8l1.2 3.4 3.4 1.2-3.4 1.2L8 11l-1.2-3.4L3.4 6.4l3.4-1.2z"/><circle cx="12.8" cy="12.8" r="1.6"/></svg>';

/** Called from render(): keeps the chip's label/color in sync with the session state. */
export function renderThinkingControl(): void {
  const levels = state.thinkingLevels;
  if (levels.length <= 1) {
    thinkingControlEl.hidden = true;
    thinkingControlEl.innerHTML = "";
    thinkingControlEl.removeAttribute("data-current-level");
    thinkingControlEl.removeAttribute("title");
    closeThinkingPanel();
    return;
  }
  const current = levels.includes(state.thinkingLevel) ? state.thinkingLevel : levels[0];
  thinkingControlEl.hidden = false;
  thinkingControlEl.dataset.currentLevel = current;
  thinkingControlEl.title = "Thinking level: " + current + " - click to change";
  thinkingControlEl.setAttribute("aria-label", "Thinking level: " + current);
  thinkingControlEl.innerHTML =
    CHIP_ICON + '<span class="thinking-label">Thinking: ' + escapeHtml(current) + '</span><span class="chip-caret">⌄</span>';
  if (isThinkingPanelOpen()) thinkingListEl.innerHTML = thinkingPanelHtml(levels, current);
}

export function isThinkingPanelOpen(): boolean {
  return appEl.classList.contains("thinking-open");
}

export function openThinkingPanel(): void {
  appEl.classList.remove("history-open", "model-open", "command-open", "settings-open", "usage-open");
  appEl.classList.add("thinking-open");
  const levels = state.thinkingLevels;
  const current = levels.includes(state.thinkingLevel) ? state.thinkingLevel : levels[0] || "off";
  thinkingListEl.innerHTML = thinkingPanelHtml(levels, current);
}

export function closeThinkingPanel(): void {
  appEl.classList.remove("thinking-open");
}

function handleListClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  const option = target && target.closest ? (target.closest('[data-action="set-thinking-level"]') as HTMLElement | null) : null;
  const level = option?.dataset.level;
  if (!level) return;
  post({ type: "setThinkingLevel", level });
  closeThinkingPanel();
}

function handleOutsideClick(event: MouseEvent): void {
  if (!isThinkingPanelOpen()) return;
  const target = event.target as Node | null;
  if (!target) return;
  if (thinkingPanelEl.contains(target) || thinkingControlEl.contains(target)) return;
  closeThinkingPanel();
}

export function initThinkingControl(): void {
  thinkingControlEl.addEventListener("click", () => {
    if (isThinkingPanelOpen()) closeThinkingPanel();
    else openThinkingPanel();
  });
  thinkingListEl.addEventListener("click", handleListClick);
  document.addEventListener("click", handleOutsideClick);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isThinkingPanelOpen()) closeThinkingPanel();
  });
}
