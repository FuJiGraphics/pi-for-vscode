import * as vscode from "vscode";
import { PiRpcClient } from "./piRpcClient";
import { NodeTooOldError, PiNotInstalledError, repairBundledPi, resolvePiRuntime } from "./piResolver";
import type { CommandListItem, ExtensionToWebviewMessage, ImageAttachment, ModelListItem, PiRpcMessage, WebviewToExtensionMessage } from "./protocol";
import { deleteSession, isPiSessionInWorkspace, listPiSessions, readPiSessionCwd, readPiSessionMessages, renameSession, type PiSessionSummary } from "./sessionStore";
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

export class PiChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private client?: PiRpcClient;
  private clientCwd?: string;
  private activeSessionFile?: string;
  private previewSessionFile?: string;
  private isRunning = false;
  private readonly webviewDisposables: vscode.Disposable[] = [];
  private readonly clientDisposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {}

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
    );

    void this.postState();
  }

  async open(): Promise<void> {
    await vscode.commands.executeCommand("workbench.view.extension.pi-for-vscode");
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
  }

  async newSession(): Promise<void> {
    const client = await this.ensureClientReady();
    if (!client) return;
    const response = await client.request({ type: "new_session" });
    if (response.success === false) {
      this.postSystem(`Failed to start a new session: ${String(response.error ?? "unknown error")}`);
      return;
    }
    const data = asRecord(response.data);
    if (data?.cancelled === true) return;
    this.setRunning(false);
    this.post({ type: "reset" });
    void this.postState();
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

  async stop(): Promise<void> {
    if (!this.client?.isStarted) return;
    this.setRunning(false);
    const response = await this.client.request({ type: "abort" });
    if (response.success === false) {
      this.postSystem(`Failed to abort: ${String(response.error ?? "unknown error")}`);
      return;
    }
    void this.postState();
  }

  async repairAgent(): Promise<void> {
    await this.open();
    this.resetClient();
    this.setRunning(false);
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
    this.resetClient();
  }

  private async handleWebviewMessage(message: WebviewToExtensionMessage): Promise<void> {
    try {
      switch (message.type) {
        case "ready": {
          const state = await this.postState();
          const currentSessionFile = readSessionFile(state);
          const webviewSessionFile = message.sessionFile;
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
        case "extensionUiResponse": {
          const client = await this.ensureClientReady();
          client?.send(message.response as PiRpcMessage);
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

    const client = await this.ensureClientReady();
    if (!client) return;

    if (this.isPreviewingDetachedSession()) {
      const previewFile = this.previewSessionFile!; // isPreviewingDetachedSession() guarantees this is set.
      const state = await this.getClientState(client);
      const currentSessionFile = readSessionFile(state);
      const isStreaming = state?.isStreaming === true;
      if (!samePath(previewFile, currentSessionFile)) {
        if (isStreaming) {
          this.postSystem("Pi is still working in another session. Select the current session or wait until it finishes before sending a new prompt here.");
          return;
        }
        await this.switchSession(previewFile);
      }
    }

    const command: PiRpcMessage = { type: "prompt", message: trimmed };
    if (imageBlocks.length > 0) command.images = imageBlocks;
    if (this.isRunning) {
      command.streamingBehavior = this.getConfiguration().defaultStreamingBehavior;
    }

    const response = await client.request(command);
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

  private async switchSession(sessionPath: string): Promise<void> {
    if (!await this.isCurrentWorkspaceSession(sessionPath)) {
      this.postSystem("That session belongs to a different workspace and cannot be opened from this project.");
      await this.postSessionList();
      return;
    }

    const client = await this.ensureClientReady();
    if (!client) return;

    const state = await this.getClientState(client);
    const currentSessionFile = readSessionFile(state);
    const isStreaming = state?.isStreaming === true;
    this.activeSessionFile = currentSessionFile;

    if (samePath(sessionPath, currentSessionFile)) {
      this.previewSessionFile = undefined;
      await this.postState();
      await this.hydrateSessionMessages(true, isStreaming);
      return;
    }

    if (isStreaming) {
      await this.previewSession(sessionPath);
      this.postSystem("Viewing saved history. Pi is still working in the current session in the background.");
      return;
    }

    const response = await client.request({ type: "switch_session", sessionPath }, 30_000);
    if (response.success === false) {
      this.postSystem(`Failed to switch session: ${String(response.error ?? "unknown error")}`);
      return;
    }

    const data = asRecord(response.data);
    if (data?.cancelled === true) return;

    this.previewSessionFile = undefined;
    this.setRunning(false);
    this.post({ type: "reset" });
    await this.postState();
    await this.hydrateSessionMessages(true);
  }

  private async previewSession(sessionPath: string): Promise<void> {
    this.previewSessionFile = sessionPath;
    const messages = await readPiSessionMessages(sessionPath);
    this.post({ type: "sessionMessages", messages, force: true });
    await this.postSessionList();
  }

  private async hydrateSessionMessages(force = false, allowWhileRunning = false): Promise<void> {
    if (this.isRunning && !allowWhileRunning) return;

    const client = await this.ensureClientReady();
    if (!client) return;
    await this.postState();
    const response = await client.request({ type: "get_messages" }, 10_000).catch(() => undefined);
    if (!response || response.success === false || (this.isRunning && !allowWhileRunning)) return;

    const data = asRecord(response.data);
    const messages = Array.isArray(data?.messages) ? data.messages : [];
    this.post({ type: "sessionMessages", messages, force });
  }

  private async postSessionList(): Promise<void> {
    const summaries = await this.collectSessions();
    this.post({ type: "sessionList", sessions: summaries.map(toSessionListItem) });
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
      // When pi already has this session loaded, route the rename through its RPC
      // so pi's in-memory session name (what get_state returns) updates too.
      // Writing the file directly behind a running broker leaves pi unaware, so the
      // next get_state/switch_session reports the stale name and the rename "reverts".
      const renamedViaPi = await this.renameActiveSessionViaPi(sessionPath, trimmed);
      if (!renamedViaPi) await renameSession(sessionPath, trimmed);
      if (samePath(sessionPath, this.activeSessionFile)) await this.postState();
    } catch (error) {
      this.postSystem(`Failed to rename session: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.postSessionList();
  }

  // Rename via pi's set_session_name RPC when pi is the live owner of this session.
  // Returns false when pi isn't running on it (caller falls back to a direct,
  // well-formed file write). Throws if pi rejects the rename.
  private async renameActiveSessionViaPi(sessionPath: string, name: string): Promise<boolean> {
    const client = this.client?.isStarted ? this.client : undefined;
    if (!client) return false;
    // Refresh the broker's loaded-session pointer so we never RPC the wrong session.
    await this.getClientState(client);
    if (!samePath(sessionPath, this.activeSessionFile)) return false;
    const response = await client.request({ type: "set_session_name", name }, 10_000);
    if (response.success === false) {
      throw new Error(String(response.error ?? "pi rejected the rename"));
    }
    return true;
  }

  private async collectSessions(): Promise<PiSessionSummary[]> {
    const cwd = getWorkspaceCwd();
    if (!cwd) return [];

    const client = await this.ensureClientReady();
    const stateData = client ? await this.requestState(client) : undefined;
    const currentSessionFile = readSessionFile(stateData);
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
  // commands come from the live session over the RPC client, like requestState/newSession.
  private async postCommandList(): Promise<void> {
    const client = await this.ensureClientReady();
    if (!client) {
      this.post({ type: "commandList", commands: [] });
      return;
    }
    const response = await client.request({ type: "get_commands" }, 10_000).catch(() => undefined);
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
    const client = await this.ensureClientReady();
    if (!client) return;

    // Capture the active session so we can restore it after pi restarts.
    const sessionFile = readSessionFile(await this.requestState(client));

    const secrets = await this.getSecretsEnv();
    const response = await client.request({ type: "set_model", model: modelId, secrets }, 30_000);
    if (response.success === false) {
      this.postSystem(`Failed to switch model: ${String(response.error ?? "unknown error")}`);
      return;
    }
    // Persist only after the broker accepted the switch, so the stored selection
    // (used for the picker's current marker and the next cold start) never drifts.
    await this.context.globalState.update(SELECTED_MODEL_KEY, modelId);

    this.setRunning(false);
    if (sessionFile && await this.isCurrentWorkspaceSession(sessionFile)) {
      await client.request({ type: "switch_session", sessionPath: sessionFile }, 30_000).catch(() => undefined);
    }
    await this.postState();
    await this.hydrateSessionMessages(true);
  }

  private async setThinkingLevel(level: string): Promise<void> {
    const trimmed = level.trim().toLowerCase();
    if (!THINKING_LEVELS.has(trimmed)) return;

    const client = await this.ensureClientReady();
    if (!client) return;

    const response = await client.request({ type: "set_thinking_level", level: trimmed }, 10_000);
    if (response.success === false) {
      this.postSystem(`Failed to change effort: ${String(response.error ?? "unknown error")}`);
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
    const stored = this.context.globalState.get<string>(SELECTED_MODEL_KEY);
    if (stored) return stored;
    if (!this.client?.isStarted) return undefined;
    const state = await this.requestState(this.client);
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

  private async ensureClientReady(): Promise<PiRpcClient | undefined> {
    const cwd = getWorkspaceCwd();
    if (!cwd) {
      this.postSystem("Open a workspace folder to start a project-scoped Pi session.");
      return undefined;
    }

    if (this.client?.isStarted) {
      if (this.isRunning) return this.client;
      if (samePath(this.clientCwd, cwd)) {
        const state = await this.getClientState(this.client);
        if (!state || !await this.isForeignWorkspaceState(state, cwd)) return this.client;
        await this.shutdownCurrentBroker();
      } else {
        this.resetClient();
      }
    }

    let runtime;
    try {
      runtime = await resolvePiRuntime(this.context);
    } catch (error) {
      this.reportRuntimeError(error);
      return undefined;
    }

    this.disposeClientListeners();
    this.client?.dispose();
    const config = this.getConfiguration();
    const client = new PiRpcClient({
      piPath: runtime.piEntry,
      launchKind: runtime.launchKind,
      nodePath: runtime.nodePath,
      runAsNode: runtime.runAsNode,
      cwd,
      persistSessions: config.persistSessions,
      extraArgs: config.extraArgs,
      model: this.context.globalState.get<string>(SELECTED_MODEL_KEY) || undefined,
      secrets: await this.getSecretsEnv(),
      brokerScriptPath: vscode.Uri.joinPath(this.context.extensionUri, "out", "piBroker.js").fsPath,
      brokerStoragePath: this.context.globalStorageUri.fsPath,
      brokerIdleTimeoutMs: config.brokerIdleTimeoutMinutes * 60 * 1000,
    });

    this.clientDisposables.push(
      client.onEvent((event) => this.handleRpcEvent(event)),
      client.onStderr((text) => this.post({ type: "stderr", text })),
      client.onError((error) => this.postSystem(`Pi RPC error: ${error.message}`)),
      client.onClose(({ code, signal }) => {
        this.setRunning(false);
        this.postSystem(`Pi background process closed (${code ?? "null"}${signal ? `, ${signal}` : ""}).`);
      }),
    );

    client.start();
    this.client = client;
    this.clientCwd = cwd;
    this.activeSessionFile = undefined;
    this.previewSessionFile = undefined;
    void this.postState();
    return client;
  }

  private async shutdownCurrentBroker(): Promise<void> {
    const client = this.client;
    this.disposeClientListeners();
    if (client?.isStarted) {
      await client.request({ type: "broker_shutdown" }, 5_000).catch(() => undefined);
    }
    client?.dispose();
    this.clearClientFields();
    this.setRunning(false);
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

  private async getClientState(client: PiRpcClient): Promise<Record<string, unknown> | undefined> {
    const state = await this.requestState(client);
    this.activeSessionFile = readSessionFile(state);
    return state;
  }

  private reportRuntimeError(error: unknown): void {
    if (error instanceof PiNotInstalledError || error instanceof NodeTooOldError) {
      this.postSystem(error.message);
    } else {
      this.postSystem(`Failed to start Pi: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private isPreviewingDetachedSession(): boolean {
    return Boolean(this.previewSessionFile && !samePath(this.previewSessionFile, this.activeSessionFile));
  }

  private handleRpcEvent(event: PiRpcMessage): void {
    if (event.type === "agent_start") {
      this.setRunning(true);
    } else if (event.type === "agent_end") {
      this.setRunning(false);
      void this.postState();
    } else if (event.type === "thinking_level_changed") {
      void this.postState();
    }

    if (event.type === "extension_ui_request") {
      this.post({ type: "extensionUiRequest", request: event });
      return;
    }

    if (this.isPreviewingDetachedSession()) return;
    this.post({ type: "rpcEvent", event });
  }

  private async postState(): Promise<Record<string, unknown> | undefined> {
    if (!this.view) return undefined;
    const workspaceName = getWorkspaceName(this.client?.isStarted ? this.clientCwd : undefined);
    if (!this.client?.isStarted) {
      const state = { isStreaming: false, sessionFile: undefined, model: undefined, workspaceName };
      this.post({ type: "state", state });
      return state;
    }

    try {
      const response = await this.client.request({ type: "get_state" }, 10_000);
      if (response.success === false) return undefined;
      const data = response.data && typeof response.data === "object" ? { ...(response.data as object), workspaceName } : { workspaceName };
      const state = asRecord(data);
      if (state && this.clientCwd && state.isStreaming !== true && await this.isForeignWorkspaceState(state, this.clientCwd)) {
        await this.shutdownCurrentBroker();
        return this.postState();
      }
      this.activeSessionFile = readSessionFile(state);
      this.post({ type: "state", state: data });
      return state;
    } catch {
      // Ignore state refresh failures during startup/shutdown.
      return undefined;
    }
  }

  private setRunning(value: boolean): void {
    this.isRunning = value;
    this.post({ type: "running", value });
  }

  private postSystem(text: string): void {
    this.post({ type: "system", text });
  }

  private post(message: ExtensionToWebviewMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private disposeWebviewListeners(): void {
    for (const disposable of this.webviewDisposables.splice(0)) disposable.dispose();
  }

  private disposeClientListeners(): void {
    for (const disposable of this.clientDisposables.splice(0)) disposable.dispose();
  }

  // Nulls every client-scoped field; pair with disposeClientListeners()/dispose() at each teardown site.
  private clearClientFields(): void {
    this.client = undefined;
    this.clientCwd = undefined;
    this.activeSessionFile = undefined;
    this.previewSessionFile = undefined;
  }

  // Synchronous client teardown: drop listeners, dispose the client, clear its fields.
  private resetClient(): void {
    this.disposeClientListeners();
    this.client?.dispose();
    this.clearClientFields();
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
