import * as vscode from "vscode";
import { detectPiVersion, repairBundledPi, resolvePiRuntime } from "./piResolver";
import { AuthStatusService } from "./authStatusService";
import { BundledExtensionResolver } from "./bundledExtensionResolver";
import { WebviewPresenter } from "./webviewPresenter";
import { RpcEventRouter } from "./rpcEventRouter";
import { SessionStatsService } from "./sessionStatsService";
import { CommandPaletteService } from "./commandPaletteService";
import { ModelService } from "./modelService";
import { AuthRevocationService } from "./authRevocationService";
import { SessionRuntimeManager } from "./sessionRuntimeManager";
import { SessionCrudService } from "./sessionCrudService";
import type { ImageAttachment, PiRpcMessage, WebviewToExtensionMessage } from "./protocol";
import { getChatHtml } from "./webviewHtml";
import { EditorContextTracker } from "./editorContextTracker";
import { resolveActiveTheme } from "./themeResolver";
import { openWorkspaceFile } from "./fileOpener";

const VIEW_ID = "pi-for-vscode.chat";

const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export class PiChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly presenter = new WebviewPresenter();
  private readonly stats = new SessionStatsService(this.presenter);
  private readonly events = new RpcEventRouter(this.presenter, this.stats);
  // Lambda so the late-bound this.revocation is read at call time.
  private readonly authStatus = new AuthStatusService(this.presenter, {
    onAuthFileChanged: () => void this.revocation.onAuthFileChanged(),
  });
  private readonly bundled: BundledExtensionResolver;
  private readonly manager: SessionRuntimeManager;
  private readonly models: ModelService;
  private readonly revocation: AuthRevocationService;
  private readonly commandPalette: CommandPaletteService;
  private readonly crud: SessionCrudService;
  private contextTracker?: EditorContextTracker;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.bundled = new BundledExtensionResolver(context);
    this.manager = new SessionRuntimeManager(context, this.presenter, this.events, this.bundled);
    // The router calls back into the manager (runtime map owner). Bound once, after both exist.
    this.events.bind(this.manager.eventSink());
    this.models = new ModelService(this.presenter, {
      // RPC-only: in the empty state this reaches the warm spare so the model/auth verdict
      // resolves WITHOUT committing a visible session.
      ensureRuntime: () => this.manager.ensureRuntimeForRpc(),
      requestState: (client) => this.manager.requestState(client),
      postState: () => this.manager.postState(),
      reportRuntimeError: (error) => this.manager.reportRuntimeError(error),
      onModelsFetched: (models) => this.authStatus.noteModels(models),
    });
    this.revocation = new AuthRevocationService(this.presenter, {
      activeRuntime: () => this.manager.active,
      forEachRuntime: (cb) => this.manager.forEachRuntime(cb),
      requestState: (client) => this.manager.requestState(client),
      fetchModels: () => this.models.fetchModels(),
    });
    this.manager.setSettledHook((rt) => this.revocation.handleRuntimeSettled(rt));
    this.authStatus.start();
    this.commandPalette = new CommandPaletteService(this.presenter, {
      ensureRuntime: () => this.manager.ensureRuntimeForRpc(),
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
      // Keep the webview's Shiki highlighter in step with the editor's color theme.
      vscode.window.onDidChangeActiveColorTheme(() => this.postTheme()),
    );
    // Mirrors the active editor (file + selection) to the composer's context chip.
    // disposeListeners() above disposed the previous tracker on a re-resolve.
    this.contextTracker = new EditorContextTracker(this.presenter);
    this.presenter.pushDisposable(this.contextTracker);

    void this.manager.postState();
  }

  async open(): Promise<void> {
    await vscode.commands.executeCommand("workbench.view.extension.pi-for-vscode");
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
  }

  // Push the active editor theme to the webview's Shiki highlighter (best-effort JSON + kind fallback).
  private postTheme(): void {
    const theme = resolveActiveTheme();
    this.presenter.postTheme(theme.theme, theme.kind);
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
    this.authStatus.dispose();
    this.manager.disposeAll();
  }

  private async handleWebviewMessage(message: WebviewToExtensionMessage): Promise<void> {
    try {
      switch (message.type) {
        case "ready": {
          this.postTheme();
          this.contextTracker?.post();
          this.presenter.repostUsage();
          const webviewSessionFile = message.sessionFile;
          if (webviewSessionFile && await this.manager.isCurrentWorkspaceSession(webviewSessionFile)) {
            // Resume the session the user was last viewing (reload): force re-seed + activate so
            // the persisted view is restored via the crash-restore (adoptPersistedView) path.
            await this.manager.resumeSession(webviewSessionFile);
          } else {
            // No remembered session → empty state. Nothing committed (composer + "Pi"
            // placeholder); warm a spare so the first action opens instantly. Awaited so the
            // model/auth probe below reuses this spare instead of spawning a second one.
            await this.manager.postState();
            await this.manager.ensurePrewarm();
          }
          // Quiet auth check: the fetch outcome flows to AuthStatusService.noteModels,
          // which posts the authState verdict that gates the onboarding screen.
          void this.models.postModelList(true);
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
        case "activateSession":
          // Tab click: make that open runtime the visible session (instant view swap).
          await this.manager.activateRuntime(message.sessionId);
          return;
        case "closeSession":
          // Tab ×: reap the runtime. Closing the last tab lands on the empty state (composer +
          // placeholder) — closeRuntime no longer auto-creates a replacement session.
          await this.manager.closeRuntime(message.sessionId, message.activateSessionId);
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
        case "requestSessionStats":
          await this.stats.postStats(this.manager.active);
          return;
        case "requestCommands":
          await this.commandPalette.postCommandList();
          return;
        case "setModel":
          await this.models.setModel(message.provider, message.modelId);
          return;
        case "setThinkingLevel":
          await this.models.setThinkingLevel(message.level);
          return;
        case "login":
          await this.runAuthCommand(
            message.method === "subscription" ? "/login subscription"
              : message.method === "api-key" ? "/login api-key"
              : "/login",
          );
          return;
        case "logout": {
          // Validate before interpolating into the bridge command line.
          const provider = message.provider && /^[A-Za-z0-9_-]+$/.test(message.provider) ? message.provider : undefined;
          await this.runAuthCommand(provider ? `/logout ${provider}` : "/logout");
          return;
        }
        case "requestAuthState":
          await this.authStatus.postAuthState();
          return;
        case "requestAbout":
          await this.postAbout();
          return;
        case "getState":
          await this.manager.postState();
          return;
        case "copy":
          await vscode.env.clipboard.writeText(message.text ?? "");
          return;
        case "openExternal":
          await this.openExternal(message.url);
          return;
        case "openFile":
          await openWorkspaceFile(message.path, message.line, message.col);
          return;
        case "insertCode":
          await this.insertIntoActiveEditor(message.text);
          return;
        case "applyCode":
          // Hand the snippet to Pi to apply — Pi owns file edits via its tools (thin wrapper). A
          // 4-backtick fence survives 3-backtick code inside the snippet.
          await this.prompt("Apply the following code to the appropriate file in this project:\n\n````\n" + message.text + "\n````");
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

  private async runAuthCommand(command: string): Promise<void> {
    await this.prompt(command);
    await this.manager.postState();
    await this.models.postModelList();
  }

  private async postAbout(): Promise<void> {
    const packageJson = this.context.extension.packageJSON as { version?: unknown } | undefined;
    const extensionVersion = typeof packageJson?.version === "string" ? packageJson.version : "";
    let piVersion: string | undefined;
    let piSource: string | undefined;
    try {
      const runtime = await resolvePiRuntime(this.context);
      piSource = runtime.source;
      piVersion = await detectPiVersion(runtime);
    } catch {
      // pi not installed — About shows the extension version only.
    }
    this.presenter.post({ type: "about", extensionVersion, piVersion, piSource });
  }

  private async openExternal(url: string): Promise<void> {
    const trimmed = url.trim();
    if (!trimmed) return;
    const uri = vscode.Uri.parse(trimmed, true);
    if (uri.scheme !== "http" && uri.scheme !== "https") return;
    await vscode.env.openExternal(uri);
  }

  private async prompt(text: string, images?: ImageAttachment[]): Promise<void> {
    const trimmed = text.trim();
    const imageBlocks = this.toPiImageBlocks(images);
    if (!trimmed && imageBlocks.length === 0) return;

    const rt = await this.manager.ensureActiveRuntime();
    if (!rt?.client) return;

    // Decide the streaming behavior from the state BEFORE the optimistic flip below, so the first
    // prompt of a turn is never mis-tagged as its own follow-up.
    const wasRunning = rt.isRunning;
    const command: PiRpcMessage = { type: "prompt", message: trimmed };
    if (imageBlocks.length > 0) command.images = imageBlocks;
    if (wasRunning) {
      command.streamingBehavior = this.manager.getConfiguration().defaultStreamingBehavior;
    }

    // Optimistically mark the runtime running the moment we forward the prompt. Two effects:
    //   1) setRunning posts running:true → the webview spinner shows without waiting for pi's
    //      agent_start to round-trip (matches the webview's own optimism; both are idempotent).
    //   2) isRunning flips true, so a rapidly-following prompt is tagged steer/followUp and pi
    //      ABSORBS it into the SAME run (one continuous turn) instead of spawning a fresh run per
    //      message. pi's agent_end later resets isRunning, so a message sent after the turn truly
    //      ended still correctly starts a new run.
    // Rolled back below if pi rejects the prompt (it never emits agent_start/agent_end then).
    if (!wasRunning) this.manager.setRunning(rt, true);

    const response = await rt.client.request(command);
    if (response.success === false) {
      if (!wasRunning) this.manager.setRunning(rt, false);
      this.presenter.postSystem(`Prompt rejected: ${String(response.error ?? "unknown error")}`);
    }
  }

  // Insert a code snippet at the active editor's cursor (replacing any selection). No-op with a
  // hint if no editor is focused.
  private async insertIntoActiveEditor(text: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.presenter.postSystem("Open a file in the editor to insert code into.");
      return;
    }
    await editor.edit((builder) => builder.replace(editor.selection, text));
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
