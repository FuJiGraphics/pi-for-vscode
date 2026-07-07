// Claude / VS Code-style model picker: a floating dropdown anchored to the
// #model button. Lists Pi's available models from `get_available_models`, lets
// Pi switch model through `set_model`, and opens Pi-owned auth commands.
import { appEl, modelEl, modelListEl, modelPanelEl, modelSearchEl } from "./dom";
import { post } from "./bridge";
import { openAuthModal } from "./onboarding";
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
  appEl.classList.remove("settings-open");
  appEl.classList.add("model-open");
  modelSearchEl.value = "";
  if (allModels.length > 0) {
    applyFilter();
    // Long roster: land the viewport on the model in use, not the top of the catalog.
    modelListEl.querySelector(".model-item.current")?.scrollIntoView({ block: "center" });
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

// "$3" / "$0.33" — max 2 decimals, trailing zeros trimmed.
function formatPrice(perMtok: number): string {
  return "$" + perMtok.toFixed(2).replace(/\.?0+$/, "");
}

/** Compact price label, "$3/15" (input/output per Mtok — the unit lives in the tooltip,
 *  the row keeps only the numbers). Free or unreported pricing → "" (never shown as $0). */
export function priceLabel(cost: ModelCost | undefined): string {
  if (!cost || (cost.input <= 0 && cost.output <= 0)) return "";
  return formatPrice(cost.input) + "/" + formatPrice(cost.output).slice(1);
}

/** The row's right-aligned data column: "$3/15 · 200k" (price · context window). */
export function metaLabel(model: ModelListItem): string {
  const parts: string[] = [];
  const price = priceLabel(model.cost);
  if (price) parts.push(price);
  if (model.contextWindow) parts.push(formatTokens(model.contextWindow));
  return parts.join(" · ");
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

// One dense row per model: name (accent when current) · thinking glyph · right-aligned
// mono data "$3/15 · 200k". The full detail (cache rates, max output, unit) stays in the
// title tooltip; capability chips are gone — vision is near-universal (noise), thinking
// earns a 4px glyph. Provider identity comes from the group header, not per-row text.
export function itemHtml(model: ModelListItem): string {
  const tooltip = itemTooltip(model);
  const meta = metaLabel(model);
  return (
    '<button class="model-item' +
    (model.isCurrent ? " current" : "") +
    '" data-provider="' +
    escapeHtml(model.provider) +
    '" data-model-id="' +
    escapeHtml(model.modelId) +
    '"' +
    (tooltip ? ' title="' + escapeHtml(tooltip) + '"' : "") +
    '><span class="model-name">' +
    escapeHtml(model.model) +
    "</span>" +
    (model.thinking ? '<span class="model-think" title="Supports extended thinking"></span>' : "") +
    (meta ? '<span class="model-data">' + escapeHtml(meta) + "</span>" : "") +
    "</button>"
  );
}

/** Provider group header rows + item rows, preserving pi's catalog order. */
export function groupedListHtml(models: ModelListItem[]): string {
  let html = "";
  let lastProvider: string | undefined;
  for (const model of models) {
    if (model.provider !== lastProvider) {
      lastProvider = model.provider;
      html += '<div class="model-group-head">' + escapeHtml(model.provider) + "</div>";
    }
    html += itemHtml(model);
  }
  return html;
}

// Register-a-provider row (muted, below the roster). Opens the compact auth modal.
function addProviderHtml(): string {
  return (
    '<button class="model-item model-add" data-add-provider>' +
    '<span class="model-name">+ Add provider</span>' +
    '<span class="model-data">OAuth · API key · local</span></button>'
  );
}

function applyFilter(): void {
  const query = modelSearchEl.value.trim().toLowerCase();
  const filtered = query
    ? allModels.filter((m) => (m.model + " " + m.provider + " " + m.modelId + " " + m.id).toLowerCase().includes(query))
    : allModels;
  if (filtered.length === 0) {
    // A search miss just reports it; an empty roster (no query) still offers the add row.
    modelListEl.innerHTML = query ? '<div class="model-empty">No models match your search.</div>' : addProviderHtml();
    return;
  }
  modelListEl.innerHTML = groupedListHtml(filtered) + addProviderHtml();
}

export function renderModelList(models: ModelListItem[]): void {
  allModels = Array.isArray(models) ? models : [];
  if (isModelPickerOpen()) applyFilter();
}

function handleListClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  if (target && target.closest && target.closest("[data-add-provider]")) {
    closeModelPicker();
    openAuthModal();
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
