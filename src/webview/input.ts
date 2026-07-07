// Composer input behaviour: auto-resize, send-button empty state, the debounced submit
// that posts a prompt to the extension, and the edit-rewind mode (a previously sent user
// message being edited — sending forks the conversation at that message via pi's fork RPC).
import { state } from "./state";
import { editBannerEl, editCancelEl, inputEl, sendEl } from "./dom";
import { addMessage, setRunning } from "./conversation";
import { refreshSendButton } from "./render";
import { post } from "./bridge";
import { resetScrollFollowing } from "./scroll";
import { consumePendingImageAttachments, getPendingImageAttachments, hasPendingImageAttachments, restageImageAttachments } from "./attachments";
import { contextReference } from "./contextChip";
import type { UiMessage } from "./types";

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

// ---- edit-rewind mode ----
// While set, the composer is editing an already-sent user message. Submitting posts
// `editMessage` (host: pi `fork` at that message + resend) instead of a plain prompt;
// Escape or the banner's ✕ cancels. The original session file survives on disk (pi's
// fork creates a BRANCHED session), so nothing here is destructive.
let editing: { messageId: string; userOrdinal: number; originalText: string } | undefined;

export function isEditing(): boolean {
  return editing !== undefined;
}

export function beginEdit(message: UiMessage, userOrdinal: number): void {
  editing = { messageId: message.id, userOrdinal, originalText: message.text || "" };
  editBannerEl.hidden = false;
  inputEl.value = message.text || "";
  // Re-stage the original's images so a text-only edit doesn't fork the picture away and
  // leave pi answering a "what's in this screenshot?" prompt it can no longer see.
  restageImageAttachments(message.attachments);
  autoResizeInput();
  updateInputState();
  inputEl.focus();
  const end = inputEl.value.length;
  inputEl.setSelectionRange(end, end);
}

export function cancelEdit(): void {
  if (!editing) return;
  editing = undefined;
  editBannerEl.hidden = true;
  restageImageAttachments(undefined); // clear any re-staged edit images
  clearComposer();
}

export function initEditBanner(): void {
  editCancelEl.addEventListener("click", cancelEdit);
}

// Submit while editing: optimistically rewind the visible conversation to just before the
// edited message, show the edited text as a fresh user bubble with the spinner, and let the
// host fork + resend. On a host-side failure the forced re-seed restores the true state.
function submitEdit(text: string, images: ReturnType<typeof consumePendingImageAttachments>): void {
  const { messageId, userOrdinal, originalText } = editing as NonNullable<typeof editing>;
  editing = undefined;
  editBannerEl.hidden = true;
  const index = state.messages.findIndex((message) => message.id === messageId);
  if (index !== -1) state.messages = state.messages.slice(0, index);
  state.currentAssistantId = null;
  resetScrollFollowing();
  addMessage("user", text, { attachments: images });
  setRunning(true); // optimistic — the fork + resend round-trip lights the real one
  post({ type: "editMessage", userOrdinal, originalText, text, images });
}

export function submitInput(): void {
  const raw = inputEl.value;
  const typed = raw.trim();
  // The context chip (when lit) appends the active file reference. Shown in the user
  // bubble too — what was sent is what the user sees (and the path renders clickable).
  // Edit-rewind submits skip the reference: the resent text should stay faithful to
  // what the user edited.
  const reference = typed && !editing ? contextReference() : "";
  const text = reference ? typed + "\n\n(Context: @" + reference + ")" : typed;
  const pendingImages = getPendingImageAttachments();
  const hasImages = pendingImages.length > 0;
  if (!text && !hasImages) return;
  const now = Date.now();
  if (now < submitLockedUntil) return;
  // Short windows: the lock only guards the Enter+click double-fire race, and the same-text
  // dedupe only accidental double-submits — rapid genuine sends must feel instant.
  if (!hasImages && state.lastSentText === text && now - state.lastSentAt < 500) return;
  const images = consumePendingImageAttachments();
  submitLockedUntil = now + 150;
  state.lastSentText = text;
  state.lastSentAt = now;
  if (editing) {
    inputEl.value = "";
    autoResizeInput();
    updateInputState();
    submitEdit(text, images);
    return;
  }
  const idle = !state.running;
  if (idle) state.currentAssistantId = null;
  resetScrollFollowing();
  const sent = addMessage("user", text, { attachments: images });
  // A mid-run send waits in pi's steer/follow-up queue — show it dimmed with a "Queued"
  // chip until pi echoes its message_start (handlers → resolveOldestPending).
  if (!idle) sent.pending = true;
  inputEl.value = "";
  autoResizeInput();
  updateInputState();
  sendEl.classList.remove("sent");
  void sendEl.offsetWidth;
  sendEl.classList.add("sent");
  // Optimistic working state: light the spinner the instant we send rather than waiting for pi's
  // agent_start to round-trip back through the broker (the cold-start case is the worst gap). The
  // real agent_start's setRunning(true) is then idempotent and reuses this bubble; a rejected
  // prompt has the host post running:false, which prunes this still-empty bubble. Only when idle —
  // a mid-run send already shows the spinner and the message_start{user} boundary owns the split.
  if (idle) setRunning(true);
  post({ type: "prompt", text, images });
}
