import { appEl, composerWrapEl, jumpLatestEl, messagesEl } from "./dom";

// Jump-to-latest button visibility band: hidden once the viewport is "basically" at the bottom.
const BOTTOM_THRESHOLD_PX = 36;
// Re-pin band: auto-follow only RESUMES when the user brings the viewport essentially flush with
// the bottom. Far tighter than BOTTOM_THRESHOLD so a small deliberate scroll-up actually escapes
// the follow instead of being instantly re-captured by the bottom band.
const REPIN_THRESHOLD_PX = 4;

// autoFollow is INTENT-driven, not position-derived. It turns OFF the moment the user scrolls up
// (wheel / scrollbar drag / keyboard) and back ON only when they return to the bottom or hit the
// jump button. The old code OR-ed `isAtLatest()` into shouldFollowLatest(), which force-pinned the
// whole bottom 36px band every animation frame — so during a live turn the 60fps paint loop kept
// snapping the user back to the bottom and small scroll-ups were impossible to hold.
let autoFollow = true;
let lastScrollTop = 0;
let composerObserver: ResizeObserver | undefined;

function distanceToBottom(): number {
  return Math.max(0, messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight);
}

function hasScrollableOverflow(): boolean {
  return messagesEl.scrollHeight > messagesEl.clientHeight + BOTTOM_THRESHOLD_PX;
}

// Within the jump-button band — "near enough the bottom that the button shouldn't show".
function isNearBottom(): boolean {
  return distanceToBottom() <= BOTTOM_THRESHOLD_PX;
}

// Flush with the bottom — the condition for RE-engaging auto-follow.
function isAtBottom(): boolean {
  return distanceToBottom() <= REPIN_THRESHOLD_PX;
}

function updateJumpButton(): void {
  jumpLatestEl.hidden = !hasScrollableOverflow() || isNearBottom();
}

function updateJumpOffset(): void {
  appEl.style.setProperty("--jump-latest-bottom", composerWrapEl.offsetHeight + 14 + "px");
}

// Break auto-follow on explicit upward intent. Synchronous (called from the wheel/keydown
// handlers) so it lands BEFORE the next animation-frame paint can snap back to the bottom.
function unpin(): void {
  if (!autoFollow) return;
  autoFollow = false;
  updateJumpButton();
}

export function shouldFollowLatest(): boolean {
  return autoFollow;
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
  lastScrollTop = messagesEl.scrollTop;
  updateJumpButton();
}

export function resetScrollFollowing(): void {
  autoFollow = true;
  lastScrollTop = messagesEl.scrollTop;
  updateJumpButton();
}

export function initScrollControls(): void {
  // Synchronous intent capture: an upward wheel/trackpad gesture unpins IMMEDIATELY, before the
  // next rAF paint can re-snap to the bottom. This is what makes scrolling up during a live turn
  // actually stick instead of fighting the auto-scroll.
  messagesEl.addEventListener(
    "wheel",
    (event) => {
      if (event.deltaY < 0 && hasScrollableOverflow()) unpin();
    },
    { passive: true },
  );

  // Keyboard scroll-up (the list is focusable, tabindex=0) also expresses "I want to read up".
  messagesEl.addEventListener("keydown", (event) => {
    if ((event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home") && hasScrollableOverflow()) {
      unpin();
    }
  });

  // Direction-aware fallback (covers dragging the scrollbar, which fires no wheel event): moving
  // up unpins, arriving back flush with the bottom re-pins. Programmatic scrollToLatest keeps
  // lastScrollTop synced so it never reads as a user scroll-up. `passive` — never preventDefault.
  messagesEl.addEventListener(
    "scroll",
    () => {
      const top = messagesEl.scrollTop;
      if (top < lastScrollTop - 1) {
        autoFollow = false;
      } else if (isAtBottom()) {
        autoFollow = true;
      }
      lastScrollTop = top;
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
  lastScrollTop = messagesEl.scrollTop;
  updateJumpButton();
}
