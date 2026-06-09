// Claude / VS Code-style model picker: a floating dropdown anchored to the
// #model button. Lists Pi's available models from `get_available_models`, lets
// Pi switch model through `set_model`, and opens Pi-owned auth commands.
import { appEl, modelEl, modelListEl, modelPanelEl, modelSearchEl } from "./dom";
import { post } from "./bridge";
import { escapeHtml } from "./util";
import type { ModelListItem } from "../protocol";

let allModels: ModelListItem[] = [];

export function isModelPickerOpen(): boolean {
  return appEl.classList.contains("model-open");
}

export function openModelPicker(): void {
  appEl.classList.remove("history-open");
  appEl.classList.remove("command-open");
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

const AUTH_ACTIONS_HTML =
  '<button class="model-item model-add" data-action="login"><div class="model-main">' +
  '<div class="model-title">Sign in or add provider key</div>' +
  '<div class="model-meta">Uses Pi authentication</div></div></button>' +
  '<button class="model-item model-add secondary" data-action="logout"><div class="model-main">' +
  '<div class="model-title">Sign out provider</div>' +
  '<div class="model-meta">Removes credentials from Pi</div></div></button>';

function itemHtml(model: ModelListItem): string {
  return (
    '<button class="model-item' +
    (model.isCurrent ? " current" : "") +
    '" data-provider="' +
    escapeHtml(model.provider) +
    '" data-model-id="' +
    escapeHtml(model.modelId) +
    '"><div class="model-main"><div class="model-title">' +
    escapeHtml(model.model) +
    (model.isCurrent ? '<span class="current-tag"> Current</span>' : "") +
    '</div><div class="model-meta">' +
    escapeHtml(model.provider) +
    (model.thinking ? '<span class="model-cap">thinking</span>' : "") +
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
      AUTH_ACTIONS_HTML;
    return;
  }
  modelListEl.innerHTML = filtered.map(itemHtml).join("") + AUTH_ACTIONS_HTML;
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
