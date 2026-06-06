import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { PiRpcClient } from "./piRpcClient";
import { NodeTooOldError, PiNotInstalledError, repairBundledPi, resolvePiRuntime } from "./piResolver";
import type { CommandListItem, ExtensionToWebviewMessage, ImageAttachment, ModelListItem, PiRpcMessage, WebviewToExtensionMessage } from "./protocol";
import { deleteSession, isPiSessionInWorkspace, listPiSessions, readPiSessionCwd, renameSession, type PiSessionSummary } from "./sessionStore";
import { asRecord, toSessionListItem, toSessionQuickPickItem, type SessionQuickPickItem } from "./sessionFormat";
import { listPiModels, PROVIDER_ENV_VARS, type PiModel } from "./modelStore";
import { getChatHtml } from "./webviewHtml";
import { getWorkspaceCwd, getWorkspaceName, samePath } from "./workspace";

const VIEW_ID = "pi-for-vscode.chat";

// globalState / SecretStorage keys for model selection + BYOK.
const SELECTED_MODEL_KEY = "pi-for-vscode.selectedModel";
const PROVIDER_KEY_ENV_VARS_KEY = "pi-for-vscode.providerKeyEnvVars";
const SECRET_PREFIX = "pi-for-vscode.apiKey.";
const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

// Pulls the `sessionFile` path out of a pi state record, guarding the loose `unknown` shape.
function readSessionFile(state: Record<string, unknown> | undefined): string | undefined {
  return typeof state?.sessionFile === "string" ? state.sessionFile : undefined;
}

// Short provenance badge for a command, mirroring pi's own getAutocompleteSourceTag:
// scope prefix (user→u / project→p / else→t), then the package source for npm installs.
// Git URLs collapse to the bare scope prefix here (full git formatting is omitted as it's
// a rare case for slash commands and the badge is only a hint).
function buildSourceTag(sourceInfo: Record<string, unknown> | undefined): string | undefined {
  if (!sourceInfo) return undefined;
  const scope = sourceInfo.scope;
  const prefix = scope === "user" ? "u" : scope === "project" ? "p" : "t";
  const source = typeof sourceInfo.source === "string" ? sourceInfo.source.trim() : "";
  if (source.startsWith("npm:")) return `${prefix}:${source}`;
  return prefix;
}

interface PiConfiguration {
  extraArgs: string[];
  persistSessions: boolean;
  defaultStreamingBehavior: "followUp" | "steer";
  brokerIdleTimeoutMinutes: number;
}

// One independent Pi execution context. Each running session gets its own runtime,
// which owns its own broker socket + `pi --mode rpc` process. The client is connected
// only while the runtime is ACTIVE or RUNNING; a background+idle runtime drops its
// client and survives as a stub (id/sessionFile/model) so its detached broker idle-reaps
// the pi and a later activation can reattach (warm) or respawn from disk (cold).
interface SessionRuntime {
  readonly id: string;
  client?: PiRpcClient;
  cwd: string;
  sessionFile?: string;
  isRunning: boolean;
  model?: string;
  pendingUiRequest?: PiRpcMessage;
  readonly disposables: vscode.Disposable[];
}

