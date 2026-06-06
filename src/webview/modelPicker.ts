// Claude / VS Code-style model picker: a floating dropdown anchored to the
// #model button. Lists pi's available models (from `pi --list-models`), lets you
// switch model (pi restarts + the session is restored), and add a BYOK provider
// API key. Mirrors the history popover pattern in history.ts.
import { appEl, modelEl, modelListEl, modelPanelEl, modelSearchEl } from "./dom";
import { post } from "./bridge";
import { escapeHtml } from "./util";
import type { ModelListItem } from "../protocol";

let allModels: ModelListItem[] = [];

export function isModelPickerOpen(): boolean {
  return appEl.classList.contains("model-open");
}

export function openModelPicker(): void {
  appEl.classList.remove("history-open"); // mutually exclusive with the history popover
  appEl.classList.remove("command-open"); // and with the slash-command palette
  appEl.classList.add("model-open");
  modelSearchEl.value = "";
  modelListEl.innerHTML = '<div class="model-empty">Loading models…</div>';
  post({ type: "requestModels" });
  modelSearchEl.focus();
}

export function closeModelPicker(): void {
  appEl.classList.remove("model-open");
}

export function toggleModelPicker(): void {
  if (isModelPickerOpen()) closeModelPicker();
  else openModelPicker();
}

const ADD_KEY_HTML =
  '<button class="model-item model-add" data-action="add-key"><div class="model-main">' +
  '<div class="model-title">＋ Add provider API key…</div>' +
  '<div class="model-meta">Bring your own key (OpenAI, Anthropic, Google…)</div></div></button>';

function itemHtml(model: ModelListItem): string {
  return (
    '<button class="model-item' +
    (model.isCurrent ? " current" : "") +
    '" data-id="' +
    escapeHtml(model.id) +
    '"><div class="model-main"><div class="model-title">' +
    escapeHtml(model.model) +
    (model.isCurrent ? '<span class="current-tag"> ✓</span>' : "") +
    '</div><div class="model-meta">' +
    escapeHtml(model.provider) +
    (model.thinking ? " · thinking" : "") +
    "</div></div></button>"
  );
}

function applyFilter(): void {
  const query = modelSearchEl.value.trim().toLowerCase();
  const filtered = query
    ? allModels.filter((m) => (m.model + " " + m.provider + " " + m.id).toLowerCase().includes(query))
    : allModels;
  if (filtered.length === 0) {
    modelListEl.innerHTML =
      '<div class="model-empty">' +
      (allModels.length === 0 ? "No models available. Add a provider key below." : "No models match your search.") +
      "</div>" +
      ADD_KEY_HTML;
    return;
  }
  modelListEl.innerHTML = filtered.map(itemHtml).join("") + ADD_KEY_HTML;
}

export function renderModelList(models: ModelListItem[]): void {
  allModels = Array.isArray(models) ? models : [];
  if (isModelPickerOpen()) applyFilter();
}

function handleListClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  const addBtn = target && target.closest ? (target.closest('[data-action="add-key"]') as HTMLElement | null) : null;
  if (addBtn) {
    event.stopPropagation();
    post({ type: "addProviderKey" });
    closeModelPicker();
    return;
  }
  const item = target && target.closest ? (target.closest(".model-item") as HTMLElement | null) : null;
  if (!item) return;
  const id = item.dataset.id;
  if (!id) return;
  post({ type: "setModel", modelId: id });
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
