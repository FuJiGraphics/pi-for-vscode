// Composer input behaviour: auto-resize, send-button empty state, and the
// debounced submit that posts a prompt to the extension.
import { state } from "./state";
import { inputEl, sendEl } from "./dom";
import { addMessage } from "./conversation";
import { refreshSendButton } from "./render";
import { post } from "./bridge";
import { resetScrollFollowing } from "./scroll";
import { consumePendingImageAttachments, getPendingImageAttachments, hasPendingImageAttachments } from "./attachments";

let submitLockedUntil = 0;

export function autoResizeInput(): void {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 132) + "px";
}

/** True when there is nothing staged to send (no text, no pending images). */
export function composerIsEmpty(): boolean {
  return !inputEl.value.trim() && !hasPendingImageAttachments();
}

export function updateInputState(): void {
  // Recompute the context-aware send/stop button glyph + dim state on every composer change so
  // typing while Pi is working flips ■ (stop) → ↑ (send) immediately.
  refreshSendButton();
}

// Replace the composer with a chosen slash command and leave the caret after a trailing
// space, ready for arguments. Used by the command palette when accepting a Pi command.
export function setComposerToCommand(name: string): void {
  inputEl.value = "/" + name + " ";
  autoResizeInput();
  updateInputState();
  inputEl.focus();
  const end = inputEl.value.length;
  inputEl.setSelectionRange(end, end);
}

// Clear the composer (used after a client-side built-in command runs).
export function clearComposer(): void {
  inputEl.value = "";
  autoResizeInput();
  updateInputState();
}

export function submitInput(): void {
  const raw = inputEl.value;
  const text = raw.trim();
  const pendingImages = getPendingImageAttachments();
  const hasImages = pendingImages.length > 0;
  if (!text && !hasImages) return;
  const now = Date.now();
  if (now < submitLockedUntil) return;
  if (!hasImages && state.lastSentText === text && now - state.lastSentAt < 900) return;
  const images = consumePendingImageAttachments();
  submitLockedUntil = now + 350;
  state.lastSentText = text;
  state.lastSentAt = now;
  if (!state.running) state.currentAssistantId = null;
  resetScrollFollowing();
  addMessage("user", text, { attachments: images });
  inputEl.value = "";
  autoResizeInput();
  updateInputState();
  sendEl.classList.remove("sent");
  void sendEl.offsetWidth;
  sendEl.classList.add("sent");
  post({ type: "prompt", text, images });
}
