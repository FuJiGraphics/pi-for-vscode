// The single source of truth for the webview's conversation state, restored
// from (and persisted back to) the VS Code webview state store.
import type { AppState, UiMessage } from "./types";
import { getPersistedState, setPersistedState } from "./bridge";

const defaults: AppState = {
  messages: [],
  running: false,
  status: "Pi",
  modelLabel: "Pi",
  sessionName: "",
  sessionFile: "",
  thinkingLevel: "",
  thinkingLevels: [],
  currentAssistantId: null,
  lastSentText: "",
  lastSentAt: 0,
};

function restore(): AppState {
  const restored = getPersistedState();
  const merged: AppState = Object.assign(
    {},
    defaults,
    restored && typeof restored === "object" ? (restored as Partial<AppState>) : {},
  );
  merged.messages = Array.isArray(merged.messages)
    ? merged.messages.filter(
        (message: UiMessage) =>
          message &&
          message.role !== "tool" &&
          !(message.role === "assistant" && !message.text && !merged.running),
      )
    : [];
  if (!merged.running) merged.currentAssistantId = null;
  return merged;
}

export const state: AppState = restore();

let saveQueued = false;

export function save(): void {
  if (saveQueued) return;
  saveQueued = true;
  setTimeout(() => {
    saveQueued = false;
    setPersistedState(state);
  }, 180);
}
