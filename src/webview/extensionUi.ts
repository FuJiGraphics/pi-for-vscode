import { post } from "./bridge";
import { addMessage, recordActivity } from "./conversation";
import { extensionUiRootEl, inputEl } from "./dom";
import { autoResizeInput, updateInputState } from "./input";
import { escapeHtml } from "./util";

type UiRequest = Record<string, any>;

interface DialogState {
  request: UiRequest;
  method: string;
}

interface SelectOption {
  label: string;
  value: unknown;
}

const statusEntries = new Map<string, string>();
const widgetEntries = new Map<string, string[]>();
const openedUrls = new Set<string>();
let activeDialog: DialogState | undefined;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function firstUrl(value: unknown): string | undefined {
  const match = text(value).match(/https?:\/\/[^\s<>"')]+/i);
  return match?.[0];
}

function openUrlOnce(url: string | undefined): void {
  if (!url || openedUrls.has(url)) return;
  openedUrls.add(url);
  post({ type: "openExternal", url });
}

function requestTitle(request: UiRequest, fallback: string): string {
  return text(request.title) || fallback;
}

function isSecretRequest(request: UiRequest): boolean {
  const haystack = [request.title, request.placeholder, request.message].map(text).join(" ").toLowerCase();
  return /api key|secret|token|password/.test(haystack);
}

function responseBase(request: UiRequest): Record<string, unknown> {
  return { type: "extension_ui_response", id: request.id };
}

function sendResponse(request: UiRequest, payload: Record<string, unknown>): void {
  post({ type: "extensionUiResponse", response: { ...responseBase(request), ...payload } });
  activeDialog = undefined;
  renderExtensionUi();
}

function optionLabel(option: unknown): string {
  if (typeof option === "string") return option;
  if (option && typeof option === "object") {
    const record = option as Record<string, unknown>;
    for (const key of ["label", "name", "value", "id"]) {
      if (typeof record[key] === "string" && record[key]) return record[key];
    }
  }
  return String(option ?? "");
}

function selectOptions(request: UiRequest): SelectOption[] {
  const raw = Array.isArray(request.options) ? request.options : [];
  return raw.map((option) => ({ label: optionLabel(option), value: typeof option === "string" ? option : optionLabel(option) }));
}

function dialogHtml(dialog: DialogState): string {
  const { request, method } = dialog;
  const title = requestTitle(request, method === "confirm" ? "Confirm" : method === "select" ? "Select" : "Input");
  const message = text(request.message);

  if (method === "select") {
    const options = selectOptions(request);
    return (
      '<div class="extension-ui-overlay" role="presentation">' +
      '<section class="extension-ui-panel" role="dialog" aria-modal="true">' +
      '<div class="extension-ui-head"><div class="extension-ui-title">' + escapeHtml(title) + "</div>" +
      '<button class="extension-ui-close" data-ext-ui="cancel" aria-label="Cancel">x</button></div>' +
      (message ? '<div class="extension-ui-message">' + escapeHtml(message) + "</div>" : "") +
      '<div class="extension-ui-options">' +
      options.map((option, index) => '<button class="extension-ui-option" data-ext-ui="select-option" data-index="' + index + '">' + escapeHtml(option.label) + "</button>").join("") +
      "</div></section></div>"
    );
  }

  if (method === "confirm") {
    return (
      '<div class="extension-ui-overlay" role="presentation">' +
      '<section class="extension-ui-panel" role="dialog" aria-modal="true">' +
      '<div class="extension-ui-head"><div class="extension-ui-title">' + escapeHtml(title) + "</div>" +
      '<button class="extension-ui-close" data-ext-ui="cancel" aria-label="Cancel">x</button></div>' +
      (message ? '<div class="extension-ui-message">' + escapeHtml(message) + "</div>" : "") +
      '<div class="extension-ui-actions">' +
      '<button class="extension-ui-secondary" data-ext-ui="confirm-no">No</button>' +
      '<button class="extension-ui-primary" data-ext-ui="confirm-yes">Yes</button>' +
      "</div></section></div>"
    );
  }

  const isEditor = method === "editor";
  const initial = text(isEditor ? request.prefill : request.value);
  const placeholder = text(request.placeholder);
  const input = isEditor
    ? '<textarea class="extension-ui-field extension-ui-textarea" data-ext-ui-field="value" placeholder="' + escapeHtml(placeholder) + '">' + escapeHtml(initial) + "</textarea>"
    : '<input class="extension-ui-field" data-ext-ui-field="value" type="' + (isSecretRequest(request) ? "password" : "text") + '" value="' + escapeHtml(initial) + '" placeholder="' + escapeHtml(placeholder) + '" />';
  return (
    '<div class="extension-ui-overlay" role="presentation">' +
    '<section class="extension-ui-panel" role="dialog" aria-modal="true">' +
    '<div class="extension-ui-head"><div class="extension-ui-title">' + escapeHtml(title) + "</div>" +
    '<button class="extension-ui-close" data-ext-ui="cancel" aria-label="Cancel">x</button></div>' +
    (message ? '<div class="extension-ui-message">' + escapeHtml(message) + "</div>" : "") +
    '<form class="extension-ui-form" data-ext-ui-form="input">' +
    input +
    '<div class="extension-ui-actions">' +
    '<button type="button" class="extension-ui-secondary" data-ext-ui="cancel">Cancel</button>' +
    '<button type="submit" class="extension-ui-primary">Submit</button>' +
    "</div></form></section></div>"
  );
}

function statusHtml(): string {
  const statuses = [...statusEntries.entries()].filter(([, value]) => value);
  const widgets = [...widgetEntries.entries()].filter(([, lines]) => lines.length > 0);
  if (statuses.length === 0 && widgets.length === 0) return "";

  const statusRows = statuses.map(([, value]) => '<div class="extension-ui-status-line">' + escapeHtml(value) + "</div>").join("");
  const widgetRows = widgets.map(([key, lines]) => {
    const body = lines.map((line) => '<div class="extension-ui-widget-line">' + escapeHtml(line) + "</div>").join("");
    const url = firstUrl(lines.join("\n"));
    const button = url ? '<button class="extension-ui-link" data-ext-url="' + escapeHtml(url) + '">Open URL</button>' : "";
    if (key === "vscode-auth-bridge") openUrlOnce(url);
    return '<section class="extension-ui-widget">' + body + button + "</section>";
  }).join("");
  return '<div class="extension-ui-stack">' + statusRows + widgetRows + "</div>";
}

function attachDialogHandlers(): void {
  const dialog = activeDialog;
  if (!dialog) return;
  const { request, method } = dialog;

  const cancel = () => sendResponse(request, { cancelled: true });
  extensionUiRootEl.querySelectorAll<HTMLElement>('[data-ext-ui="cancel"]').forEach((el) => {
    el.addEventListener("click", cancel);
  });

  if (method === "select") {
    const options = selectOptions(request);
    extensionUiRootEl.querySelectorAll<HTMLElement>('[data-ext-ui="select-option"]').forEach((el) => {
      el.addEventListener("click", () => {
        const index = Number(el.dataset.index);
        const option = Number.isInteger(index) ? options[index] : undefined;
        if (option) sendResponse(request, { value: option.value });
      });
    });
    extensionUiRootEl.querySelector<HTMLElement>('[data-ext-ui="select-option"]')?.focus();
    return;
  }

  if (method === "confirm") {
    extensionUiRootEl.querySelector<HTMLElement>('[data-ext-ui="confirm-no"]')?.addEventListener("click", () => sendResponse(request, { confirmed: false }));
    extensionUiRootEl.querySelector<HTMLElement>('[data-ext-ui="confirm-yes"]')?.addEventListener("click", () => sendResponse(request, { confirmed: true }));
    extensionUiRootEl.querySelector<HTMLElement>('[data-ext-ui="confirm-yes"]')?.focus();
    return;
  }

  const form = extensionUiRootEl.querySelector<HTMLFormElement>('[data-ext-ui-form="input"]');
  const field = extensionUiRootEl.querySelector<HTMLInputElement | HTMLTextAreaElement>("[data-ext-ui-field]");
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    sendResponse(request, { value: field?.value ?? "" });
  });
  field?.focus();
}

