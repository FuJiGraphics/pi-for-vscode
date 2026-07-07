// A single requestAnimationFrame loop that drives the live "feel" while a turn runs: it
// repaints the active message's volatile leaves (spinner glyph/word/seconds, status task,
// the time-throttled streaming bubble/thinking tail — see render.paintLiveMessage) and
// self-stops once the agent is idle. Streamed text lands as it arrives (no typewriter
// reveal): the paint throttle in paintLiveMessage bounds the markdown re-parse cost, so a
// fast model never builds a render backlog.
import { state } from "./state";
import { paintLiveMessage } from "./render";
import { paintStatusStrip } from "./statusStrip";

let rafId = 0;

function tick(): void {
  rafId = 0;
  paintLiveMessage();
  paintStatusStrip();
  if (state.running) schedule();
}

function schedule(): void {
  if (!rafId) rafId = requestAnimationFrame(tick);
}

export function ensureAnimating(): void {
  schedule();
}
