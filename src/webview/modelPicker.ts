// Claude / VS Code-style model picker: a floating dropdown anchored to the
// #model button. Lists Pi's available models from `get_available_models`, lets
// Pi switch model through `set_model`, and opens Pi-owned auth commands.
import { appEl, modelEl, modelListEl, modelPanelEl, modelSearchEl } from "./dom";
import { post } from "./bridge";
import { escapeHtml, formatTokens } from "./util";
import type { ModelCost, ModelListItem } from "../protocol";

let allModels: ModelListItem[] = [];

export function isModelPickerOpen(): boolean {
  return appEl.classList.contains("model-open");
}

export function openModelPicker(): void {
  appEl.classList.remove("history-open");
  appEl.classList.remove("command-open");
  appEl.classList.remove("thinking-open");
  appEl.classList.add("model-open");
  modelSearchEl.value = "";
  if (allModels.length > 0) {
    applyFilter();
  } else {
    modelListEl.innerHTML = '<div class="model-empty">Loading models...</div>';
    post({ type: "requestModels" });
  }
  modelSearchEl.focus();
}

export function closeModelPicker(): void {
  appEl.classList.remove("model-open");
}

export function toggleModelPicker(): void {
  if (isModelPickerOpen()) closeModelPicker();
  else openModelPicker();
}

// Whether the pi runtime has the auth bridge's /login command (from commandList).
// Optimistic default: until told otherwise, offer the buttons — the bridge's own
// fallback notice is the second line of defense if they race ahead of the signal.
let authAvailable = true;

export function setAuthAvailable(value: boolean | undefined): void {
  const next = value !== false;
  if (next === authAvailable) return;
  authAvailable = next;
  if (isModelPickerOpen()) applyFilter();
}

const AUTH_ACTIONS_HTML =
  '<button class="model-item model-add" data-action="login"><div class="model-main">' +
  '<div class="model-title">Sign in or add provider key</div>' +
  '<div class="model-meta">Uses Pi authentication</div></div></button>' +
  '<button class="model-item model-add secondary" data-action="logout"><div class="model-main">' +
  '<div class="model-title">Sign out provider</div>' +
  '<div class="model-meta">Removes credentials from Pi</div></div></button>';

// Shown when the auth bridge did not load in this pi runtime: point at pi's own flow
// instead of rendering buttons that can only dead-end.
const AUTH_FALLBACK_HTML =
  '<div class="model-empty">Sign-in is unavailable in this Pi runtime - run <code>pi</code> in a terminal and use <code>/login</code>.</div>';

function authActionsHtml(): string {
  return authAvailable ? AUTH_ACTIONS_HTML : AUTH_FALLBACK_HTML;
}

// "$3" / "$0.33" — max 2 decimals, trailing zeros trimmed.
function formatPrice(perMtok: number): string {
  return "$" + perMtok.toFixed(2).replace(/\.?0+$/, "");
}

/** Compact price chip, "$3/$15 Mtok" (input/output per million tokens). Free or
 *  unreported pricing → "" (the chip is omitted, never shown as $0). */
export function priceLabel(cost: ModelCost | undefined): string {
  if (!cost || (cost.input <= 0 && cost.output <= 0)) return "";
  return formatPrice(cost.input) + "/" + formatPrice(cost.output) + " Mtok";
}

/** Multi-line title tooltip: full pricing (cache rates included) + context/output limits. */
export function itemTooltip(model: ModelListItem): string {
  const lines: string[] = [];
  const cost = model.cost;
  if (cost && (cost.input > 0 || cost.output > 0)) {
    lines.push("Input " + formatPrice(cost.input) + " / Output " + formatPrice(cost.output) + " per Mtok");
    if (cost.cacheRead || cost.cacheWrite) {
      lines.push("Cache read " + formatPrice(cost.cacheRead ?? 0) + " / write " + formatPrice(cost.cacheWrite ?? 0) + " per Mtok");
    }
  }
  const limits: string[] = [];
  if (model.contextWindow) limits.push("Context " + formatTokens(model.contextWindow));
  if (model.maxTokens) limits.push("Max output " + formatTokens(model.maxTokens));
  if (limits.length) lines.push(limits.join(" · "));
  return lines.join("\n");
}

export function itemHtml(model: ModelListItem): string {
  const price = priceLabel(model.cost);
  const tooltip = itemTooltip(model);
  return (
    '<button class="model-item' +
    (model.isCurrent ? " current" : "") +
    '" data-provider="' +
    escapeHtml(model.provider) +
    '" data-model-id="' +
    escapeHtml(model.modelId) +
    '"' +
    (tooltip ? ' title="' + escapeHtml(tooltip) + '"' : "") +
    '><div class="model-main"><div class="model-title">' +
    escapeHtml(model.model) +
    (model.isCurrent ? '<span class="current-tag"> Current</span>' : "") +
    '</div><div class="model-meta">' +
    escapeHtml(model.provider) +
    (model.thinking ? '<span class="model-cap">thinking</span>' : "") +
    (model.vision ? '<span class="model-cap">vision</span>' : "") +
    (price ? '<span class="model-price">' + escapeHtml(price) + "</span>" : "") +
    (model.contextWindow ? '<span class="model-ctx">' + escapeHtml(formatTokens(model.contextWindow)) + " ctx</span>" : "") +
    "</div></div></button>"
  );
}

function applyFilter(): void {
  const query = modelSearchEl.value.trim().toLowerCase();
  const filtered = query
    ? allModels.filter((m) => (m.model + " " + m.provider + " " + m.modelId + " " + m.id).toLowerCase().includes(query))
    : allModels;
  if (filtered.length === 0) {
    modelListEl.innerHTML =
      '<div class="model-empty">' +
      (allModels.length === 0 ? "No models available. Sign in or add a provider key below." : "No models match your search.") +
      "</div>" +
      authActionsHtml();
    return;
  }
  modelListEl.innerHTML = filtered.map(itemHtml).join("") + authActionsHtml();
}

export function renderModelList(models: ModelListItem[]): void {
  allModels = Array.isArray(models) ? models : [];
  if (isModelPickerOpen()) applyFilter();
}

function handleListClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  const actionBtn = target && target.closest ? (target.closest("[data-action]") as HTMLElement | null) : null;
  const action = actionBtn?.dataset.action;
  if (action === "login" || action === "logout") {
    event.stopPropagation();
    post({ type: action });
    closeModelPicker();
    return;
  }

  const item = target && target.closest ? (target.closest(".model-item") as HTMLElement | null) : null;
  if (!item) return;
  const provider = item.dataset.provider;
  const modelId = item.dataset.modelId;
  if (!provider || !modelId) return;
  allModels = allModels.map((m) => ({ ...m, isCurrent: m.provider === provider && m.modelId === modelId }));
  post({ type: "setModel", provider, modelId });
  closeModelPicker();
}

function handleOutsideClick(event: MouseEvent): void {
  if (!isModelPickerOpen()) return;
  const target = event.target as Node | null;
  if (!target) return;
  if (modelPanelEl.contains(target) || modelEl.contains(target)) return;
  closeModelPicker();
}

export function initModelPicker(): void {
  modelListEl.addEventListener("click", handleListClick);
  modelSearchEl.addEventListener("input", applyFilter);
  modelSearchEl.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeModelPicker();
    }
  });
  document.addEventListener("click", handleOutsideClick);
}
