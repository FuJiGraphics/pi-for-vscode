// Per-session conversation store for the webview.
//
// The webview shows ONE session at a time but keeps every session's view in memory
// (`views`), so switching is an instant swap that preserves each session's full
// conversation + activity timeline. Background sessions' events are applied to their own
// view (via `withSession`) without rendering.
//
// CRASH RESILIENCE: views are persisted to the webview state store keyed by sessionFile
// (stable across VS Code restarts). On reopen, the host re-seeds each session and we ADOPT
// the persisted view (full conversation + timeline, since the timeline lives on
// message.activity) instead of the plain disk re-hydrate. A session that was mid-turn when
// VS Code closed is marked `interrupted`.
//
// This class owns all that mutable state behind named transitions. `state.ts` is a thin
// facade that exposes the singleton + the SAME export names the rest of the webview imports.
import type { AppState, UiMessage } from "./types";
import { getPersistedState, setPersistedState } from "./bridge";

const MAX_PERSISTED_SESSIONS = 25;

function createView(): AppState {
  return {
    messages: [],
    running: false,
    modelLabel: "Pi",
    sessionName: "",
    sessionFile: "",
    thinkingLevel: "",
    thinkingLevels: [],
    currentAssistantId: null,
    lastSentText: "",
    lastSentAt: 0,
    sessionTokens: 0,
    sessionCost: 0,
  };
}

interface PersistedState {
  activeSessionFile?: string;
  bySessionFile?: Record<string, AppState>;
}

export class SessionViewStore {
  private readonly views = new Map<string, AppState>(); // live views, keyed by runtime id
  private readonly persistedViews = new Map<string, AppState>(); // restored crash views, keyed by sessionFile, not yet adopted
  private readonly restoredIds = new Set<string>(); // runtime ids whose view came from persistence (skip the disk re-seed once)
  private activeId = "";
  private suppressDepth = 0; // > 0 while applying to a background view: don't render/persist
  private saveQueued = false;

  // INVARIANT: `activeView` is the live delegate target of the `state` Proxy. The Proxy reads
  // `store.activeView` FRESH on every trap, so this field must stay a plain reassignable
  // reference — never snapshot it or expose it via a getter that copies.
  activeView: AppState;

  constructor() {
    this.activeView = this.restore();
  }

  getActiveSessionId(): string {
    return this.activeId;
  }

  // Every open session's view in tab order (Map insertion = open order). The active view is
  // read live (it may hold newer state than its `views` snapshot); the pre-activate ""
  // placeholder key is skipped — it has no runtime to switch to or close.
  openViews(): Array<{ id: string; view: AppState }> {
    const out: Array<{ id: string; view: AppState }> = [];
    for (const [id, view] of this.views) {
      if (!id) continue;
      out.push({ id, view: id === this.activeId ? this.activeView : view });
    }
    return out;
  }

  isRenderSuppressed(): boolean {
    return this.suppressDepth > 0;
  }

  // Make `id` the visible session, caching the current one. Returns true if it changed.
  // The outgoing view is re-cached only while it still EXISTS in the map — when a tab was
  // just closed (dropSession → activate next), unconditionally re-setting it would
  // resurrect the dropped view as a zombie tab.
  activateSession(id: string): boolean {
    if (id === this.activeId) return false;
    if (this.activeId && this.views.has(this.activeId)) this.views.set(this.activeId, this.activeView);
    this.activeId = id;
    this.activeView = this.getOrCreate(id);
    return true;
  }

  // Re-key the PROVISIONAL active view (the empty-state composer, which has no runtime id and
  // no session file) to its real runtime id on the first commit. The composer view — including
  // an optimistic first message + its spinner — becomes the new session's view instead of being
  // discarded for a blank one, so committing out of the empty state has no flicker. Marks the id
  // restored so the host's empty disk re-seed (sessionMessages) is skipped, exactly as
  // crash-restore protects an in-memory timeline.
  promoteProvisional(id: string): boolean {
    if (!id || id === this.activeId) return false;
    const view = this.activeView;
    this.views.delete(this.activeId); // drop the "" placeholder key if it was ever registered
    this.activeId = id;
    this.views.set(id, view);
    this.activeView = view;
    this.restoredIds.add(id);
    return true;
  }

  // Run `fn` against a specific session's view. The active session renders normally; a
  // background session's view is updated in place WITHOUT rendering.
  withSession(id: string, fn: () => void): void {
    if (id === this.activeId || !this.activeId) {
      if (!this.activeId) this.activeId = id;
      if (!this.views.has(id)) this.views.set(id, this.activeView);
      fn();
      return;
    }
    const previousId = this.activeId;
    this.activeView = this.getOrCreate(id);
    this.suppressDepth++;
    try {
      fn();
    } finally {
      this.suppressDepth--;
      // Restore by RE-RESOLVING the active id rather than a captured `activeView` reference:
      // if anything activated a different session during fn(), honor the current activeId
      // instead of reverting to a now-stale view. (Race #1 — defensive; webview message
      // handlers run to completion so re-entrancy is not expected, but this removes the
      // fragile captured-reference assumption entirely.)
      this.activeView = this.getOrCreate(this.activeId || previousId);
    }
  }

