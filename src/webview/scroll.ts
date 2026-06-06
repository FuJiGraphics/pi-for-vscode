import { appEl, composerWrapEl, jumpLatestEl, messagesEl } from "./dom";

const BOTTOM_THRESHOLD_PX = 36;

let autoFollow = true;
let composerObserver: ResizeObserver | undefined;

function distanceToBottom(): number {
  return Math.max(0, messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight);
}

function hasScrollableOverflow(): boolean {
  return messagesEl.scrollHeight > messagesEl.clientHeight + BOTTOM_THRESHOLD_PX;
}

function isAtLatest(): boolean {
  return distanceToBottom() <= BOTTOM_THRESHOLD_PX;
}

function updateJumpButton(): void {
  jumpLatestEl.hidden = !hasScrollableOverflow() || isAtLatest();
}

function updateJumpOffset(): void {
  appEl.style.setProperty("--jump-latest-bottom", composerWrapEl.offsetHeight + 14 + "px");
}

export function shouldFollowLatest(): boolean {
  return autoFollow || isAtLatest();
}

export function applyLatestScroll(shouldFollow: boolean): void {
  if (shouldFollow) {
    scrollToLatest();
    return;
  }

  updateJumpButton();
}

export function scrollToLatest(): void {
  autoFollow = true;
  messagesEl.scrollTop = messagesEl.scrollHeight;
  updateJumpButton();
}

export function resetScrollFollowing(): void {
  autoFollow = true;
  updateJumpButton();
}

export function initScrollControls(): void {
  messagesEl.addEventListener(
    "scroll",
    () => {
      autoFollow = isAtLatest();
      updateJumpButton();
    },
    { passive: true },
  );

  jumpLatestEl.addEventListener("click", () => {
    scrollToLatest();
    messagesEl.focus({ preventScroll: true });
  });

  updateJumpOffset();
  if (typeof ResizeObserver !== "undefined" && !composerObserver) {
    composerObserver = new ResizeObserver(updateJumpOffset);
    composerObserver.observe(composerWrapEl);
  }
  updateJumpButton();
}
