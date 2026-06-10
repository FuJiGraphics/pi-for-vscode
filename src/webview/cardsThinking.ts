// The thinking card: pi's reasoning stream rendered as dim italic plaintext (NOT markdown —
// the live painter then only assigns textContent, so no markdown-it/Shiki re-parse per frame).
// Pure, DOM-free string builder, same contract as cardsTodo.ts. While streaming the card shows
// the latest tail anchored to the bottom (CSS .live); once done it clips like a Read card with
// the ⤢ overlay for the full text.
import { escapeHtml } from "./util";
import { liveThinkingTail } from "./thinkingSteps";
import type { ActivityStep } from "./types";

// Same markup contract as cards.ts's expandButton (kept local to avoid a cards ⇄ cardsThinking
// import cycle): cardOverlay.ts rebuilds the body via cardFor(step) on expand.
function expandButton(stepId: string): string {
  return (
    '<button class="tl-expand" data-action="expand-card" data-step-id="' +
    escapeHtml(stepId) +
    '" title="Expand" aria-label="Expand">⤢</button>'
  );
}

export function thinkingCardHtml(step: ActivityStep): string {
  const running = step.status === "running";
  const text = running ? liveThinkingTail(step) : step.thinkingText || "";
  if (!text && !step.redacted) return "";
  return (
    '<div class="tl-card tl-thinking' + (running ? " live" : "") + '">' +
    (running ? "" : expandButton(step.id)) +
    '<div class="thinking-text">' +
    escapeHtml(text) +
    "</div></div>"
  );
}
