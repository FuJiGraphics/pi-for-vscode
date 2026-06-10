// Cached references to the static elements declared in webviewHtml.ts.
// Resolved once at module load (the bundle runs after the body is parsed).

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`pi-for-vscode webview: missing element #${id}`);
  return el as T;
}

function bySelector<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`pi-for-vscode webview: missing element ${selector}`);
  return el;
}

export const appEl = bySelector<HTMLElement>(".app");
export const titleEl = byId<HTMLElement>("title");
export const messagesEl = byId<HTMLElement>("messages");
export const jumpLatestEl = byId<HTMLButtonElement>("jumpLatest");
export const connectionBannerEl = byId<HTMLElement>("connection-banner");
export const inputEl = byId<HTMLTextAreaElement>("input");
export const attachmentTrayEl = byId<HTMLElement>("attachmentTray");
export const contextChipEl = byId<HTMLButtonElement>("contextChip");
export const imageInputEl = byId<HTMLInputElement>("imageInput");
export const attachImageEl = byId<HTMLButtonElement>("attachImage");
export const sendEl = byId<HTMLButtonElement>("send");
export const stopEl = byId<HTMLButtonElement>("stop");
export const historyBtnEl = byId<HTMLButtonElement>("history");
export const newSessionEl = byId<HTMLButtonElement>("newSession");
export const composerWrapEl = bySelector<HTMLElement>(".composer-wrap");
export const sessionStatsEl = byId<HTMLElement>("sessionStats");
export const composerEl = byId<HTMLElement>("composer");
export const thinkingControlEl = byId<HTMLButtonElement>("thinkingControl");
export const thinkingPanelEl = byId<HTMLElement>("thinking-panel");
export const thinkingListEl = byId<HTMLElement>("thinking-list");
export const modelEl = byId<HTMLButtonElement>("model");
export const historyPanelEl = byId<HTMLElement>("history-panel");
export const historyListEl = byId<HTMLElement>("history-list");
export const historySearchEl = byId<HTMLInputElement>("history-search");
export const modelPanelEl = byId<HTMLElement>("model-panel");
export const modelListEl = byId<HTMLElement>("model-list");
export const modelSearchEl = byId<HTMLInputElement>("model-search");
export const commandPanelEl = byId<HTMLElement>("command-panel");
export const commandListEl = byId<HTMLElement>("command-list");
export const extensionUiRootEl = byId<HTMLElement>("extension-ui-root");
export const onboardingRootEl = byId<HTMLElement>("onboarding-root");
