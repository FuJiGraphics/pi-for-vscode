// A single requestAnimationFrame loop that drives both the live "feel": it
// advances the typewriter reveal of the active assistant message and re-renders
// every frame so the thinking spinner animates. It self-stops once the agent is
// idle and the visible text has caught up to the full text.
import { state } from "./state";
import { paintLiveMessage } from "./render";

const MIN_STEP = 2;
const CATCHUP = 0.18;

let rafId = 0;

function activeAssistant() {
  const id = state.currentAssistantId;
  if (!id) return undefined;
  return state.messages.find((message) => message.id === id);
}

function tick(): void {
  rafId = 0;
  let backlog = false;

  const message = activeAssistant();
  if (message && typeof message.revealed === "number" && message.revealed < message.text.length) {
    const remaining = message.text.length - message.revealed;
    const step = Math.max(MIN_STEP, Math.ceil(remaining * CATCHUP));
    message.revealed = Math.min(message.text.length, message.revealed + step);
    backlog = message.revealed < message.text.length;
  }

  paintLiveMessage();

  if (state.running || backlog) schedule();
}

function schedule(): void {
  if (!rafId) rafId = requestAnimationFrame(tick);
}

export function ensureAnimating(): void {
  schedule();
}