export class PiChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private readonly runtimes = new Map<string, SessionRuntime>();
  private activeRuntimeId?: string;
  private readonly webviewDisposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {}

  private get active(): SessionRuntime | undefined {
    return this.activeRuntimeId ? this.runtimes.get(this.activeRuntimeId) : undefined;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.disposeWebviewListeners();
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    webviewView.webview.html = getChatHtml(webviewView.webview, this.context.extensionUri);

    this.webviewDisposables.push(
      webviewView.webview.onDidReceiveMessage((message) => this.handleWebviewMessage(message as WebviewToExtensionMessage)),
      // View revealed again (sidebar reopened / tab refocused) — verify the link.
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) this.probeConnection();
      }),
    );

    void this.postState();
  }

  async open(): Promise<void> {
    await vscode.commands.executeCommand("workbench.view.extension.pi-for-vscode");
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
  }

  // New Session is a genuinely new execution unit: spawn a fresh runtime so any
  // previously-active (and possibly still-running) session keeps its own pi alive.
  async newSession(): Promise<void> {
    const cwd = getWorkspaceCwd();
    if (!cwd) {
      this.postSystem("Open a workspace folder to start a project-scoped Pi session.");
      return;
    }
    const previous = this.active;
    const rt = await this.createRuntime(cwd);
    if (!rt?.client) return;

    const response = await rt.client.request({ type: "new_session" });
    if (response.success === false) {
      this.postSystem(`Failed to start a new session: ${String(response.error ?? "unknown error")}`);
      await this.reapRuntime(rt);
      return;
    }
    const data = asRecord(response.data);
    if (data?.cancelled === true) {
      await this.reapRuntime(rt);
      return;
    }

    this.activeRuntimeId = rt.id;
    if (previous && previous !== rt) this.handleSwitchAway(previous);
    this.setRunning(rt, false);
    this.post({ type: "reset" });
    await this.postState();
    await this.postSessionList();
  }

  async sessions(): Promise<void> {
    await this.open();
    const cwd = getWorkspaceCwd();
    if (!cwd) {
      this.postSystem("Open a workspace folder to view project-scoped Pi sessions.");
      return;
    }
    const summaries = await this.collectSessions();

    const items: SessionQuickPickItem[] = [
      {
        label: "$(add) New Session",
        description: "Start a fresh Pi session",
        action: "new",
      },
      ...summaries.map((summary) => toSessionQuickPickItem(summary, cwd)),
    ];

    const picked = await vscode.window.showQuickPick(items, {
      title: "Pi Sessions",
      placeHolder: summaries.length > 0 ? "Select a session to resume" : "No saved sessions found for this workspace yet",
      matchOnDescription: true,
      matchOnDetail: true,
    });

    if (!picked) return;
    if (picked.action === "new") {
      await this.newSession();
      return;
    }
    if (picked.sessionPath) await this.switchSession(picked.sessionPath);
  }

  // Stop only the session the user is looking at. Background runtimes keep running.
  async stop(): Promise<void> {
    const rt = this.active;
    if (!rt?.client?.isStarted) return;
    this.setRunning(rt, false);
    const response = await rt.client.request({ type: "abort" });
    if (response.success === false) {
      this.postSystem(`Failed to abort: ${String(response.error ?? "unknown error")}`);
      return;
    }
    void this.postState();
  }

  async repairAgent(): Promise<void> {
    await this.open();
    await this.reapAllRuntimes();
    try {
      const entry = await repairBundledPi(this.context);
      this.postSystem(`Reinstalled the bundled Pi agent at ${entry}.`);
      void this.postState();
    } catch (error) {
      this.reportRuntimeError(error);
    }
  }

  dispose(): void {
    this.disposeWebviewListeners();
    // Best-effort: ask each detached broker to shut down so no orphaned pi outlives
    // the host (Claude-style: process dies on reload, resume from the on-disk transcript).
    for (const rt of this.runtimes.values()) {
      for (const disposable of rt.disposables.splice(0)) disposable.dispose();
      rt.client?.disposeAndShutdownBroker();
      rt.client = undefined;
    }
    this.runtimes.clear();
    this.activeRuntimeId = undefined;
  }

  private async handleWebviewMessage(message: WebviewToExtensionMessage): Promise<void> {
    try {
      switch (message.type) {
        case "ready": {
          const rt = await this.ensureActiveRuntime();
          const webviewSessionFile = message.sessionFile;
          // Resume the session the user was last viewing (Claude-style resume-from-disk):
          // after a reload the fresh broker cold-starts on pi's default session, so steer
          // it back to the remembered one. A still-live runtime is already on it → no-op.
          if (rt?.client?.isStarted && webviewSessionFile && await this.isCurrentWorkspaceSession(webviewSessionFile)) {
            const loaded = readSessionFile(await this.requestState(rt.client));
            if (!samePath(loaded, webviewSessionFile)) {
              const response = await rt.client.request({ type: "switch_session", sessionPath: webviewSessionFile }, 30_000).catch(() => undefined);
              if (response && response.success !== false) rt.sessionFile = webviewSessionFile;
            }
          }
          const state = await this.postState();
          const currentSessionFile = readSessionFile(state);
          const hasSessionMismatch = Boolean((currentSessionFile || webviewSessionFile) && !samePath(currentSessionFile, webviewSessionFile));
          if (!message.hasMessages || hasSessionMismatch) await this.hydrateSessionMessages(true, state?.isStreaming === true);
          return;
        }
        case "prompt":
          await this.prompt(message.text, message.images);
          return;
        case "abort":
          await this.stop();
          return;
        case "newSession":
          await this.newSession();
          return;
        case "sessions":
          await this.sessions();
          return;
        case "requestSessions":
          await this.postSessionList();
          return;
        case "switchSession":
          await this.switchSession(message.sessionPath);
          return;
        case "deleteSession":
          await this.deleteSession(message.sessionPath);
          return;
        case "renameSession":
          await this.renameSession(message.sessionPath, message.name);
          return;
        case "requestModels":
          await this.postModelList();
          return;
        case "requestCommands":
          await this.postCommandList();
          return;
        case "setModel":
          await this.setModel(message.modelId);
          return;
        case "setThinkingLevel":
          await this.setThinkingLevel(message.level);
          return;
        case "addProviderKey":
          await this.addProviderKey();
          return;
        case "getState":
          await this.postState();
          return;
        case "copy":
          await vscode.env.clipboard.writeText(message.text ?? "");
          return;
        case "wake":
          this.probeConnection();
          return;
        case "reconnect":
          await this.forceReconnect();
          return;
        case "extensionUiResponse": {
          // The request is only ever shown for the active runtime, so the response
          // routes back to the active runtime's pi (the one that raised it).
          this.active?.client?.send(message.response as PiRpcMessage);
          return;
        }
      }
    } catch (error) {
      this.postSystem(error instanceof Error ? error.message : String(error));
    }
  }

  private async prompt(text: string, images?: ImageAttachment[]): Promise<void> {
    const trimmed = text.trim();
    const imageBlocks = this.toPiImageBlocks(images);
    if (!trimmed && imageBlocks.length === 0) return;

    const rt = await this.ensureActiveRuntime();
    if (!rt?.client) return;

    const command: PiRpcMessage = { type: "prompt", message: trimmed };
    if (imageBlocks.length > 0) command.images = imageBlocks;
    if (rt.isRunning) {
      command.streamingBehavior = this.getConfiguration().defaultStreamingBehavior;
    }

    const response = await rt.client.request(command);
    if (response.success === false) {
      this.postSystem(`Prompt rejected: ${String(response.error ?? "unknown error")}`);
    }
  }

  private toPiImageBlocks(images: ImageAttachment[] | undefined): PiRpcMessage[] {
    if (!Array.isArray(images)) return [];
    const blocks: PiRpcMessage[] = [];
    for (const image of images) {
      const data = typeof image?.data === "string" ? image.data.trim() : "";
      const mimeType = typeof image?.mimeType === "string" ? image.mimeType.trim().toLowerCase() : "";
      if (!data || !SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) continue;
      blocks.push({ type: "image", data, mimeType });
    }
    return blocks;
  }

  // Switching is "change what's visible", never "stop/reuse the executor":
  //   1. already active → just refresh.
  //   2. a live (or warm-stub) runtime already owns the session → activate it.
  //   3. otherwise spawn a fresh runtime and load the file into it.
  // It never blocks on the current session being busy — that session keeps running.
  private async switchSession(sessionPath: string): Promise<void> {
    if (!await this.isCurrentWorkspaceSession(sessionPath)) {
      this.postSystem("That session belongs to a different workspace and cannot be opened from this project.");
      await this.postSessionList();
      return;
    }

    if (samePath(sessionPath, this.active?.sessionFile)) {
      await this.postState();
      await this.hydrateSessionMessages(true, this.active?.isRunning === true);
      return;
    }

    const existing = this.findRuntimeBySessionFile(sessionPath);
    if (existing) {
      await this.activateRuntime(existing.id);
      return;
    }

    const cwd = getWorkspaceCwd();
    if (!cwd) {
      this.postSystem("Open a workspace folder to start a project-scoped Pi session.");
      return;
    }
    const previous = this.active;
    const rt = await this.createRuntime(cwd);
    if (!rt?.client) return;

    const response = await rt.client.request({ type: "switch_session", sessionPath }, 30_000);
    if (response.success === false) {
      this.postSystem(`Failed to switch session: ${String(response.error ?? "unknown error")}`);
      await this.reapRuntime(rt);
      return;
    }
    const data = asRecord(response.data);
    if (data?.cancelled === true) {
      await this.reapRuntime(rt);
      return;
    }

    this.activeRuntimeId = rt.id;
    if (previous && previous !== rt) this.handleSwitchAway(previous);
    rt.sessionFile = sessionPath;
    this.setRunning(rt, false);
    this.post({ type: "reset" });
    await this.postState();
    await this.hydrateSessionMessages(true);
    await this.postSessionList();
  }

  // Attach the single UI to an existing runtime's live pi. Reuses the resync/hydrate
  // flow (postState + get_messages + derive running from isStreaming), so a mid-turn
  // background session renders its current live state — no saved-history preview.
  private async activateRuntime(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt) return;

    const previous = this.active;
    this.activeRuntimeId = id;
    if (previous && previous !== rt) this.handleSwitchAway(previous);

    if (!rt.client?.isStarted) {
      if (!await this.reviveRuntime(rt)) return;
      // A cold revive may have relaunched a fresh broker whose pi has no session yet;
      // a warm reattach lands on the live pi already on this session. Load if needed.
      if (rt.sessionFile && rt.client) {
        const state = await this.requestState(rt.client);
        if (!samePath(readSessionFile(state), rt.sessionFile)) {
          await rt.client.request({ type: "switch_session", sessionPath: rt.sessionFile }, 30_000).catch(() => undefined);
        }
      }
    }

    this.post({ type: "reset" });
    await this.syncActive(false);

    // Replay any UI request buffered while this runtime was in the background, now
    // that it owns the webview. The response routes back to it via extensionUiResponse.
    if (rt.pendingUiRequest) {
      this.post({ type: "extensionUiRequest", request: rt.pendingUiRequest });
      rt.pendingUiRequest = undefined;
    }
    await this.postSessionList();
  }

  private findRuntimeBySessionFile(sessionPath: string): SessionRuntime | undefined {
    for (const rt of this.runtimes.values()) {
      if (rt.sessionFile && samePath(rt.sessionFile, sessionPath)) return rt;
    }
    return undefined;
  }

  // Returns the pi state fetched via postState() so callers (resync/syncActive) can read
  // isStreaming without a second get_state round-trip.
  private async hydrateSessionMessages(force = false, allowWhileRunning = false): Promise<Record<string, unknown> | undefined> {
    const rt = this.active;
    if (!rt?.client?.isStarted) return undefined;
    if (rt.isRunning && !allowWhileRunning) return undefined;

    const state = await this.postState();
    const response = await rt.client.request({ type: "get_messages" }, 10_000).catch(() => undefined);
    if (!response || response.success === false || (rt.isRunning && !allowWhileRunning)) return state;

    const data = asRecord(response.data);
    const messages = Array.isArray(data?.messages) ? data.messages : [];
    this.post({ type: "sessionMessages", messages, force });
    return state;
  }

  private async postSessionList(): Promise<void> {
    const summaries = await this.collectSessions();
    this.post({ type: "sessionList", sessions: summaries.map((summary) => toSessionListItem(summary, this.runtimeFlagsFor(summary.filePath))) });
  }

  // Liveness flags for the session-list badges, sourced from the runtime map.
  private runtimeFlagsFor(filePath: string): { isRunning?: boolean; needsInput?: boolean } | undefined {
    const rt = this.findRuntimeBySessionFile(filePath);
    if (!rt) return undefined;
    return { isRunning: rt.isRunning, needsInput: rt.pendingUiRequest !== undefined };
  }

  private async deleteSession(sessionPath: string): Promise<void> {
    if (!await this.isCurrentWorkspaceSession(sessionPath)) {
      this.postSystem("That session belongs to a different workspace and cannot be deleted from this project.");
      await this.postSessionList();
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      "Delete this Pi session? This permanently removes its saved history and cannot be undone.",
      { modal: true },
      "Delete",
    );
    if (confirm !== "Delete") return;
    // Tear down any live runtime holding this session before unlinking its file.
    const rt = this.findRuntimeBySessionFile(sessionPath);
    if (rt) await this.reapRuntime(rt);
    try {
      await deleteSession(sessionPath);
    } catch (error) {
      this.postSystem(`Failed to delete session: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.postSessionList();
  }

  private async renameSession(sessionPath: string, name: string): Promise<void> {
    if (!await this.isCurrentWorkspaceSession(sessionPath)) {
      this.postSystem("That session belongs to a different workspace and cannot be renamed from this project.");
      await this.postSessionList();
      return;
    }

    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      // When the active runtime's pi has this session loaded, route the rename through
      // its RPC so pi's in-memory session name (what get_state returns) updates too.
      // Writing the file directly behind a running broker leaves pi unaware, so the
      // next get_state/switch_session reports the stale name and the rename "reverts".
      const renamedViaPi = await this.renameActiveSessionViaPi(sessionPath, trimmed);
      if (!renamedViaPi) await renameSession(sessionPath, trimmed);
      if (samePath(sessionPath, this.active?.sessionFile)) await this.postState();
    } catch (error) {
      this.postSystem(`Failed to rename session: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.postSessionList();
  }

  // Rename via pi's set_session_name RPC when the active runtime is the live owner of
  // this session. Returns false otherwise (caller falls back to a direct file write).
  // Throws if pi rejects the rename.
  private async renameActiveSessionViaPi(sessionPath: string, name: string): Promise<boolean> {
    const rt = this.active;
    const client = rt?.client?.isStarted ? rt.client : undefined;
    if (!rt || !client) return false;
    // Refresh the runtime's loaded-session pointer so we never RPC the wrong session.
    await this.getClientState(rt);
    if (!samePath(sessionPath, rt.sessionFile)) return false;
    const response = await client.request({ type: "set_session_name", name }, 10_000);
    if (response.success === false) {
      throw new Error(String(response.error ?? "pi rejected the rename"));
    }
    return true;
  }

  private async collectSessions(): Promise<PiSessionSummary[]> {
    const cwd = getWorkspaceCwd();
    if (!cwd) return [];
    // Use the active runtime's tracked session file for the "current" marker — no RPC,
    // so the frequent (per agent_start/agent_end) badge refresh stays cheap.
    const currentSessionFile = this.active?.sessionFile;
    return listPiSessions({ cwd, currentSessionFile });
  }

  private async isCurrentWorkspaceSession(sessionPath: string): Promise<boolean> {
    const cwd = getWorkspaceCwd();
    return Boolean(cwd && await isPiSessionInWorkspace(sessionPath, cwd));
  }

  // ---- model selection (picker + BYOK + subscription) ----

  private async postModelList(): Promise<void> {
    let runtime;
    try {
      runtime = await resolvePiRuntime(this.context);
    } catch (error) {
      this.reportRuntimeError(error);
      this.post({ type: "modelList", models: [] });
      return;
    }
    const cwd = getWorkspaceCwd();
    const secrets = await this.getSecretsEnv();
    const models = await listPiModels(runtime, { cwd, secrets });
    const currentRef = await this.currentModelRef();
    const items: ModelListItem[] = models.map((model) => ({
      id: model.id,
      model: model.model,
      provider: model.provider,
      thinking: model.thinking,
      isCurrent: this.isCurrentModel(model, currentRef),
    }));
    this.post({ type: "modelList", models: items });
  }

  // Slash-command palette source. Unlike postModelList (which spawns `pi --list-models`),
  // commands come from the active runtime's live session over the RPC client.
  private async postCommandList(): Promise<void> {
    const rt = await this.ensureActiveRuntime();
    if (!rt?.client) {
      this.post({ type: "commandList", commands: [] });
      return;
    }
    const response = await rt.client.request({ type: "get_commands" }, 10_000).catch(() => undefined);
    if (!response || response.success === false) {
      this.post({ type: "commandList", commands: [] });
      return;
    }
    const data = asRecord(response.data);
    const raw = Array.isArray(data?.commands) ? data.commands : [];
    const commands: CommandListItem[] = [];
    for (const entry of raw) {
      const record = asRecord(entry);
      if (!record || typeof record.name !== "string") continue;
      const source = record.source === "skill" || record.source === "prompt" ? record.source : "extension";
      const sourceInfo = asRecord(record.sourceInfo);
      const scope = sourceInfo?.scope === "user" || sourceInfo?.scope === "project" || sourceInfo?.scope === "temporary"
        ? sourceInfo.scope
        : undefined;
      commands.push({
        name: record.name,
        description: typeof record.description === "string" ? record.description : "",
        source,
        scope,
        sourceTag: buildSourceTag(sourceInfo),
      });
    }
    this.post({ type: "commandList", commands });
  }

  private async setModel(modelId: string): Promise<void> {
    if (!modelId) return;
    const rt = await this.ensureActiveRuntime();
    if (!rt?.client) return;

    // Capture the active session so we can restore it after this runtime's pi restarts.
    const sessionFile = readSessionFile(await this.requestState(rt.client));

    const secrets = await this.getSecretsEnv();
    const response = await rt.client.request({ type: "set_model", model: modelId, secrets }, 30_000);
    if (response.success === false) {
      this.postSystem(`Failed to switch model: ${String(response.error ?? "unknown error")}`);
      return;
    }
    // Per-runtime model — set_model only restarts THIS runtime's broker's pi, so other
    // sessions are unaffected. The global key is just the default seed for new runtimes.
    rt.model = modelId;
    await this.context.globalState.update(SELECTED_MODEL_KEY, modelId);

    this.setRunning(rt, false);
    if (sessionFile && await this.isCurrentWorkspaceSession(sessionFile)) {
      await rt.client.request({ type: "switch_session", sessionPath: sessionFile }, 30_000).catch(() => undefined);
    }
    await this.postState();
    await this.hydrateSessionMessages(true);
  }

  private async setThinkingLevel(level: string): Promise<void> {
    const trimmed = level.trim().toLowerCase();
    if (!THINKING_LEVELS.has(trimmed)) return;

    const rt = await this.ensureActiveRuntime();
    if (!rt?.client) return;

    const response = await rt.client.request({ type: "set_thinking_level", level: trimmed }, 10_000);
    if (response.success === false) {
      this.postSystem(`Failed to change thinking level: ${String(response.error ?? "unknown error")}`);
      return;
    }
    await this.postState();
  }

  private async addProviderKey(): Promise<void> {
    const providers = Object.keys(PROVIDER_ENV_VARS).sort();
    const provider = await vscode.window.showQuickPick(providers, {
      title: "Add Provider API Key",
      placeHolder: "Select the provider whose API key you want to add (BYOK)",
    });
    if (!provider) return;
    const envVar = PROVIDER_ENV_VARS[provider];
    const key = await vscode.window.showInputBox({
      title: `${provider} API key`,
      prompt: `Stored securely in VS Code; passed to pi as ${envVar}.`,
      password: true,
      ignoreFocusOut: true,
    });
    if (!key || !key.trim()) return;

    await this.context.secrets.store(SECRET_PREFIX + envVar, key.trim());
    const names = this.context.globalState.get<string[]>(PROVIDER_KEY_ENV_VARS_KEY, []);
    if (!names.includes(envVar)) {
      await this.context.globalState.update(PROVIDER_KEY_ENV_VARS_KEY, [...names, envVar]);
    }
    this.postSystem(`Saved ${provider} API key. Pick one of its models to start using it.`);
    await this.postModelList();
  }

  private async getSecretsEnv(): Promise<Record<string, string>> {
    const names = this.context.globalState.get<string[]>(PROVIDER_KEY_ENV_VARS_KEY, []);
    const out: Record<string, string> = {};
    for (const name of names) {
      const value = await this.context.secrets.get(SECRET_PREFIX + name);
      if (value) out[name] = value;
    }
    return out;
  }

  private async currentModelRef(): Promise<string | undefined> {
    // Prefer the active session's own model so the picker's current marker reflects
    // what the visible session is using, not just the global default.
    const activeModel = this.active?.model;
    if (activeModel) return activeModel;
    const stored = this.context.globalState.get<string>(SELECTED_MODEL_KEY);
    if (stored) return stored;
    const client = this.active?.client;
    if (!client?.isStarted) return undefined;
    const state = await this.requestState(client);
    const model = asRecord(state?.model);
    if (typeof model?.id === "string") return model.id;
    if (typeof model?.name === "string") return model.name;
    return undefined;
  }

  private isCurrentModel(model: PiModel, ref: string | undefined): boolean {
    if (!ref) return false;
    const r = ref.toLowerCase();
    return model.id.toLowerCase() === r || model.model.toLowerCase() === r || model.id.toLowerCase().endsWith("/" + r);
  }

  // ---- runtime lifecycle ----

  // Returns a usable active runtime, creating one when there is none (first prompt /
  // command palette / view ready). Reuses the existing active runtime, shutting it down
  // only when its loaded session belongs to a different workspace (foreign-state guard).
  private async ensureActiveRuntime(): Promise<SessionRuntime | undefined> {
    const cwd = getWorkspaceCwd();
    if (!cwd) {
      this.postSystem("Open a workspace folder to start a project-scoped Pi session.");
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
  private async createRuntime(cwd: string, model?: string): Promise<SessionRuntime | undefined> {
    const rt: SessionRuntime = {
      id: randomUUID(),
      client: undefined,
      cwd,
      sessionFile: undefined,
      isRunning: false,
      model: model ?? (this.context.globalState.get<string>(SELECTED_MODEL_KEY) || undefined),
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
    const config = this.getConfiguration();
    const client = new PiRpcClient({
      piPath: runtime.piEntry,
      launchKind: runtime.launchKind,
      nodePath: runtime.nodePath,
      runAsNode: runtime.runAsNode,
      cwd: rt.cwd,
      persistSessions: config.persistSessions,
      extraArgs: config.extraArgs,
      model: rt.model ?? (this.context.globalState.get<string>(SELECTED_MODEL_KEY) || undefined),
      secrets: await this.getSecretsEnv(),
      brokerScriptPath: vscode.Uri.joinPath(this.context.extensionUri, "out", "piBroker.js").fsPath,
      brokerStoragePath: this.context.globalStorageUri.fsPath,
      brokerIdleTimeoutMs: config.brokerIdleTimeoutMinutes * 60 * 1000,
      instanceId: rt.id,
    });

    rt.disposables.push(
      client.onEvent((event) => this.handleRpcEvent(rt, event)),
      // Background runtimes never write to the single webview — only the active one does.
      client.onStderr((text) => { if (rt.id === this.activeRuntimeId) this.post({ type: "stderr", text }); }),
      client.onError((error) => { if (rt.id === this.activeRuntimeId) this.postSystem(`Pi RPC error: ${error.message}`); }),
      client.onReconnecting(() => { if (rt.id === this.activeRuntimeId) this.postConnection("reconnecting"); }),
      client.onReconnected(() => { if (rt.id === this.activeRuntimeId) void this.resync(); }),
      client.onClose(({ code, signal }) => this.handleRuntimeClose(rt, code, signal)),
    );

    client.start();
    rt.client = client;
    return true;
  }

  private async reviveRuntime(rt: SessionRuntime): Promise<boolean> {
    if (rt.client?.isStarted) return true;
    return this.createClientForRuntime(rt);
  }

  // Switching away: a still-running background session stays connected so we observe its
  // completion; an idle one drops its client so its broker idle-reaps the pi (warm window).
  private handleSwitchAway(rt: SessionRuntime): void {
    if (rt.isRunning) return;
    this.disconnectRuntime(rt);
  }

  // Drop the live connection but keep a lightweight stub (id/sessionFile/model) in the map.
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
  private async reapRuntime(rt: SessionRuntime): Promise<void> {
    for (const disposable of rt.disposables.splice(0)) disposable.dispose();
    const client = rt.client;
    rt.client = undefined;
    this.runtimes.delete(rt.id);
    if (this.activeRuntimeId === rt.id) this.activeRuntimeId = undefined;
    if (client?.isStarted) {
      await client.request({ type: "broker_shutdown" }, 5_000).catch(() => undefined);
    }
    client?.dispose();
  }

  private async reapAllRuntimes(): Promise<void> {
    const all = [...this.runtimes.values()];
    await Promise.all(all.map((rt) => this.reapRuntime(rt)));
  }

  // A background runtime finished its turn: drop its client so the broker idle-reaps the
  // pi. Deferred so we don't dispose the firing event emitter mid-dispatch; re-checked at
  // fire time in case the user re-activated it or it started another turn.
  private onBackgroundRuntimeFinished(rt: SessionRuntime): void {
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
    if (isActive) {
      // Reached only when pi's process died or reconnection was exhausted.
      this.post({ type: "running", value: false });
      this.postConnection("disconnected");
      if (code !== null || signal !== null) {
        this.postSystem(`Pi background process closed (${code ?? "null"}${signal ? `, ${signal}` : ""}).`);
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
  private async requestState(client: PiRpcClient): Promise<Record<string, unknown> | undefined> {
    const response = await client.request({ type: "get_state" }, 10_000).catch(() => undefined);
    if (!response || response.success === false) return undefined;
    return asRecord(response.data);
  }

  private async getClientState(rt: SessionRuntime): Promise<Record<string, unknown> | undefined> {
    if (!rt.client) return undefined;
    const state = await this.requestState(rt.client);
    rt.sessionFile = readSessionFile(state);
    return state;
  }

  private reportRuntimeError(error: unknown): void {
    if (error instanceof PiNotInstalledError || error instanceof NodeTooOldError) {
      this.postSystem(error.message);
    } else {
      this.postSystem(`Failed to start Pi: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private handleRpcEvent(rt: SessionRuntime, event: PiRpcMessage): void {
    const isActive = rt.id === this.activeRuntimeId;

    if (event.type === "agent_start") {
      this.setRunning(rt, true);
    } else if (event.type === "agent_end") {
      this.setRunning(rt, false);
      if (isActive) void this.postState();
      else this.onBackgroundRuntimeFinished(rt);
    } else if (event.type === "thinking_level_changed") {
      if (isActive) void this.postState();
    }

    if (event.type === "extension_ui_request") {
      if (isActive) {
        this.post({ type: "extensionUiRequest", request: event });
      } else {
        // A background pi is blocked waiting for human input it can't show. Buffer it
        // (one slot — pi blocks one at a time) and surface a needs-input badge; we never
        // auto-answer. It replays when the user activates this session.
        rt.pendingUiRequest = event;
        void this.postSessionList();
      }
      return;
    }

    // Only the active runtime drives the single webview. This replaces the old
    // isPreviewingDetachedSession() suppression: background events are dropped here.
    if (!isActive) return;
    this.post({ type: "rpcEvent", event });
  }

  private async postState(): Promise<Record<string, unknown> | undefined> {
    if (!this.view) return undefined;
    const rt = this.active;
    const workspaceName = getWorkspaceName(rt?.client?.isStarted ? rt.cwd : undefined);
    if (!rt?.client?.isStarted) {
      const state = { isStreaming: false, sessionFile: undefined, model: undefined, workspaceName };
      this.post({ type: "state", state });
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
      this.post({ type: "state", state: data });
      return state;
    } catch {
      // Ignore state refresh failures during startup/shutdown.
      return undefined;
    }
  }

  private setRunning(rt: SessionRuntime, value: boolean): void {
    rt.isRunning = value;
    // The webview running indicator reflects only the active session; a background
    // runtime's running state is surfaced through the session-list badge instead.
    if (rt.id === this.activeRuntimeId) this.post({ type: "running", value });
    else void this.postSessionList();
  }

  private postSystem(text: string): void {
    this.post({ type: "system", text });
  }

  private postConnection(status: "reconnecting" | "connected" | "disconnected"): void {
    this.post({ type: "connection", status });
  }

  private post(message: ExtensionToWebviewMessage): void {
    void this.view?.webview.postMessage(message);
  }

  // Re-sync the UI to the active runtime's authoritative pi state: refresh state + the full
  // message list and derive `running` from isStreaming, clearing a spinner left stuck when a
  // turn errored without a trailing agent_end. Used for reconnect (announce=true, drives the
  // banner) and for activating another runtime (announce=false, no banner flash). The
  // interrupted turn is NOT auto-resent — the user continues from the synced view.
  private async syncActive(announceConnection: boolean): Promise<void> {
    const rt = this.active;
    if (!rt?.client?.isStarted) {
      if (announceConnection) this.postConnection("disconnected");
      return;
    }
    try {
      // hydrateSessionMessages already does the get_state (and returns it), so this is a
      // single round-trip for both the message list and the running flag.
      const state = await this.hydrateSessionMessages(true, true);
      this.setRunning(rt, state?.isStreaming === true);
      if (announceConnection) this.postConnection("connected");
    } catch {
      if (announceConnection) this.postConnection("disconnected");
    }
  }

  private async resync(): Promise<void> {
    await this.syncActive(true);
  }

  // Wake / view-visible nudge: verify the active runtime's link is alive; a dead socket
  // triggers the client's own reconnect (→ banner + resync). No-op when no active client.
  private probeConnection(): void {
    this.active?.client?.probe();
  }

  /** VS Code window regained focus — a cheap proxy for "the machine may have woken". */
  onWindowFocused(): void {
    this.probeConnection();
  }

  // Manual recovery from the disconnected banner's Retry button: rebuild the active runtime
  // if needed and resync. ensureActiveRuntime reuses a live broker or relaunches one.
  private async forceReconnect(): Promise<void> {
    this.postConnection("reconnecting");
    const rt = await this.ensureActiveRuntime();
    if (rt?.client) await this.resync();
    else this.postConnection("disconnected");
  }

  private disposeWebviewListeners(): void {
    for (const disposable of this.webviewDisposables.splice(0)) disposable.dispose();
  }

  private getConfiguration(): PiConfiguration {
    const config = vscode.workspace.getConfiguration("pi-for-vscode");
    return {
      extraArgs: config.get<string[]>("extraArgs", []),
      persistSessions: config.get<boolean>("persistSessions", true),
      defaultStreamingBehavior: config.get<"followUp" | "steer">("defaultStreamingBehavior", "followUp"),
      brokerIdleTimeoutMinutes: config.get<number>("brokerIdleTimeoutMinutes", 30),
    };
  }
}
