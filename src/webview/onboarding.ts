// The auth-flow controller drives pi's sign-in across TWO surfaces, sharing one phase machine
// and ONE extensionUi dialog host (only one host can be registered at a time):
//   - GATE  (full-screen) — shown automatically on an explicit "unauthenticated" verdict
//            (0 models/providers). Never on "unknown" (startup latency must not flash it).
//   - MODAL (small, centered, over the chat) — opened on demand when ≥1 provider exists:
//            "add a provider" (Settings / model picker) and the model-invalidated prompt
//            raised when the selected model's provider was signed out on another device.
// `mode` ("hidden" | "gate" | "modal") is the single surface state — the two surfaces are
// mutually exclusive. The sign-in cards drive pi's /login through the auth bridge; the
// extension_ui_request dialogs that follow render INSIDE whichever surface is active. Pi owns
// the flows; we only choose where the markup lands. Gate dismisses on the host's auth
// confirmation; the modal closes on success, cancel, Escape, backdrop, or ✕.
import { authModalRootEl, onboardingRootEl } from "./dom";
import { post } from "./bridge";
import { piMarkHtml } from "./piMark";
import { authStatus, isAuthAvailable, subscribeAuthState } from "./authState";
import { cancelActiveDialog, registerDialogHost } from "./extensionUi";
import { openModelPicker } from "./modelPicker";
import { escapeHtml } from "./util";

type Mode = "hidden" | "gate" | "modal";
type Phase = "cards" | "authenticating" | "invalidated";

let mode: Mode = "hidden";
let phase: Phase = "cards";
let notice = "";
let noticeIsError = false;
let invalidatedModel = "";
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

// The cards/authenticating body, identical in both surfaces (stepRootId differs so the gate
// and the modal each host the pi dialog in their own node).
function bodyHtml(stepRootId: string): string {
  if (phase === "authenticating") {
    return (
      '<div class="onboarding-tagline">Signing in…</div>' +
      '<div id="' + stepRootId + '" class="onboarding-step-root"></div>' +
      noticeHtml() +
      '<button class="onboarding-back" data-onboard="back">Back</button>'
    );
  }
  const tagline = mode === "modal" ? "Add a provider" : "Sign in to start using Pi";
  return '<div class="onboarding-tagline">' + tagline + "</div>" + cardsHtml() + noticeHtml();
}

// The model-invalidated prompt (modal only): the selected model's provider was revoked
// elsewhere but other models remain. Offer to pick another or re-add the provider.
function invalidatedHtml(): string {
  const name = invalidatedModel || "The selected model";
  return (
    '<div class="onboarding-tagline">' +
    escapeHtml(name) +
    " is no longer available — its provider was signed out on another device.</div>" +
    '<div class="onboarding-cards">' +
    '<button class="onboarding-card" data-auth="pick"><div class="onboarding-card-title">Choose another model</div>' +
    '<div class="onboarding-card-desc">Pick from your available models</div></button>' +
    '<button class="onboarding-card" data-auth="relogin"><div class="onboarding-card-title">Sign in again</div>' +
    '<div class="onboarding-card-desc">Re-add the provider (OAuth or API key)</div></button>' +
    "</div>" +
    noticeHtml()
  );
}

function renderGate(): void {
  if (mode !== "gate") return;
  onboardingRootEl.innerHTML =
    '<div class="onboarding-inner">' +
    piMarkHtml("boot") +
    '<div class="onboarding-word">pi</div>' +
    bodyHtml("onboarding-step-root") +
    "</div>";
}

function renderModal(): void {
  if (mode !== "modal") return;
  const title = phase === "invalidated" ? "Model unavailable" : "Add a provider";
  const inner = phase === "invalidated" ? invalidatedHtml() : bodyHtml("auth-modal-step-root");
  authModalRootEl.innerHTML =
    '<div class="extension-ui-overlay" data-auth="backdrop" role="presentation">' +
    '<section class="extension-ui-panel auth-modal-panel" role="dialog" aria-modal="true">' +
    '<div class="extension-ui-head"><div class="extension-ui-title">' +
    escapeHtml(title) +
    '</div><button class="extension-ui-close" data-auth="close" aria-label="Close">✕</button></div>' +
    '<div class="auth-modal-body">' +
    inner +
    "</div></section></div>";
}

function render(): void {
  if (mode === "gate") renderGate();
  else if (mode === "modal") renderModal();
}