function attachChromeHandlers(): void {
  extensionUiRootEl.querySelectorAll<HTMLElement>("[data-ext-url]").forEach((el) => {
    el.addEventListener("click", () => {
      const url = el.dataset.extUrl;
      if (url) post({ type: "openExternal", url });
    });
  });
}

function renderExtensionUi(): void {
  extensionUiRootEl.innerHTML = statusHtml() + (activeDialog ? dialogHtml(activeDialog) : "");
  attachChromeHandlers();
  attachDialogHandlers();
}

export function handleExtensionUiRequest(request: UiRequest): void {
  const method = text(request.method);
  if (method === "notify") {
    const message = text(request.message) || "Notification";
    openUrlOnce(firstUrl(message));
    addMessage("system", message, { error: request.notifyType === "error", pre: message.length > 240 });
    return;
  }
  if (method === "setStatus") {
    const key = text(request.statusKey) || "status";
    const statusText = text(request.statusText);
    if (statusText) statusEntries.set(key, statusText);
    else statusEntries.delete(key);
    renderExtensionUi();
    return;
  }
  if (method === "setWidget") {
    const key = text(request.widgetKey) || "widget";
    const lines = Array.isArray(request.widgetLines) ? request.widgetLines.map(text).filter(Boolean) : [];
    if (lines.length > 0) {
      widgetEntries.set(key, lines);
      if (key !== "vscode-auth-bridge") recordActivity("widget-" + key, "Status", lines.join("\n"), "running");
    } else {
      widgetEntries.delete(key);
    }
    renderExtensionUi();
    return;
  }
  if (method === "setTitle") return;
  if (method === "set_editor_text") {
    inputEl.value = text(request.text);
    autoResizeInput();
    updateInputState();
    inputEl.focus();
    return;
  }
  if (method === "select" || method === "input" || method === "editor" || method === "confirm") {
    activeDialog = { request, method };
    renderExtensionUi();
    return;
  }

  if (request.id) sendResponse(request, { cancelled: true });
}
