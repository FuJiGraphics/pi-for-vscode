// The onboarding gate: a full-screen overlay shown ONLY on an explicit "unauthenticated"
// verdict from the host (never on "unknown" — startup latency must not flash it). The
// sign-in cards drive pi's own /login flow through the auth bridge; the extension_ui_request
// dialogs that follow render INSIDE the gate via the extensionUi dialog host (the flows
// themselves — OAuth, device code, API key — remain pi's). The gate dismisses itself when
// the host confirms authentication (auth.json watcher → model refetch → authState).
import { onboardingRootEl } from "./dom";
import { post } from "./bridge";
import { piMarkHtml } from "./piMark";
import { authStatus, isAuthAvailable, subscribeAuthState } from "./authState";
import { cancelActiveDialog, registerDialogHost } from "./extensionUi";
import { escapeHtml } from "./util";

type Phase = "cards" | "authenticating";

let phase: Phase = "cards";
let notice = "";
let noticeIsError = false;
let visible = false;
let hideTimer: ReturnType<typeof setTimeout> | undefined;

function shouldShow(): boolean {
  return authStatus() === "unauthenticated";
}

function cardsHtml(): string {
  if (!isAuthAvailable()) {
    return (
      '<div class="onboarding-fallback">Sign-in is unavailable in this Pi runtime. ' +
      "Run <code>pi</code> in a terminal and use <code>/login</code>, then return here.</div>" +
      '<button class="onboarding-card" data-onboard="recheck"><div class="onboarding-card-title">Check again</div></button>'
    );
  }
  return (
    '<div class="onboarding-cards">' +
    '<button class="onboarding-card" data-onboard="subscription">' +
    '<div class="onboarding-card-title">Use a subscription</div>' +
    '<div class="onboarding-card-desc">Sign in with your provider account (OAuth)</div>' +
    "</button>" +
    '<button class="onboarding-card" data-onboard="api-key">' +
    '<div class="onboarding-card-title">Use an API key</div>' +
    '<div class="onboarding-card-desc">Paste a provider API key</div>' +
    "</button>" +
    "</div>"
  );
}

function noticeHtml(): string {
  if (!notice) return "";
  return '<div class="onboarding-notice' + (noticeIsError ? " error" : "") + '">' + escapeHtml(notice) + "</div>";
}

function render(): void {
  if (!visible) return;
  const body =
    phase === "cards"
      ? '<div class="onboarding-tagline">Sign in to start using Pi</div>' + cardsHtml() + noticeHtml()
      : '<div class="onboarding-tagline">Signing in…</div>' +
        '<div id="onboarding-step-root" class="onboarding-step-root"></div>' +
        noticeHtml() +
        '<button class="onboarding-back" data-onboard="back">Back</button>';
  onboardingRootEl.innerHTML =
    '<div class="onboarding-inner">' + piMarkHtml("boot") + '<div class="onboarding-word">pi</div>' + body + "</div>";
}

function show(): void {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = undefined;
  }
  if (!visible) {
    visible = true;
    phase = "cards";
    notice = "";
  }
  onboardingRootEl.hidden = false;
  onboardingRootEl.classList.remove("hide");
  render();
}

function dismiss(): void {
  if (!visible) return;
  visible = false;
  phase = "cards";
  notice = "";
  onboardingRootEl.classList.add("hide");
  hideTimer = setTimeout(() => {
    onboardingRootEl.hidden = true;
    onboardingRootEl.innerHTML = "";
    onboardingRootEl.classList.remove("hide");
  }, 420);
}

function sync(): void {
  if (shouldShow()) show();
  else dismiss();
}

/** Connection loss mid-login: the awaited pi dialog is gone — reset to the cards. */
export function onboardingConnectionChange(status: "reconnecting" | "connected" | "disconnected"): void {
  if (!visible || phase !== "authenticating") return;
  if (status === "disconnected") {
    phase = "cards";
    notice = "Connection lost - try signing in again.";
    noticeIsError = true;
    render();
  }
}

function handleClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  const button = target && target.closest ? (target.closest("[data-onboard]") as HTMLElement | null) : null;
  const action = button?.dataset.onboard;
  if (!action) return;
  if (action === "subscription" || action === "api-key") {
    phase = "authenticating";
    notice = "";
    render();
    post({ type: "login", method: action });
    return;
  }
  if (action === "back") {
    cancelActiveDialog();
    phase = "cards";
    render();
    return;
  }
  if (action === "recheck") {
    post({ type: "requestAuthState" });
    post({ type: "requestCommands" }); // refresh the bridge-liveness signal too
  }
}

export function initOnboarding(): void {
  registerDialogHost({
    el: () => onboardingRootEl.querySelector<HTMLElement>("#onboarding-step-root"),
    active: () => visible && phase === "authenticating",
    notify: (message, isError) => {
      notice = message;
      noticeIsError = isError;
      // A failed login lands back on the method cards; success is dismissed by authState.
      if (isError) phase = "cards";
      render();
    },
  });
  onboardingRootEl.addEventListener("click", handleClick);
  subscribeAuthState(sync);
}
