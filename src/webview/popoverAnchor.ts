// Viewport-clamped anchoring for composer-row hover popovers.
//
// The webview is an iframe — it cannot paint outside its own bounds the way a
// native VS Code menu can. A composer-row trigger sits mid-row, so a pure-CSS
// `right: 0` popover that is wider than the space to its left spills past the
// panel's left edge and gets clipped (the visible symptom: the usage/context
// popover cut off on the left in a narrow side bar). CSS alone can't measure how
// much room a trigger has, so it can't avoid this.
//
// This positions the popover with `position: fixed` on open: measure the trigger,
// align the popover's right edge to it, then clamp left/right/top into the
// viewport (flipping below the trigger when there's no room above) and cap its
// width so it always fits even when the side bar is dragged very narrow.
//
// Display stays CSS-driven (`:hover` / `:focus` on the trigger toggles
// `display`); this only sets geometry, recomputed each time the popover opens.

const GAP = 8; // distance between trigger and popover
const MARGIN = 8; // min gap kept from every viewport edge

/**
 * Wire a stable trigger element so that the popover matched by `selector` (a
 * descendant rebuilt on each render) is positioned within the viewport whenever
 * it opens. Safe to call once at init — listeners live for the page lifetime.
 */
export function anchorPopover(trigger: HTMLElement, selector: string): void {
  const place = (): void => {
    const pop = trigger.querySelector<HTMLElement>(selector);
    if (!pop) return; // nothing built yet (control empty / hidden)

    // Cap width before measuring so a narrow side bar shrinks the box instead of
    // overflowing, then read the laid-out size to clamp position.
    pop.style.position = "fixed";
    pop.style.maxWidth = Math.max(0, window.innerWidth - MARGIN * 2) + "px";
    const t = trigger.getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;

    // Horizontal: align right edges, then clamp so neither edge leaves the viewport.
    const maxLeft = Math.max(MARGIN, window.innerWidth - w - MARGIN);
    const left = Math.min(Math.max(t.right - w, MARGIN), maxLeft);

    // Vertical: prefer above the trigger; flip below when there isn't room.
    let top = t.top - GAP - h;
    if (top < MARGIN) top = Math.min(t.bottom + GAP, window.innerHeight - h - MARGIN);

    pop.style.left = left + "px";
    pop.style.top = Math.max(MARGIN, top) + "px";
  };

  trigger.addEventListener("mouseenter", place);
  trigger.addEventListener("focusin", place);
  // Keep an open popover in bounds if the side bar is resized while it shows.
  window.addEventListener("resize", () => {
    if (trigger.matches(":hover") || trigger.contains(document.activeElement)) place();
  });
}
