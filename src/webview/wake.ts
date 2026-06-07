import { post } from "./bridge";

// Wake-from-sleep detection. A long stall between ticks means the machine was suspended (timers
// freeze during sleep), so the broker socket is likely half-open — nudge the host to verify and
// reconnect. Becoming visible again is a second, cheaper trigger. The host's probe is a no-op
// when the link is fine.
export function initWakeDetection(): void {
  let lastWakeTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    if (now - lastWakeTick > 30000) post({ type: "wake" });
    lastWakeTick = now;
  }, 10000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) post({ type: "wake" });
  });
}