function show(): void {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = undefined;
  }
  if (mode !== "gate") {
    phase = "cards";
    notice = "";
  }
  mode = "gate";
  onboardingRootEl.hidden = false;
  onboardingRootEl.classList.remove("hide");
  renderGate();
}

function dismiss(): void {
  if (mode !== "gate") return;
  mode = "hidden";
  phase = "cards";
  notice = "";
  onboardingRootEl.classList.add("hide");
  hideTimer = setTimeout(() => {
    onboardingRootEl.hidden = true;
    onboardingRootEl.innerHTML = "";
    onboardingRootEl.classList.remove("hide");
  }, 420);
}

function openModal(nextPhase: Phase, model = ""): void {
  if (mode === "gate") return; // 0 models → the full-screen gate already shows the same cards
  mode = "modal";
  phase = nextPhase;
  notice = "";
  noticeIsError = false;
  invalidatedModel = model;
  authModalRootEl.hidden = false;
  renderModal();
}

/** Open the compact "add a provider" modal over the chat (≥1 provider already exists). */
export function openAuthModal(): void {
  openModal("cards");
}

/** Prompt the user that their selected model was revoked elsewhere (other models remain). */
export function openModelInvalidatedModal(previousModel?: string): void {
  openModal("invalidated", (previousModel || "").trim());
}

export function closeAuthModal(): void {
  if (mode !== "modal") return;
  cancelActiveDialog(); // resolve any awaited pi dialog as cancelled so pi doesn't hang
  mode = "hidden";
  phase = "cards";
  notice = "";
  invalidatedModel = "";
  authModalRootEl.hidden = true;
  authModalRootEl.innerHTML = "";
}

function sync(): void {
  if (shouldShow()) {
    // 0 models → the full-screen gate wins; tear down any open modal first.
    if (mode === "modal") closeAuthModal();
    show();
  } else {
    dismiss();
    // A modal mid-login: an authState change (auth.json was written) means the add-provider
    // succeeded — close it. dismiss() above is a no-op here since the gate isn't visible.
    if (mode === "modal" && phase === "authenticating") closeAuthModal();
  }
}

/** Connection loss mid-login: the awaited pi dialog is gone — reset to the cards. */
export function onboardingConnectionChange(status: "reconnecting" | "connected" | "disconnected"): void {
  if (status !== "disconnected") return;
  if (phase !== "authenticating" || mode === "hidden") return;
  phase = "cards";
  notice = "Connection lost - try signing in again.";
  noticeIsError = true;
  render();
}

// Shared by the cards in both surfaces (subscription / api-key / back / recheck).
function handleOnboardAction(action: string): void {
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

// Modal-only chrome + invalidated-prompt actions.
function handleAuthAction(action: string): void {
  if (action === "close") {
    closeAuthModal();
    return;
  }
  if (action === "pick") {
    closeAuthModal();
    openModelPicker();
    return;
  }
  if (action === "relogin") {
    phase = "cards";
    notice = "";
    render();
  }
}

function handleClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  if (!target?.closest) return;
  // Backdrop closes only on a click on the overlay element itself (not its children).
  if (target.dataset.auth === "backdrop") {
    handleAuthAction("close");
    return;
  }
  const authBtn = target.closest("[data-auth]") as HTMLElement | null;
  if (authBtn?.dataset.auth && authBtn.dataset.auth !== "backdrop") {
    handleAuthAction(authBtn.dataset.auth);
    return;
  }
  const onboardBtn = target.closest("[data-onboard]") as HTMLElement | null;
  if (onboardBtn?.dataset.onboard) handleOnboardAction(onboardBtn.dataset.onboard);
}

export function initOnboarding(): void {
  registerDialogHost({
    el: () =>
      mode === "gate"
        ? onboardingRootEl.querySelector<HTMLElement>("#onboarding-step-root")
        : mode === "modal"
          ? authModalRootEl.querySelector<HTMLElement>("#auth-modal-step-root")
          : null,
    active: () => phase === "authenticating" && mode !== "hidden",
    notify: (message, isError) => {
      notice = message;
      noticeIsError = isError;
      // A failed login lands back on the method cards; success is dismissed by authState.
      if (isError) phase = "cards";
      render();
    },
  });
  onboardingRootEl.addEventListener("click", handleClick);
  authModalRootEl.addEventListener("click", handleClick);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && mode === "modal") closeAuthModal();
  });
  subscribeAuthState(sync);
}
