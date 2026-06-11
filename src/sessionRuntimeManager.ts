import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { PiRpcClient } from "./piRpcClient";
import { NodeTooOldError, PiNotInstalledError, PINNED_PI_VERSION, detectPiVersion, resolvePiRuntime, type PiRuntime } from "./piResolver";
import type { SessionListItem } from "./protocol";
import { isPiSessionInWorkspace, listPiSessions, readPiSessionCwd, type PiSessionSummary } from "./sessionStore";
import { asRecord, toSessionListItem } from "./sessionFormat";
import { readSessionFile } from "./stateHelpers";
import { getWorkspaceCwd, getWorkspaceName, samePath } from "./workspace";
import type { PiConfiguration, SessionRuntime } from "./sessionRuntime";
import type { WebviewPresenter } from "./webviewPresenter";
import type { RpcEventRouter, RpcEventSink } from "./rpcEventRouter";
import type { BundledExtensionResolver } from "./bundledExtensionResolver";

// Owns the runtime map + the active-runtime pointer and the entire per-session lifecycle:
// spawn / connect / revive / switch-away / disconnect / reap, plus the pi state reads and
// the tagged posts that flow from runtime activity. Everything that mutates a SessionRuntime
// or the map lives here, so the shared mutable state has exactly one owner.
export class SessionRuntimeManager {
  private readonly runtimes = new Map<string, SessionRuntime>();
  private activeRuntimeId?: string;
  // Called when a runtime becomes idle or is activated, so the auth-revocation service can
  // drain a pending registry refresh on the visible session. Set once by the composition root.
  private settledHook?: (rt: SessionRuntime) => void;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly presenter: WebviewPresenter,
    private readonly events: RpcEventRouter,
    private readonly bundled: BundledExtensionResolver,
  ) {}

  get active(): SessionRuntime | undefined {
    return this.activeRuntimeId ? this.runtimes.get(this.activeRuntimeId) : undefined;
  }

  activeId(): string | undefined {
    return this.activeRuntimeId;
  }

  setActiveRuntimeId(id: string | undefined): void {
    this.activeRuntimeId = id;
  }

  setSettledHook(hook: (rt: SessionRuntime) => void): void {
    this.settledHook = hook;
  }

  forEachRuntime(callback: (rt: SessionRuntime) => void): void {
    for (const rt of this.runtimes.values()) callback(rt);
  }

  /** The RpcEventSink the router calls back into (this manager). */
  eventSink(): RpcEventSink {
    return {
      activeId: () => this.activeRuntimeId,
      setRunning: (rt, value) => this.setRunning(rt, value),
      postState: () => this.postState(),
      postSessionList: () => this.postSessionList(),
      onBackgroundRuntimeFinished: (rt) => this.onBackgroundRuntimeFinished(rt),
    };
  }

  // Make a runtime the visible session. Switching is a pure swap: the webview keeps each
  // session's view in memory, so we just tell it to `activate` (instant, no re-fetch) and
  // seed the view only the first time this runtime is shown. The previous session keeps
  // running in the background; its cached view stays live from tagged events.
  async activateRuntime(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt) return;

    const previous = this.active;
    this.activeRuntimeId = id;
    if (previous && previous !== rt) this.handleSwitchAway(previous);

    if (!rt.client?.isStarted) {
      if (!await this.reviveRuntime(rt)) return;
      // A cold revive relaunches a fresh broker whose pi has no session yet; load the file.
      if (rt.sessionFile && rt.client) {
        const state = await this.requestState(rt.client);
        if (!samePath(readSessionFile(state), rt.sessionFile)) {
          await rt.client.request({ type: "switch_session", sessionPath: rt.sessionFile }, 30_000).catch(() => undefined);
        }
      }
    }

    if (!rt.seeded) await this.seedRuntime(rt);
    this.presenter.post({ type: "activate", sessionId: rt.id });

    // Replay a UI request buffered while this runtime was backgrounded.
    if (rt.pendingUiRequest) {
      this.presenter.post({ type: "extensionUiRequest", request: rt.pendingUiRequest });
      rt.pendingUiRequest = undefined;
    }
    await this.postSessionList();
    // Now the visible session — correct a model selection invalidated by an auth change that
    // happened while this tab was in the background.
    this.settledHook?.(rt);
  }

  findRuntimeBySessionFile(sessionPath: string): SessionRuntime | undefined {
    for (const rt of this.runtimes.values()) {
      if (rt.sessionFile && samePath(rt.sessionFile, sessionPath)) return rt;
    }
    return undefined;
  }

  // Give the webview a session's initial view (current model/session state + full message
  // list), tagged with the runtime id. Done once per runtime; thereafter the webview keeps
  // the view live from tagged events, so switching back never re-fetches or drops the
  // timeline. Pass force=true to re-seed (after a model restart / reconnect / reload).
  async seedRuntime(rt: SessionRuntime, force = false): Promise<void> {
    const client = rt.client;
    if (!client?.isStarted) return;
    if (rt.seeded && !force) return;
    const workspaceName = getWorkspaceName(rt.cwd);
    const stateData = await this.requestState(client);
    if (stateData) {
      rt.sessionFile = readSessionFile(stateData);
      this.presenter.post({ type: "state", sessionId: rt.id, state: { ...stateData, workspaceName } });
    } else {
      this.presenter.post({ type: "state", sessionId: rt.id, state: { isStreaming: false, sessionFile: rt.sessionFile, model: undefined, workspaceName } });
    }
    const response = await client.request({ type: "get_messages" }, 10_000).catch(() => undefined);
    const data = asRecord(response?.data);
    const messages = Array.isArray(data?.messages) ? data.messages : [];
    this.presenter.post({ type: "sessionMessages", sessionId: rt.id, messages, force: true });
    rt.seeded = true;
  }

  async postSessionList(): Promise<void> {
    const summaries = await this.collectSessions();
    const sessions: SessionListItem[] = summaries.map((summary) => toSessionListItem(summary, this.runtimeFlagsFor(summary.filePath)));
    this.presenter.post({ type: "sessionList", sessions });
  }

  // Liveness flags for the session-list badges, sourced from the runtime map.
  private runtimeFlagsFor(filePath: string): { isRunning?: boolean; needsInput?: boolean } | undefined {
    const rt = this.findRuntimeBySessionFile(filePath);
    if (!rt) return undefined;
    return { isRunning: rt.isRunning, needsInput: rt.pendingUiRequest !== undefined };
  }

  async collectSessions(): Promise<PiSessionSummary[]> {
    const cwd = getWorkspaceCwd();
    if (!cwd) return [];
    // Use the active runtime's tracked session file for the "current" marker — no RPC,
    // so the frequent (per agent_start/agent_end) badge refresh stays cheap.
    const currentSessionFile = this.active?.sessionFile;
    return listPiSessions({ cwd, currentSessionFile });
  }

  // ---- runtime lifecycle ----

  // Returns a usable active runtime, creating one when there is none (first prompt /
  // command palette / view ready). Reuses the existing active runtime, shutting it down
  // only when its loaded session belongs to a different workspace (foreign-state guard).
  async ensureActiveRuntime(): Promise<SessionRuntime | undefined> {
    const cwd = getWorkspaceCwd();
    if (!cwd) {
      this.presenter.postSystem("Open a workspace folder to start a project-scoped Pi session.");
      return undefined;
    }

    const rt = this.active;
    if (rt) {
      if (rt.client?.isStarted) {
        if (rt.isRunning) return rt;
        if (samePath(rt.cwd, cwd)) {
          const state = await this.getClientState(rt);
          if (!state || !await this.isForeignWorkspaceState(state, cwd)) return rt;
          await this.reapRuntime(rt);
        } else {
          await this.reapRuntime(rt);
        }
      } else if (samePath(rt.cwd, cwd)) {
        // Active runtime's pi died (crash / reconnect exhausted) → respawn it in place.
        if (await this.reviveRuntime(rt)) {
          void this.postState();
          return rt;
        }
        this.dropRuntime(rt);
      } else {
        this.dropRuntime(rt);
      }
    }

    const fresh = await this.createRuntime(cwd);
    if (fresh) {
      this.activeRuntimeId = fresh.id;
      void this.postState();
    }
    return fresh;
  }

  // Build a brand-new runtime (fresh instanceId → its own broker/socket/pi) and connect it.
  async createRuntime(cwd: string): Promise<SessionRuntime | undefined> {
    const rt: SessionRuntime = {
      id: randomUUID(),
      client: undefined,
      cwd,
      sessionFile: undefined,
      isRunning: false,
      pendingUiRequest: undefined,
      disposables: [],
    };
    this.runtimes.set(rt.id, rt);
    if (!await this.createClientForRuntime(rt)) {
      this.runtimes.delete(rt.id);
      return undefined;
    }
    return rt;
  }

  // (Re)connect a runtime's client, wiring per-runtime listeners that each capture `rt`.
  // Used both for a brand-new runtime and to revive a warm stub (same instanceId → same broker).
  private async createClientForRuntime(rt: SessionRuntime): Promise<boolean> {
    let runtime;
    try {
      runtime = await resolvePiRuntime(this.context);
    } catch (error) {
      this.reportRuntimeError(error);
      return false;
    }
    void this.warnOnVersionMismatch(runtime);
    const config = this.getConfiguration();
    const bundledArgs = await this.bundled.computeArgs(runtime, rt.cwd);
    const client = new PiRpcClient({
      piPath: runtime.piEntry,
      launchKind: runtime.launchKind,
      nodePath: runtime.nodePath,
      runAsNode: runtime.runAsNode,
      cwd: rt.cwd,
      persistSessions: config.persistSessions,
      extraArgs: [...bundledArgs, ...config.extraArgs],
      brokerScriptPath: vscode.Uri.joinPath(this.context.extensionUri, "out", "piBroker.js").fsPath,
      brokerStoragePath: this.context.globalStorageUri.fsPath,
      brokerIdleTimeoutMs: config.brokerIdleTimeoutMinutes * 60 * 1000,
      instanceId: rt.id,
    });

    rt.disposables.push(
      client.onEvent((event) => this.events.handleRpcEvent(rt, event)),
      // Background runtimes never write to the single webview — only the active one does.
      client.onStderr((text) => { if (rt.id === this.activeRuntimeId) this.presenter.post({ type: "stderr", text }); }),
      client.onError((error) => { if (rt.id === this.activeRuntimeId) this.presenter.postSystem(`Pi RPC error: ${error.message}`); }),
      client.onReconnecting(() => { if (rt.id === this.activeRuntimeId) this.presenter.postConnection("reconnecting"); }),
      client.onReconnected(() => { if (rt.id === this.activeRuntimeId) void this.resync(); }),
      client.onClose(({ code, signal }) => this.handleRuntimeClose(rt, code, signal)),
    );

    client.start();
    rt.client = client;
    return true;
  }

  async reviveRuntime(rt: SessionRuntime): Promise<boolean> {
    if (rt.client?.isStarted) return true;
    return this.createClientForRuntime(rt);
  }

  // A system/configured pi may be any version; warn ONCE per window when its major.minor
  // differs from the pinned, tested one. Advisory only — the launch is never blocked
  // (user-installed pi keeps precedence by design).
  private versionWarned = false;
  private async warnOnVersionMismatch(runtime: PiRuntime): Promise<void> {
    if (this.versionWarned || runtime.source === "bundled") return;
    const version = await detectPiVersion(runtime);
    if (!version || this.versionWarned) return;
    const [major, minor] = version.split(".");
    const [pinnedMajor, pinnedMinor] = PINNED_PI_VERSION.split(".");
    if (major === pinnedMajor && minor === pinnedMinor) return;
    this.versionWarned = true;
    this.presenter.postSystem(
      `Pi ${version} detected; this extension is tested against ${PINNED_PI_VERSION}. ` +
        `If something looks off, set pi-for-vscode.useBundledPi to "always".`,
    );
  }

  // Switching away: a still-running background session stays connected so we observe its
  // completion; an idle one drops its client so its broker idle-reaps the pi (warm window).
  handleSwitchAway(rt: SessionRuntime): void {
    if (rt.isRunning) return;
    this.disconnectRuntime(rt);
  }

  // Drop the live connection but keep a lightweight stub (id/sessionFile) in the map.
  // The detached broker, now client-less and idle, reaps its pi after brokerIdleTimeoutMs.
  private disconnectRuntime(rt: SessionRuntime): void {
    for (const disposable of rt.disposables.splice(0)) disposable.dispose();
    rt.client?.dispose();
    rt.client = undefined;
    rt.isRunning = false;
  }

  private dropRuntime(rt: SessionRuntime): void {
    this.disconnectRuntime(rt);
    this.runtimes.delete(rt.id);
    if (this.activeRuntimeId === rt.id) this.activeRuntimeId = undefined;
  }

  // Fully remove a runtime, asking its broker to shut down now (used for foreign-workspace
  // state, failed spawns, and deletes). Generalizes the old shutdownCurrentBroker().
  async reapRuntime(rt: SessionRuntime): Promise<void> {
    for (const disposable of rt.disposables.splice(0)) disposable.dispose();
    const client = rt.client;
    rt.client = undefined;
    this.runtimes.delete(rt.id);
    if (this.activeRuntimeId === rt.id) this.activeRuntimeId = undefined;
    // The runtime is gone for good — let the webview forget its cached view too.
    this.presenter.post({ type: "dropSession", sessionId: rt.id });
    if (client?.isStarted) {
      await client.request({ type: "broker_shutdown" }, 5_000).catch(() => undefined);
    }
    client?.dispose();
  }

  async reapAllRuntimes(): Promise<void> {
    const all = [...this.runtimes.values()];
    await Promise.all(all.map((rt) => this.reapRuntime(rt)));
  }

  // Close one open session tab. This is intentionally immediate from the user's point of
  // view: the webview already removed the visual tab optimistically; the host now reaps the
  // runtime. The on-disk session file survives and remains reopenable from History.
  // Returns false when no runtime remains — the caller starts a fresh session so the strip
  // always shows at least one tab (Chrome-style).
  async closeRuntime(id: string, preferredNextId?: string): Promise<boolean> {
    const rt = this.runtimes.get(id);
    if (!rt) return true;
    const wasActive = this.activeRuntimeId === rt.id;
    await this.reapRuntime(rt);
    if (!wasActive) {
      await this.postSessionList();
      return true;
    }
    const remaining = [...this.runtimes.keys()];
    const nextId = preferredNextId && this.runtimes.has(preferredNextId) ? preferredNextId : remaining[remaining.length - 1];
    if (!nextId) return false;
    await this.activateRuntime(nextId); // posts activate + refreshes the session list
    return true;
  }

  // A background runtime finished its turn: drop its client so the broker idle-reaps the
  // pi. Deferred so we don't dispose the firing event emitter mid-dispatch; re-checked at
  // fire time in case the user re-activated it or it started another turn.
  onBackgroundRuntimeFinished(rt: SessionRuntime): void {
    setTimeout(() => {
      if (this.runtimes.get(rt.id) === rt && !rt.isRunning && rt.id !== this.activeRuntimeId) {
        this.disconnectRuntime(rt);
        void this.postSessionList();
      }
    }, 0);
  }

  private handleRuntimeClose(rt: SessionRuntime, code: number | null, signal: NodeJS.Signals | null): void {
    rt.isRunning = false;
    const isActive = rt.id === this.activeRuntimeId;
    this.presenter.post({ type: "running", sessionId: rt.id, value: false });
    if (isActive) {
      // Reached only when pi's process died or reconnection was exhausted.
      this.presenter.postConnection("disconnected");
      if (code !== null || signal !== null) {
        this.presenter.postSystem(`Pi background process closed (${code ?? "null"}${signal ? `, ${signal}` : ""}).`);
      }
    } else {
      void this.postSessionList();
    }
    // Tear the dead client down to a stub (a later activation respawns from disk). Deferred
    // so we don't dispose the emitter that is currently firing this very onClose listener.
    setTimeout(() => {
      if (this.runtimes.get(rt.id) !== rt) return;
      for (const disposable of rt.disposables.splice(0)) disposable.dispose();
      rt.client?.dispose();
      rt.client = undefined;
    }, 0);
  }

  private async isForeignWorkspaceState(state: Record<string, unknown>, cwd: string): Promise<boolean> {
    const sessionFile = readSessionFile(state);
    if (!sessionFile) return false;
    const sessionCwd = await readPiSessionCwd(sessionFile);
    return Boolean(sessionCwd && !samePath(sessionCwd, cwd));
  }

  // Fetches pi's current state with no side effects; resolves to undefined on any failure.
  async requestState(client: PiRpcClient): Promise<Record<string, unknown> | undefined> {
    const response = await client.request({ type: "get_state" }, 10_000).catch(() => undefined);
    if (!response || response.success === false) return undefined;
    return asRecord(response.data);
  }

  async getClientState(rt: SessionRuntime): Promise<Record<string, unknown> | undefined> {
    if (!rt.client) return undefined;
    const state = await this.requestState(rt.client);
    rt.sessionFile = readSessionFile(state);
    return state;
  }

  reportRuntimeError(error: unknown): void {
    if (error instanceof PiNotInstalledError || error instanceof NodeTooOldError) {
      this.presenter.postSystem(error.message);
    } else {
      this.presenter.postSystem(`Failed to start Pi: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Posts the active runtime's pi state to the webview, tagged so it lands on the active
  // session's view. Returns the state record (callers read isStreaming etc.).
  async postState(): Promise<Record<string, unknown> | undefined> {
    if (!this.presenter.hasView()) return undefined;
    const rt = this.active;
    const sessionId = rt?.id ?? "";
    const workspaceName = getWorkspaceName(rt?.client?.isStarted ? rt.cwd : undefined);
    if (!rt?.client?.isStarted) {
      const state = { isStreaming: false, sessionFile: undefined, model: undefined, workspaceName };
      this.presenter.post({ type: "state", sessionId, state });
      return state;
    }

    try {
      const response = await rt.client.request({ type: "get_state" }, 10_000);
      if (response.success === false) return undefined;
      const data = response.data && typeof response.data === "object" ? { ...(response.data as object), workspaceName } : { workspaceName };
      const state = asRecord(data);
      if (state && rt.cwd && state.isStreaming !== true && await this.isForeignWorkspaceState(state, rt.cwd)) {
        await this.reapRuntime(rt);
        return this.postState();
      }
      rt.sessionFile = readSessionFile(state);
      this.presenter.post({ type: "state", sessionId: rt.id, state: data });
      return state;
    } catch {
      // Ignore state refresh failures during startup/shutdown.
      return undefined;
    }
  }

  setRunning(rt: SessionRuntime, value: boolean): void {
    rt.isRunning = value;
    // Tagged so it updates the right session's view (active or background). Background
    // running also drives the session-list badge.
    this.presenter.post({ type: "running", sessionId: rt.id, value });
    if (rt.id !== this.activeRuntimeId) void this.postSessionList();
    // Turn ended → a refresh deferred because the runtime was busy can now run.
    if (!value) this.settledHook?.(rt);
  }

  // Re-sync the active session to pi's authoritative state after a transport drop: re-seed
  // its view (state + full message list) and drive the connection banner. The interrupted
  // turn is NOT auto-resent — the user continues from the synced view.
  async resync(): Promise<void> {
    const rt = this.active;
    if (!rt?.client?.isStarted) {
      this.presenter.postConnection("disconnected");
      return;
    }
    try {
      await this.seedRuntime(rt, true);
      this.presenter.post({ type: "activate", sessionId: rt.id });
      this.presenter.postConnection("connected");
    } catch {
      this.presenter.postConnection("disconnected");
    }
  }

  // Wake / view-visible nudge: verify the active runtime's link is alive; a dead socket
  // triggers the client's own reconnect (→ banner + resync). No-op when no active client.
  probeConnection(): void {
    this.active?.client?.probe();
  }

  // Manual recovery from the disconnected banner's Retry button: rebuild the active runtime
  // if needed and resync. ensureActiveRuntime reuses a live broker or relaunches one.
  async forceReconnect(): Promise<void> {
    this.presenter.postConnection("reconnecting");
    const rt = await this.ensureActiveRuntime();
    if (rt?.client) await this.resync();
    else this.presenter.postConnection("disconnected");
  }

  getConfiguration(): PiConfiguration {
    const config = vscode.workspace.getConfiguration("pi-for-vscode");
    return {
      extraArgs: config.get<string[]>("extraArgs", []),
      persistSessions: config.get<boolean>("persistSessions", true),
      defaultStreamingBehavior: config.get<"followUp" | "steer">("defaultStreamingBehavior", "steer"),
      brokerIdleTimeoutMinutes: config.get<number>("brokerIdleTimeoutMinutes", 30),
    };
  }

  isCurrentWorkspaceSession(sessionPath: string): Promise<boolean> {
    const cwd = getWorkspaceCwd();
    return Promise.resolve(cwd ? isPiSessionInWorkspace(sessionPath, cwd) : false).then(Boolean);
  }

  // Best-effort teardown on extension dispose: ask each detached broker to shut down so no
  // orphaned pi outlives the host (Claude-style: process dies on reload, resume from disk).
  disposeAll(): void {
    for (const rt of this.runtimes.values()) {
      for (const disposable of rt.disposables.splice(0)) disposable.dispose();
      rt.client?.disposeAndShutdownBroker();
      rt.client = undefined;
    }
    this.runtimes.clear();
    this.activeRuntimeId = undefined;
  }
}