  // When the host seeds runtime `id` for `sessionFile`, restore the persisted (crash) view if
  // we have one: copy its conversation + timeline into the live view and skip the disk re-seed
  // that follows. Returns true if a persisted view was adopted.
  adoptPersistedView(id: string, sessionFile: string): boolean {
    if (!sessionFile) return false;
    const persisted = this.persistedViews.get(sessionFile);
    if (!persisted) return false;
    const view = this.views.get(id);
    if (!view) return false;
    view.messages = persisted.messages; // conversation + activity timeline
    view.interrupted = persisted.interrupted;
    view.sessionTokens = persisted.sessionTokens || 0;
    view.sessionCost = persisted.sessionCost || 0;
    view.currentAssistantId = null;
    view.running = false;
    this.persistedViews.delete(sessionFile);
    this.restoredIds.add(id);
    return true;
  }

  // True (once) if `id`'s view was just restored from persistence — caller skips the re-seed
  // so the disk's plain messages don't clobber the restored timeline.
  consumeRestored(id: string): boolean {
    return this.restoredIds.delete(id);
  }

  dropSession(id: string): void {
    const view = this.views.get(id);
    if (view?.sessionFile) this.persistedViews.delete(view.sessionFile);
    this.views.delete(id);
    if (this.activeId === id) {
      this.activeId = "";
      this.activeView = createView();
    }
  }

  // UI-only close for the tab strip: remove the view immediately, and if it was active,
  // activate the Chrome-style neighbor (right tab first, then left). The host still reaps
  // the runtime afterwards; History remains the only place that deletes the saved file.
  closeSessionTab(id: string): string | undefined {
    const ids = this.openViews().map((entry) => entry.id);
    const index = ids.indexOf(id);
    if (index === -1) return this.activeId || undefined;
    const wasActive = id === this.activeId;
    const nextId = wasActive ? ids[index + 1] ?? ids[index - 1] : this.activeId || undefined;
    this.dropSession(id);
    if (wasActive && nextId) this.activateSession(nextId);
    return nextId;
  }

  moveSessionTab(id: string, targetId: string, placeAfter: boolean): boolean {
    if (!id || !targetId || id === targetId || !this.views.has(id) || !this.views.has(targetId)) return false;
    const entries = [...this.views.entries()];
    const moving = entries.find((entry) => entry[0] === id);
    if (!moving) return false;
    const without = entries.filter((entry) => entry[0] !== id);
    const targetIndex = without.findIndex((entry) => entry[0] === targetId);
    if (targetIndex === -1) return false;
    without.splice(targetIndex + (placeAfter ? 1 : 0), 0, moving);
    this.views.clear();
    for (const [key, view] of without) this.views.set(key, view);
    return true;
  }

  save(): void {
    if (this.saveQueued) return;
    this.saveQueued = true;
    setTimeout(() => {
      this.saveQueued = false;
      this.persist();
    }, 180);
  }

  private getOrCreate(id: string): AppState {
    let view = this.views.get(id);
    if (!view) {
      view = createView();
      this.views.set(id, view);
    }
    return view;
  }

  // Normalize a (possibly persisted) view; mark interrupted if it was mid-turn at save time.
  private sanitizeView(raw: unknown): AppState {
    const view = Object.assign(createView(), raw && typeof raw === "object" ? (raw as Partial<AppState>) : {});
    view.messages = Array.isArray(view.messages)
      ? view.messages.filter((m: UiMessage) => m && m.role !== "tool")
      : [];
    if (view.running) {
      view.running = false;
      // Mark the turn that was mid-flight when VS Code closed so it shows an inline
      // "Interrupted" marker (same as a manual Stop).
      for (let i = view.messages.length - 1; i >= 0; i--) {
        if (view.messages[i].role === "assistant") {
          view.messages[i].interrupted = true;
          break;
        }
      }
    }
    view.currentAssistantId = null;
    for (const m of view.messages) {
      if (typeof m.revealed === "number") m.revealed = m.text.length; // reveal any half-typed text
      if (m.activity) {
        if (m.activity.endedAt == null) m.activity.endedAt = m.activity.startedAt;
        // Views persisted by older builds still hold "Generated" checkpoint rows — drop them
        // (usage now rolls up in the status header, never as timeline nodes).
        m.activity.steps = m.activity.steps.filter((step) => (step.kind as string) !== "generation");
        for (const step of m.activity.steps) if (step.status === "running") step.status = "done";
      }
    }
    return view;
  }

  private restore(): AppState {
    const raw = getPersistedState() as PersistedState | undefined;
    const by = raw && typeof raw.bySessionFile === "object" && raw.bySessionFile ? raw.bySessionFile : {};
    for (const [file, view] of Object.entries(by)) {
      if (file) this.persistedViews.set(file, this.sanitizeView(view));
    }
    // Show the last-active session's view immediately (the host re-keys it to a runtime id
    // when it activates). Falls back to a fresh empty view.
    const activeFile = typeof raw?.activeSessionFile === "string" ? raw.activeSessionFile : "";
    return (activeFile && this.persistedViews.get(activeFile)) || createView();
  }

  private persist(): void {
    // Persist by sessionFile: not-yet-reopened crash views plus all live views with a file.
    const out: Record<string, AppState> = {};
    for (const [file, view] of this.persistedViews) out[file] = view;
    for (const view of this.views.values()) if (view.sessionFile) out[view.sessionFile] = view;
    setPersistedState({ activeSessionFile: this.activeView.sessionFile || "", bySessionFile: this.capRecent(out) });
  }

  // Keep only the most-recently-used sessions so the stored blob can't grow without bound.
  private capRecent(map: Record<string, AppState>): Record<string, AppState> {
    const entries = Object.entries(map);
    if (entries.length <= MAX_PERSISTED_SESSIONS) return map;
    entries.sort((a, b) => (b[1].lastSentAt || 0) - (a[1].lastSentAt || 0));
    return Object.fromEntries(entries.slice(0, MAX_PERSISTED_SESSIONS));
  }
}
