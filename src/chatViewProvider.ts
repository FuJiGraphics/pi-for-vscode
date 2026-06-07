import * as vscode from "vscode";
import { repairBundledPi } from "./piResolver";
import { BundledExtensionResolver } from "./bundledExtensionResolver";
import { ModelSecretsStore } from "./modelSecretsStore";
import { WebviewPresenter } from "./webviewPresenter";
import { RpcEventRouter } from "./rpcEventRouter";
import { CommandPaletteService } from "./commandPaletteService";
import { ModelService } from "./modelService";
import { SessionRuntimeManager } from "./sessionRuntimeManager";
import { SessionCrudService } from "./sessionCrudService";
import type { ImageAttachment, PiRpcMessage, WebviewToExtensionMessage } from "./protocol";
import { getChatHtml } from "./webviewHtml";
import { samePath } from "./workspace";
import { readSessionFile } from "./stateHelpers";

const VIEW_ID = "pi-for-vscode.chat";

const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export class PiChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly presenter = new WebviewPresenter();
  private readonly events = new RpcEventRouter(this.presenter);
  private readonly bundled: BundledExtensionResolver;
  private readonly secretsStore: ModelSecretsStore;
  private readonly manager: SessionRuntimeManager;
  private readonly models: ModelService;
  private readonly commandPalette: CommandPaletteService;
  private readonly crud: SessionCrudService;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.bundled = new BundledExtensionResolver(context);
    this.secretsStore = new ModelSecretsStore(context);
    this.manager = new SessionRuntimeManager(context, this.presenter, this.events, this.bundled, this.secretsStore);
    // The router calls back into the manager (runtime map owner). Bound once, after both exist.
    this.events.bind(this.manager.eventSink());
    this.models = new ModelService(context, this.presenter, this.secretsStore, {
      ensureActiveRuntime: () => this.manager.ensureActiveRuntime(),
      activeRuntime: () => this.manager.active,
      requestState: (client) => this.manager.requestState(client),
      setRunning: (rt, value) => this.manager.setRunning(rt, value),
      seedRuntime: (rt, force) => this.manager.seedRuntime(rt, force),
      postState: () => this.manager.postState(),
      isCurrentWorkspaceSession: (sessionPath) => this.manager.isCurrentWorkspaceSession(sessionPath),
      reportRuntimeError: (error) => this.manager.reportRuntimeError(error),
    });
    this.commandPalette = new CommandPaletteService(this.presenter, {
      ensureActiveRuntime: () => this.manager.ensureActiveRuntime(),
    });
    this.crud = new SessionCrudService(this.manager, this.presenter, () => this.open());
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.presenter.disposeListeners();
    this.presenter.attach(webviewView);
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    webviewView.webview.html = getChatHtml(webviewView.webview, this.context.extensionUri);

    this.presenter.pushDisposable(
      webviewView.webview.onDidReceiveMessage((message) => this.handleWebviewMessage(message as WebviewToExtensionMessage)),
      // View revealed again (sidebar reopened / tab refocused) — verify the link.
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) this.manager.probeConnection();
      }),
    );

    void this.manager.postState();
  }

  async open(): Promise<void> {
    await vscode.commands.executeCommand("workbench.view.extension.pi-for-vscode");
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
  }

  // Public command entry points (extension.ts) — thin delegators to the session-CRUD unit.
  newSession(): Promise<void> {
    return this.crud.newSession();
  }

  sessions(): Promise<void> {
    return this.crud.sessions();
  }

  // Stop only the session the user is looking at. Background runtimes keep running.
  async stop(): Promise<void> {
    const rt = this.manager.active;
    if (!rt?.client?.isStarted) return;
    this.manager.setRunning(rt, false);
    const response = await rt.client.request({ type: "abort" });
    if (response.success === false) {
      this.presenter.postSystem(`Failed to abort: ${String(response.error ?? "unknown error")}`);
      return;
    }
    void this.manager.postState();
  }

  async repairAgent(): Promise<void> {
    await this.open();
    await this.manager.reapAllRuntimes();
    try {
      const entry = await repairBundledPi(this.context);
      this.presenter.postSystem(`Reinstalled the bundled Pi agent at ${entry}.`);
      void this.manager.postState();
    } catch (error) {
      this.manager.reportRuntimeError(error);
    }
  }

  dispose(): void {
    this.presenter.disposeListeners();
    this.manager.disposeAll();
  }

  private async handleWebviewMessage(message: WebviewToExtensionMessage): Promise<void> {
    try {
      switch (message.type) {
        case "ready": {
          const rt = await this.manager.ensureActiveRuntime();
          const webviewSessionFile = message.sessionFile;
          // Resume the session the user was last viewing (Claude-style resume-from-disk):
          // after a reload the fresh broker cold-starts on pi's default session, so steer
          // it back to the remembered one. A still-live runtime is already on it → no-op.
          if (rt?.client?.isStarted && webviewSessionFile && await this.manager.isCurrentWorkspaceSession(webviewSessionFile)) {
            const loaded = readSessionFile(await this.manager.requestState(rt.client));
            if (!samePath(loaded, webviewSessionFile)) {
              const response = await rt.client.request({ type: "switch_session", sessionPath: webviewSessionFile }, 30_000).catch(() => undefined);
              if (response && response.success !== false) rt.sessionFile = webviewSessionFile;
            }
          }
          // Re-seed the active session's view into the (reloaded) webview and show it.
          if (rt) {
            await this.manager.seedRuntime(rt, true);
            this.presenter.post({ type: "activate", sessionId: rt.id });
          } else {
            await this.manager.postState();
          }
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
          await this.manager.postSessionList();
          return;
        case "switchSession":
          await this.crud.switchSession(message.sessionPath);
          return;
        case "deleteSession":
          await this.crud.deleteSession(message.sessionPath);
          return;
        case "renameSession":
          await this.crud.renameSession(message.sessionPath, message.name);
          return;
        case "requestModels":
          await this.models.postModelList();
          return;
        case "requestCommands":
          await this.commandPalette.postCommandList();
          return;
        case "setModel":
          await this.models.setModel(message.modelId);
          return;
        case "setThinkingLevel":
          await this.models.setThinkingLevel(message.level);
          return;
        case "addProviderKey":
          await this.models.addProviderKey();
          return;
        case "getState":
          await this.manager.postState();
          return;
        case "copy":
          await vscode.env.clipboard.writeText(message.text ?? "");
          return;
        case "wake":
          this.manager.probeConnection();
          return;
        case "reconnect":
          await this.manager.forceReconnect();
          return;
        case "extensionUiResponse": {
          // The request is only ever shown for the active runtime, so the response
          // routes back to the active runtime's pi (the one that raised it).
          this.manager.active?.client?.send(message.response as PiRpcMessage);
          return;
        }
      }
    } catch (error) {
      this.presenter.postSystem(error instanceof Error ? error.message : String(error));
    }
  }

  private async prompt(text: string, images?: ImageAttachment[]): Promise<void> {
    const trimmed = text.trim();
    const imageBlocks = this.toPiImageBlocks(images);
    if (!trimmed && imageBlocks.length === 0) return;

    const rt = await this.manager.ensureActiveRuntime();
    if (!rt?.client) return;

    const command: PiRpcMessage = { type: "prompt", message: trimmed };
    if (imageBlocks.length > 0) command.images = imageBlocks;
    if (rt.isRunning) {
      command.streamingBehavior = this.manager.getConfiguration().defaultStreamingBehavior;
    }

    const response = await rt.client.request(command);
    if (response.success === false) {
      this.presenter.postSystem(`Prompt rejected: ${String(response.error ?? "unknown error")}`);
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

  /** VS Code window regained focus — a cheap proxy for "the machine may have woken". */
  onWindowFocused(): void {
    this.manager.probeConnection();
  }

}
