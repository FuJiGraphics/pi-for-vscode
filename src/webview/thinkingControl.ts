// The composer's thinking-level (effort) control: an icon-only chip that opens a
// popover listing ALL standard levels with one-line descriptions — levels the current
// model doesn't support render disabled, which teaches the control's range even when
// unavailable. Selection passes straight through to pi's set_thinking_level (the
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
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.2 13.3c-1.8 0-3.2-1.1-3.2-2.6 0-.7.3-1.3.8-1.8A2.7 2.7 0 0 1 3.4 7.5c0-1.4 1-2.5 2.3-2.7A2.7 2.7 0 0 1 8 3.4a2.7 2.7 0 0 1 2.3 1.4c1.3.2 2.3 1.3 2.3 2.7 0 .5-.1 1-.4 1.4.5.5.8 1.1.8 1.8 0 1.5-1.4 2.6-3.2 2.6"/><path d="M6.2 13.3V5.5"/><path d="M9.8 13.3V5.5"/><path d="M6.2 7.2H4.9"/><path d="M9.8 7.2h1.3"/><path d="M6.2 9.6H4.8"/><path d="M9.8 9.6h1.4"/></svg>';

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
  thinkingControlEl.innerHTML = CHIP_ICON;
  if (isThinkingPanelOpen()) thinkingListEl.innerHTML = thinkingPanelHtml(levels, current);
}

export function isThinkingPanelOpen(): boolean {
  return appEl.classList.contains("thinking-open");
}

export function openThinkingPanel(): void {
  appEl.classList.remove("history-open", "model-open", "command-open", "settings-open");
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
