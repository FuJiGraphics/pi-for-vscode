// Settings panel (gear button): a slide-in popover with two sections —
//   Account: per-provider auth status (from the host's authState metadata) with per-row
//            sign-out, plus "Sign in or add provider" — all driving pi's auth-bridge
//            commands; pi remains the auth authority.
//   About:   extension + pi versions (host `about` message).
// Single scroll, no tab machinery (two short sections don't justify it).
import { appEl, settingsBtnEl, settingsListEl, settingsPanelEl } from "./dom";
import { post } from "./bridge";
import { escapeHtml } from "./util";
import { aboutInfo, authProviders, authStatus, isAuthAvailable, subscribeAuthState } from "./authState";

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

function accountRowsHtml(): string {
  if (!isAuthAvailable()) {
    return (
      '<div class="settings-note">Sign-in is unavailable in this Pi runtime - run <code>pi</code> in a terminal and use <code>/login</code>.</div>'
    );
  }
  const providers = authProviders();
  const rows = providers.map((provider) => {
    const badge = provider.authType === "oauth" ? "Subscription" : "API key";
    return (
      '<div class="settings-row"><span class="settings-row-name">' + escapeHtml(provider.id) + "</span>" +
      '<span class="settings-badge">' + badge + "</span>" +
      '<button class="settings-action" data-settings="signout" data-provider="' + escapeHtml(provider.id) + '">Sign out</button></div>'
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
  rows.push('<button class="settings-action primary" data-settings="signin">Sign in or add provider</button>');
  return rows.join("");
}

function aboutRowsHtml(): string {
  const about = aboutInfo();
  if (!about) return '<div class="settings-note">Loading…</div>';
  const pi = about.piVersion
    ? "Pi " + about.piVersion + (about.piSource ? " (" + about.piSource + ")" : "")
    : "Pi version unknown";
  return (
    '<div class="settings-row"><span class="settings-row-name">Extension</span><span class="settings-badge">' +
    escapeHtml(about.extensionVersion || "?") + "</span></div>" +
    '<div class="settings-row"><span class="settings-row-name">' + escapeHtml(pi) + "</span></div>"
  );
}

export function renderSettings(): void {
  if (!isSettingsOpen()) return;
  settingsListEl.innerHTML =
    '<div class="settings-section-title">Account</div>' +
    accountRowsHtml() +
    '<div class="settings-section-title">About</div>' +
    aboutRowsHtml();
}

function handleListClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  const button = target && target.closest ? (target.closest("[data-settings]") as HTMLElement | null) : null;
  const action = button?.dataset.settings;
  if (!action) return;
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
