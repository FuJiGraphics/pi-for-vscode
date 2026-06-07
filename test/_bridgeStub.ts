// Test helper (NOT a *.test.ts, so the runner skips it). bridge.ts calls acquireVsCodeApi()
// at module load; this stub must be installed BEFORE sessionStore→bridge is imported. ESM
// evaluates dependencies in import order, so importing this module first installs the global.
let persisted: unknown = undefined;

(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
  postMessage() {},
  getState: () => persisted,
  setState: (v: unknown) => {
    persisted = v;
  },
});

/** Preload the persisted (crash) blob a freshly-constructed SessionViewStore will restore. */
export function setPersisted(value: unknown): void {
  persisted = value;
}
