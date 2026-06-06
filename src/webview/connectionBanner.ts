// Slim, non-blocking connection banner under the header. Hidden while healthy;
// shows "Reconnecting…" during a transport drop, briefly flashes "Connected" on
// recovery (auto-hides), and offers a Retry on terminal "Disconnected".
import { post } from "./bridge";
import { connectionBannerEl as el } from "./dom";

let hideTimer: ReturnType<typeof setTimeout> | undefined;

export type ConnectionStatus = "reconnecting" | "connected" | "disconnected";

export function updateConnectionBanner(status: ConnectionStatus): void {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = undefined;
  }

  if (status === "reconnecting") {
    el.className = "connection-banner reconnecting";
    el.innerHTML = '<span class="cb-spinner" aria-hidden="true"></span><span>Reconnecting…</span>';
    el.hidden = false;
    return;
  }

  if (status === "connected") {
    el.className = "connection-banner connected";
    el.innerHTML = '<span class="cb-icon" aria-hidden="true">✓</span><span>Connected</span>';
    el.hidden = false;
    hideTimer = setTimeout(() => {
      el.hidden = true;
    }, 1500);
    return;
  }

  el.className = "connection-banner disconnected";
  el.innerHTML =
    '<span class="cb-icon" aria-hidden="true">⚠</span><span>Disconnected</span>' +
    '<button type="button" class="cb-retry">Retry</button>';
  el.hidden = false;
}

el.addEventListener("click", (event) => {
  const target = event.target as HTMLElement | null;
  if (!target || !target.classList.contains("cb-retry")) return;
  post({ type: "reconnect" });
  updateConnectionBanner("reconnecting");
});
