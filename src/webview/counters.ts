// Roulette-style count-up for the timeline's "+N -N" diff badges. The keyed reconciler
// rebuilds a row's innerHTML whenever its sig changes (e.g. the synthetic args-based count
// upgrading to pi's exact diff), so an animation can't live on the element itself — render.ts
// calls animateCounters() with the scopes rewritten this render, and this module rolls each
// badge from its previously shown value (keyed by step + badge class) to the new target.
const DURATION_MS = 450;

const lastShown = new Map<string, number>(); // "<stepKey>|<badgeClass>" → last displayed value
const activeRafs = new Map<string, number>(); // key → rAF id (cancel a superseded roll)

const reduceMotion =
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function startRoll(key: string, el: HTMLElement, prefix: string, from: number, to: number): void {
  const pending = activeRafs.get(key);
  if (pending !== undefined) cancelAnimationFrame(pending);
  const start = performance.now();
  const tick = (now: number): void => {
    const t = Math.min(1, (now - start) / DURATION_MS);
    const value = Math.round(from + (to - from) * easeOutCubic(t));
    el.textContent = prefix + value;
    if (t < 1 && el.isConnected) {
      activeRafs.set(key, requestAnimationFrame(tick));
    } else {
      activeRafs.delete(key);
      el.textContent = prefix + to; // exact landing even if the element detached mid-roll
      el.classList.remove("ds-rolling");
    }
  };
  el.classList.add("ds-rolling");
  activeRafs.set(key, requestAnimationFrame(tick));
}

/** Roll every diff badge inside `scopes` (the elements rewritten this render) from its
 *  previously shown value to its data-target. First appearance rolls up from 0. */
export function animateCounters(scopes: HTMLElement[]): void {
  for (const scope of scopes) {
    if (!scope.isConnected) continue;
    scope.querySelectorAll<HTMLElement>(".ds-add[data-target], .ds-del[data-target]").forEach((el) => {
      const target = Number(el.dataset.target);
      if (!Number.isFinite(target)) return;
      const stepKey = (el.closest("[data-key]") as HTMLElement | null)?.dataset.key || "";
      const isAdd = el.classList.contains("ds-add");
      const key = stepKey + "|" + (isAdd ? "a" : "d");
      const prev = lastShown.get(key) ?? 0;
      lastShown.set(key, target);
      if (prev === target) return; // unchanged → the rendered final text is already right
      if (reduceMotion) {
        el.textContent = (isAdd ? "+" : "-") + target;
        return;
      }
      startRoll(key, el, isAdd ? "+" : "-", prev, target);
    });
  }
}
