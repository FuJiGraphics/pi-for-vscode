// Settings panel (gear button): a slide-in popover with a header and two cards —
//   Account: per-provider auth status (host authState metadata) with per-row sign-out,
//            plus "Sign in or add provider" — all driving pi's auth-bridge commands;
//            pi remains the auth authority.
//   About:   extension + pi versions (host `about` message).
import { appEl, settingsBtnEl, settingsListEl, settingsPanelEl } from "./dom";
import { post } from "./bridge";
import { escapeHtml } from "./util";
import { aboutInfo, authProviders, authStatus, isAuthAvailable, subscribeAuthState } from "./authState";

const ICON_ACCOUNT =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="5" r="3"/><path d="M2.5 14c.8-2.8 3-4 5.5-4s4.7 1.2 5.5 4"/></svg>';
const ICON_ABOUT =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M8 7.2v3.6"/><circle cx="8" cy="4.9" r=".4" fill="currentColor" stroke="none"/></svg>';
const ICON_CLOUD =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 12.5a3 3 0 0 1-.4-6A4 4 0 0 1 12 7.6a2.5 2.5 0 0 1-.5 4.9z"/></svg>';
const ICON_KEY =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5" cy="11" r="3"/><path d="M7.2 8.8L13.5 2.5"/><path d="M11 5l2 2"/></svg>';

export function isSettingsOpen(): boolean {
  return appEl.classList.contains("settings-open");
}

export function openSettings(): void {
  appEl.classList.remove("history-open", "model-open", "command-open", "thinking-open");
  appEl.classList.add("settings-open");
  renderSettings();
  post({ type: "requestAuthState" });
  post({ type: "requestAbout" });
}

export function closeSettings(): void {
  appEl.classList.remove("settings-open");
}

export function toggleSettings(): void {
  if (isSettingsOpen()) closeSettings();
  else openSettings();
}

function accountCardHtml(): string {
  let body = "";
  if (!isAuthAvailable()) {
    body =
      '<div class="settings-note">Sign-in is unavailable in this Pi runtime - run <code>pi</code> in a terminal and use <code>/login</code>.</div>';
  } else {
    const providers = authProviders();
    const rows = providers.map((provider) => {
      const oauth = provider.authType === "oauth";
      return (
        '<div class="settings-row">' +
        '<span class="settings-row-icon">' + (oauth ? ICON_CLOUD : ICON_KEY) + "</span>" +
        '<span class="settings-row-name">' + escapeHtml(provider.id) + "</span>" +
        '<span class="settings-badge">' + (oauth ? "Subscription" : "API key") + "</span>" +
        '<button class="settings-action danger" data-settings="signout" data-provider="' + escapeHtml(provider.id) + '">Sign out</button>' +
        "</div>"
      );
    });
    if (rows.length === 0) {
      rows.push(
        '<div class="settings-note">' +
        (authStatus() === "authenticated"
          ? "Credentials provided by environment variables or provider config."
          : "No provider credentials stored.") +
        "</div>",
      );
    }
    rows.push('<button class="settings-primary" data-settings="signin">Sign in or add provider</button>');
    body = rows.join("");
  }
  return (
    '<div class="settings-card">' +
    '<div class="settings-card-title">' + ICON_ACCOUNT + "<span>Account</span></div>" +
    body +
    "</div>"
  );
}

function aboutCardHtml(): string {
  const about = aboutInfo();
  const body = about
    ? '<div class="settings-row"><span class="settings-row-name">Extension</span><span class="settings-value">' +
      escapeHtml(about.extensionVersion || "?") + "</span></div>" +
      '<div class="settings-row"><span class="settings-row-name">Pi agent</span><span class="settings-value">' +
      escapeHtml(about.piVersion || "unknown") + "</span>" +
      (about.piSource ? '<span class="settings-badge">' + escapeHtml(about.piSource) + "</span>" : "") +
      "</div>"
    : '<div class="settings-note">Loading…</div>';
  return (
    '<div class="settings-card">' +
    '<div class="settings-card-title">' + ICON_ABOUT + "<span>About</span></div>" +
    body +
    "</div>"
  );
}

export function renderSettings(): void {
  if (!isSettingsOpen()) return;
  settingsListEl.innerHTML =
    '<div class="settings-head"><span class="settings-title">Settings</span>' +
    '<button class="settings-close" data-settings="close" aria-label="Close">✕</button></div>' +
    accountCardHtml() +
    aboutCardHtml();
}

function handleListClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  const button = target && target.closest ? (target.closest("[data-settings]") as HTMLElement | null) : null;
  const action = button?.dataset.settings;
  if (!action) return;
  if (action === "close") {
    closeSettings();
    return;
  }
  if (action === "signin") {
    post({ type: "login" });
    closeSettings();
    return;
  }
  if (action === "signout") {
    const provider = button?.dataset.provider;
    post(provider ? { type: "logout", provider } : { type: "logout" });
    closeSettings();
  }
}

function handleOutsideClick(event: MouseEvent): void {
  if (!isSettingsOpen()) return;
  const target = event.target as Node | null;
  if (!target) return;
  if (settingsPanelEl.contains(target) || settingsBtnEl.contains(target)) return;
  closeSettings();
}

export function initSettings(): void {
  settingsBtnEl.addEventListener("click", toggleSettings);
  settingsListEl.addEventListener("click", handleListClick);
  document.addEventListener("click", handleOutsideClick);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isSettingsOpen()) closeSettings();
  });
  subscribeAuthState(renderSettings);
}
