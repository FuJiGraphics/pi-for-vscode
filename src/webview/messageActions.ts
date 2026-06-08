// Click dispatch for the messages list: timeline toggles, per-message copy/edit, UI confirm/cancel,
// image preview, clickable file references, and the code-block Copy/Insert/Apply buttons. Extracted
// from main.ts (one responsibility: message-action handling) so the entry stays lean and new
// actions have a home.
import { getMessage, toggleActivityStep, findStep } from "./conversation";
import { scheduleRender } from "./render";
import { showCardOverlay } from "./cardOverlay";
import { showImagePreview } from "./attachments";
import { post } from "./bridge";
import { inputEl } from "./dom";
import { autoResizeInput, updateInputState } from "./input";

// The raw source of a code block — textContent concatenates the Shiki token spans (or the escaped
// plaintext fallback), giving back the original code without the highlight markup.
function codeBlockText(el: HTMLElement): string {
  const code = el.closest(".md-code-block")?.querySelector("code");
  return code ? code.textContent || "" : "";
}

function flashButton(el: HTMLElement, label: string): void {
  const original = el.textContent || "";
  el.classList.add("copied");
  el.textContent = label;
  setTimeout(() => {
    el.classList.remove("copied");
    el.textContent = original;
  }, 1200);
}

export function handleMessageClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  const actionEl = target && target.closest ? (target.closest("[data-action]") as HTMLElement | null) : null;
  if (!actionEl) return;
  const action = actionEl.dataset.action;

  if (action === "open-file") {
    post({
      type: "openFile",
      path: actionEl.dataset.path || "",
      line: Number(actionEl.dataset.line) || undefined,
      col: Number(actionEl.dataset.col) || undefined,
    });
    return;
  }
  if (action === "copy-code" || action === "insert-code" || action === "apply-code") {
    const text = codeBlockText(actionEl);
    if (!text) return;
    if (action === "copy-code") {
      post({ type: "copy", text });
      flashButton(actionEl, "Copied");
    } else if (action === "insert-code") {
      post({ type: "insertCode", text });
    } else {
      post({ type: "applyCode", text });
    }
    return;
  }

  const id = actionEl.dataset.id;
  const message = id ? getMessage(id) : undefined;
  if (action === "toggle-activity" && message && message.activity) {
    message.activity.expanded = !message.activity.expanded;
    scheduleRender();
    return;
  }
  if (action === "toggle-step") {
    const stepId = actionEl.dataset.stepId;
    if (stepId) toggleActivityStep(stepId);
    return;
  }
  if (action === "expand-card") {
    const stepId = actionEl.dataset.stepId;
    const step = stepId ? findStep(stepId) : undefined;
    if (step) showCardOverlay(step);
    return;
  }
  if (action === "preview-image" && message) {
    const index = Number(actionEl.dataset.index);
    const attachment = Number.isInteger(index) ? message.attachments?.[index] : undefined;
    if (attachment) showImagePreview(attachment);
    return;
  }
  if (action === "copy" && message) {
    post({ type: "copy", text: message.text || "" });
    actionEl.classList.add("copied");
    actionEl.textContent = "✓";
    setTimeout(() => scheduleRender(), 700);
    return;
  }
  if (action === "edit" && message) {
    inputEl.value = message.text || "";
    autoResizeInput();
    updateInputState();
    inputEl.focus();
    return;
  }
  if ((action === "ui-confirm" || action === "ui-cancel") && message && message.ui) {
    message.ui.resolved = true;
    post({
      type: "extensionUiResponse",
      response: {
        type: "extension_ui_response",
        id: message.ui.requestId,
        confirmed: action === "ui-confirm",
        cancelled: action === "ui-cancel",
      },
    });
    scheduleRender();
  }
}
