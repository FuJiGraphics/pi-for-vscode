// Thin typed wrapper around the VS Code webview API. All extension <-> webview
// traffic goes through here so message shapes stay typed via ../protocol.
import type { WebviewToExtensionMessage } from "../protocol";

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscodeApi = acquireVsCodeApi();

export function post(message: WebviewToExtensionMessage): void {
  vscodeApi.postMessage(message);
}

export function getPersistedState(): unknown {
  return vscodeApi.getState();
}

export function setPersistedState(state: unknown): void {
  vscodeApi.setState(state);
}
