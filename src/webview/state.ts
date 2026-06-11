// Facade over the per-session view store. Keeps the SAME export names the rest of the webview
// imports (`state`, `withSession`, `activateSession`, …) so encapsulating the store into a
// class touched zero import sites. The store itself lives in ./sessionStore.
import type { AppState } from "./types";
import { SessionViewStore } from "./sessionStore";

// Constructed at module load (top-level), exactly as before, so the persisted view is
// restored before main.ts's first render() runs. Constructing it lazily would shift
// first-paint timing.
const store = new SessionViewStore();

// A stable object whose every access delegates to the store's CURRENT activeView. Importers
// hold this one reference forever; swapping the active session just repoints store.activeView.
// CRITICAL: read `store.activeView` FRESH inside every trap (never destructure/snapshot it) —
// that fresh read is what makes the swap visible through this Proxy.
export const state: AppState = new Proxy({} as AppState, {
  get: (_t, key) => (store.activeView as unknown as Record<string | symbol, unknown>)[key],
  set: (_t, key, value) => {
    (store.activeView as unknown as Record<string | symbol, unknown>)[key] = value;
    return true;
  },
  has: (_t, key) => key in (store.activeView as object),
  deleteProperty: (_t, key) => {
    delete (store.activeView as unknown as Record<string | symbol, unknown>)[key];
    return true;
  },
  ownKeys: () => Reflect.ownKeys(store.activeView as object),
  getOwnPropertyDescriptor: (_t, key) => Object.getOwnPropertyDescriptor(store.activeView, key),
});

export const getActiveSessionId = (): string => store.getActiveSessionId();
export const openViews = (): Array<{ id: string; view: AppState }> => store.openViews();
export const activateSession = (id: string): boolean => store.activateSession(id);
export const closeSessionTab = (id: string): string | undefined => store.closeSessionTab(id);
export const moveSessionTab = (id: string, targetId: string, placeAfter: boolean): boolean => store.moveSessionTab(id, targetId, placeAfter);
export const withSession = (id: string, fn: () => void): void => store.withSession(id, fn);
export const adoptPersistedView = (id: string, sessionFile: string): boolean => store.adoptPersistedView(id, sessionFile);
export const consumeRestored = (id: string): boolean => store.consumeRestored(id);
export const dropSession = (id: string): void => store.dropSession(id);
export const isRenderSuppressed = (): boolean => store.isRenderSuppressed();
export const save = (): void => store.save();
