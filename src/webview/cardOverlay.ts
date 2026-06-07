// Full-panel overlay that shows a tool card's content large and scrollable — the "expand"
// target for the ⤢ button on Read/Write/Edit cards. Mirrors the image-preview overlay pattern.
// Reuses cardFor() so the syntax highlighting and line numbers match the inline card exactly;
// the .card-overlay CSS drops the inline max-height clip and the expand button, and the overlay
// body owns the scrolling. Self-contained: closes on ✕, backdrop click, or Escape.
import { cardFor, stepDetail } from "./cards";
import { escapeHtml } from "./util";
import type { ActivityStep } from "./types";

let overlay: HTMLElement | undefined;

function headerText(step: ActivityStep): string {
  const detail = stepDetail(step);
  return detail ? step.label + " · " + detail : step.label;
}

function onKey(event: KeyboardEvent): void {
  if (event.key === "Escape") closeCardOverlay();
}

export function showCardOverlay(step: ActivityStep): void {
  const body = cardFor(step);
  if (!body) return;
  closeCardOverlay();

  const el = document.createElement("div");
  el.className = "card-overlay";
  el.innerHTML =
    '<div class="card-overlay-box" role="dialog" aria-modal="true">' +
    '<div class="card-overlay-head">' +
    '<span class="card-overlay-title">' + escapeHtml(headerText(step)) + "</span>" +
    '<button class="card-overlay-close" title="Close" aria-label="Close">✕</button>' +
    "</div>" +
    '<div class="card-overlay-body" tabindex="0">' + body + "</div>" +
    "</div>";

  // Clicking the dimmed backdrop (but not the box) closes; so does the ✕ and Escape.
  el.addEventListener("mousedown", (event) => {
    if (event.target === el) closeCardOverlay();
  });
  el.querySelector(".card-overlay-close")?.addEventListener("click", closeCardOverlay);
  document.addEventListener("keydown", onKey);

  document.body.appendChild(el);
  overlay = el;
  (el.querySelector(".card-overlay-body") as HTMLElement | null)?.focus();
}

export function closeCardOverlay(): void {
  if (!overlay) return;
  document.removeEventListener("keydown", onKey);
  overlay.remove();
  overlay = undefined;
}
