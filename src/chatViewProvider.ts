import * as vscode from "vscode";
import { PiRpcClient, type PiRpcMessage } from "./piRpcClient";

const VIEW_ID = "pi-for-vscode.chat";

export class PiChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private client?: PiRpcClient;
  private readonly disposables: vscode.Disposable[] = [];
  private isRunning = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (message) => this.handleWebviewMessage(message as WebviewToExtensionMessage),
      undefined,
      this.disposables,
    );

    void this.postState();
  }

  async open(): Promise<void> {
    await vscode.commands.executeCommand("workbench.view.extension.pi-for-vscode");
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
  }

  async newSession(): Promise<void> {
    const client = this.ensureClient();
    const response = await client.request({ type: "new_session" });
    if (response.success === false) {
      this.postSystem(`Failed to start a new session: ${String(response.error ?? "unknown error")}`);
      return;
    }
    this.isRunning = false;
    this.post({ type: "reset" });
    void this.postState();
  }

  async stop(): Promise<void> {
    if (!this.client?.isStarted) return;
    const response = await this.client.request({ type: "abort" });
    if (response.success === false) {
      this.postSystem(`Failed to abort: ${String(response.error ?? "unknown error")}`);
    }
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.client?.dispose();
  }

  private async handleWebviewMessage(message: WebviewToExtensionMessage): Promise<void> {
    try {
      switch (message.type) {
        case "ready":
          await this.postState();
          return;
        case "prompt":
          await this.prompt(message.text);
          return;
        case "abort":
          await this.stop();
          return;
        case "newSession":
          await this.newSession();
          return;
        case "getState":
          await this.postState();
          return;
        case "extensionUiResponse":
          this.ensureClient().send(message.response as PiRpcMessage);
          return;
      }
    } catch (error) {
      this.postSystem(error instanceof Error ? error.message : String(error));
    }
  }

  private async prompt(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;

    const client = this.ensureClient();
    const command: PiRpcMessage = { type: "prompt", message: trimmed };
    if (this.isRunning) {
      command.streamingBehavior = this.getConfiguration().defaultStreamingBehavior;
    }

    const response = await client.request(command);
    if (response.success === false) {
      this.postSystem(`Prompt rejected: ${String(response.error ?? "unknown error")}`);
    }
  }

  private ensureClient(): PiRpcClient {
    if (this.client?.isStarted) return this.client;

    this.client?.dispose();
    const config = this.getConfiguration();
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const client = new PiRpcClient({
      piPath: config.piPath,
      cwd,
      persistSessions: config.persistSessions,
      extraArgs: config.extraArgs,
    });

    this.disposables.push(
      client.onEvent((event) => this.handleRpcEvent(event)),
      client.onStderr((text) => this.post({ type: "stderr", text })),
      client.onError((error) => this.postSystem(`Pi RPC error: ${error.message}`)),
      client.onClose(({ code, signal }) => {
        this.isRunning = false;
        this.post({ type: "running", value: false });
        this.postSystem(`Pi RPC process closed (${code ?? "null"}${signal ? `, ${signal}` : ""}).`);
      }),
    );

    client.start();
    this.client = client;
    void this.postState();
    return client;
  }

  private handleRpcEvent(event: PiRpcMessage): void {
    if (event.type === "agent_start") {
      this.isRunning = true;
      this.post({ type: "running", value: true });
    } else if (event.type === "agent_end") {
      this.isRunning = false;
      this.post({ type: "running", value: false });
      void this.postState();
    }

    if (event.type === "extension_ui_request") {
      this.post({ type: "extensionUiRequest", request: event });
      return;
    }

    this.post({ type: "rpcEvent", event });
  }

  private async postState(): Promise<void> {
    if (!this.view) return;
    if (!this.client?.isStarted) {
      this.post({ type: "state", state: { isStreaming: false, sessionFile: undefined, model: undefined } });
      return;
    }

    try {
      const response = await this.client.request({ type: "get_state" }, 10_000);
      if (response.success === false) return;
      this.post({ type: "state", state: response.data });
    } catch {
      // Ignore state refresh failures during startup/shutdown.
    }
  }

  private postSystem(text: string): void {
    this.post({ type: "system", text });
  }

  private post(message: ExtensionToWebviewMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private getConfiguration(): PiConfiguration {
    const config = vscode.workspace.getConfiguration("pi-for-vscode");
    return {
      piPath: config.get<string>("piPath", "pi"),
      extraArgs: config.get<string[]>("extraArgs", []),
      persistSessions: config.get<boolean>("persistSessions", true),
      defaultStreamingBehavior: config.get<"followUp" | "steer">("defaultStreamingBehavior", "followUp"),
    };
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <title>Pi for VS Code</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: var(--vscode-sideBar-background);
      --fg: var(--vscode-sideBar-foreground);
      --muted: var(--vscode-descriptionForeground);
      --border: var(--vscode-panel-border);
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --button-bg: var(--vscode-button-background);
      --button-fg: var(--vscode-button-foreground);
      --button-hover: var(--vscode-button-hoverBackground);
      --accent: var(--vscode-textLink-foreground);
      --code-bg: var(--vscode-textCodeBlock-background);
      --error: var(--vscode-errorForeground);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      height: 100vh;
      display: flex;
      flex-direction: column;
      background: var(--bg);
      color: var(--fg);
      font: 13px/1.45 var(--vscode-font-family);
    }
    header {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .title { font-weight: 600; }
    .status { color: var(--muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .empty {
      margin: auto;
      max-width: 320px;
      color: var(--muted);
      text-align: center;
    }
    .message {
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px;
      background: color-mix(in srgb, var(--bg) 86%, var(--fg) 14%);
    }
    .message.user { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); }
    .message.assistant { background: transparent; }
    .message.tool { font-size: 12px; }
    .message.system { color: var(--muted); font-size: 12px; border-style: dashed; }
    .message.error { color: var(--error); }
    .role {
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: .04em;
      margin-bottom: 6px;
    }
    .content { white-space: pre-wrap; overflow-wrap: anywhere; }
    pre {
      margin: 6px 0 0;
      padding: 8px;
      overflow: auto;
      border-radius: 6px;
      background: var(--code-bg);
      white-space: pre-wrap;
    }
    footer {
      border-top: 1px solid var(--border);
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    textarea {
      width: 100%;
      min-height: 76px;
      max-height: 220px;
      resize: vertical;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 9px;
      background: var(--input-bg);
      color: var(--input-fg);
      font: inherit;
      outline: none;
    }
    .actions { display: flex; gap: 8px; align-items: center; }
    button {
      border: 0;
      border-radius: 6px;
      padding: 6px 10px;
      background: var(--button-bg);
      color: var(--button-fg);
      cursor: pointer;
      font: inherit;
    }
    button:hover { background: var(--button-hover); }
    button.secondary { background: transparent; color: var(--fg); border: 1px solid var(--border); }
    button:disabled { opacity: .55; cursor: not-allowed; }
    .hint { color: var(--muted); font-size: 11px; margin-left: auto; }
  </style>
</head>
<body>
  <header>
    <div>
      <div class="title">Pi for VS Code</div>
      <div id="status" class="status">Idle</div>
    </div>
    <button id="newSession" class="secondary" title="New session">New</button>
  </header>
  <main id="messages"></main>
  <footer>
    <textarea id="input" placeholder="Ask Pi..."></textarea>
    <div class="actions">
      <button id="send">Send</button>
      <button id="stop" class="secondary" disabled>Stop</button>
      <span class="hint">Shift+Enter for newline</span>
    </div>
  </footer>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const restored = vscode.getState();
    const state = restored || { messages: [], running: false, status: "Idle", currentAssistantId: null };

    const messagesEl = document.getElementById("messages");
    const statusEl = document.getElementById("status");
    const inputEl = document.getElementById("input");
    const sendEl = document.getElementById("send");
    const stopEl = document.getElementById("stop");
    const newSessionEl = document.getElementById("newSession");

    function save() { vscode.setState(state); }
    function uid(prefix) { return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2); }
    function escapeHtml(text) {
      return String(text ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[ch]));
    }
    function roleLabel(role) {
      if (role === "assistant") return "Pi";
      if (role === "tool") return "Tool";
      return role;
    }
    function render() {
      statusEl.textContent = state.status || (state.running ? "Running" : "Idle");
      stopEl.disabled = !state.running;
      sendEl.textContent = state.running ? "Queue" : "Send";

      if (state.messages.length === 0) {
        messagesEl.innerHTML = '<div class="empty">Start a Pi session from this sidebar. Messages stream from <code>pi --mode rpc</code>.</div>';
        return;
      }

      messagesEl.innerHTML = state.messages.map(message => {
        const classes = ["message", message.role];
        if (message.error) classes.push("error");
        const body = message.pre
          ? '<pre>' + escapeHtml(message.text) + '</pre>'
          : '<div class="content">' + escapeHtml(message.text) + '</div>';
        return '<section class="' + classes.join(' ') + '" data-id="' + message.id + '"><div class="role">' + escapeHtml(roleLabel(message.role)) + '</div>' + body + '</section>';
      }).join("");
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    function addMessage(role, text, options = {}) {
      const message = { id: options.id || uid(role), role, text: text || "", pre: !!options.pre, error: !!options.error };
      state.messages.push(message);
      save();
      render();
      return message;
    }
    function findMessage(id) { return state.messages.find(message => message.id === id); }
    function ensureAssistant() {
      if (state.currentAssistantId) {
        const existing = findMessage(state.currentAssistantId);
        if (existing) return existing;
      }
      const message = addMessage("assistant", "");
      state.currentAssistantId = message.id;
      return message;
    }
    function appendAssistant(delta) {
      const message = ensureAssistant();
      message.text += delta;
      save();
      render();
    }
    function setRunning(value) {
      state.running = value;
      state.status = value ? "Pi is running..." : "Idle";
      if (!value) state.currentAssistantId = null;
      save();
      render();
    }
    function textFromContent(content) {
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return content.map(block => {
        if (!block || typeof block !== "object") return "";
        if (block.type === "text") return block.text || "";
        if (block.type === "thinking") return "";
        if (block.type === "toolCall") return "\n[tool] " + (block.name || "tool");
        return "";
      }).filter(Boolean).join("\n");
    }
    function textFromToolResult(result) {
      const content = result && result.content;
      if (!Array.isArray(content)) return "";
      return content.map(block => block && block.type === "text" ? block.text || "" : "").join("\n");
    }
    function handleRpcEvent(event) {
      switch (event.type) {
        case "agent_start":
          setRunning(true);
          break;
        case "agent_end":
          setRunning(false);
          break;
        case "message_update": {
          const delta = event.assistantMessageEvent;
          if (delta && delta.type === "text_delta") appendAssistant(delta.delta || "");
          break;
        }
        case "message_end": {
          const message = event.message;
          if (message && message.role === "assistant") {
            const text = textFromContent(message.content);
            if (text) {
              const current = ensureAssistant();
              current.text = text;
              save();
              render();
            }
          }
          break;
        }
        case "tool_execution_start":
          addMessage("tool", (event.toolName || "tool") + " started\n" + JSON.stringify(event.args || {}, null, 2), { id: event.toolCallId, pre: true });
          break;
        case "tool_execution_update": {
          const message = findMessage(event.toolCallId);
          if (message) {
            message.text = (event.toolName || "tool") + " running\n" + textFromToolResult(event.partialResult);
            save();
            render();
          }
          break;
        }
        case "tool_execution_end": {
          const message = findMessage(event.toolCallId) || addMessage("tool", "", { id: event.toolCallId, pre: true });
          message.text = (event.toolName || "tool") + " " + (event.isError ? "failed" : "completed") + "\n" + textFromToolResult(event.result);
          message.error = !!event.isError;
          save();
          render();
          break;
        }
        case "queue_update":
          state.status = "Queued: " + (event.steering || []).length + " steer, " + (event.followUp || []).length + " follow-up";
          save();
          render();
          break;
        case "compaction_start":
          addMessage("system", "Compaction started (" + (event.reason || "manual") + ").");
          break;
        case "compaction_end":
          addMessage("system", event.errorMessage ? "Compaction failed: " + event.errorMessage : "Compaction finished.");
          break;
        case "extension_error":
          addMessage("system", "Extension error: " + (event.error || "unknown"), { error: true });
          break;
        case "response":
          if (event.success === false) addMessage("system", String(event.error || "Command failed"), { error: true });
          break;
      }
    }
    function handleExtensionUiRequest(request) {
      const method = request.method;
      if (method === "notify") {
        addMessage("system", request.message || "Notification", { error: request.notifyType === "error" });
        return;
      }
      if (method === "setStatus") {
        state.status = request.statusText || "Idle";
        save();
        render();
        return;
      }
      if (method === "setTitle") return;
      if (method === "setWidget") {
        if (request.widgetLines) addMessage("system", request.widgetLines.join("\n"));
        return;
      }
      if (method === "set_editor_text") {
        inputEl.value = request.text || "";
        inputEl.focus();
        return;
      }

      let response = { type: "extension_ui_response", id: request.id };
      if (method === "confirm") {
        response.confirmed = window.confirm((request.title || "Confirm") + "\n\n" + (request.message || ""));
      } else if (method === "input") {
        const value = window.prompt(request.title || "Input", request.placeholder || "");
        if (value === null) response.cancelled = true;
        else response.value = value;
      } else if (method === "editor") {
        const value = window.prompt(request.title || "Editor", request.prefill || "");
        if (value === null) response.cancelled = true;
        else response.value = value;
      } else if (method === "select") {
        const options = request.options || [];
        const value = window.prompt((request.title || "Select") + "\n\n" + options.map((option, index) => (index + 1) + ". " + option).join("\n"));
        const index = Number(value) - 1;
        if (!Number.isInteger(index) || index < 0 || index >= options.length) response.cancelled = true;
        else response.value = options[index];
      } else {
        response.cancelled = true;
      }
      vscode.postMessage({ type: "extensionUiResponse", response });
    }

    sendEl.addEventListener("click", () => {
      const text = inputEl.value;
      if (!text.trim()) return;
      addMessage("user", text.trim());
      inputEl.value = "";
      vscode.postMessage({ type: "prompt", text });
    });
    stopEl.addEventListener("click", () => vscode.postMessage({ type: "abort" }));
    newSessionEl.addEventListener("click", () => vscode.postMessage({ type: "newSession" }));
    inputEl.addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendEl.click();
      }
    });

    window.addEventListener("message", event => {
      const message = event.data;
      if (!message || typeof message !== "object") return;
      if (message.type === "rpcEvent") handleRpcEvent(message.event);
      if (message.type === "extensionUiRequest") handleExtensionUiRequest(message.request);
      if (message.type === "system") addMessage("system", message.text || "", { error: /error|failed|closed/i.test(message.text || "") });
      if (message.type === "stderr") addMessage("system", message.text || "", { pre: true });
      if (message.type === "running") setRunning(!!message.value);
      if (message.type === "reset") {
        state.messages = [];
        state.currentAssistantId = null;
        state.running = false;
        state.status = "New session";
        save();
        render();
      }
      if (message.type === "state") {
        const model = message.state && message.state.model;
        const sessionName = message.state && message.state.sessionName;
        state.status = [sessionName, model && (model.name || model.id)].filter(Boolean).join(" • ") || (state.running ? "Running" : "Idle");
        save();
        render();
      }
    });

    render();
    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
  }
}

interface PiConfiguration {
  piPath: string;
  extraArgs: string[];
  persistSessions: boolean;
  defaultStreamingBehavior: "followUp" | "steer";
}

type WebviewToExtensionMessage =
  | { type: "ready" }
  | { type: "prompt"; text: string }
  | { type: "abort" }
  | { type: "newSession" }
  | { type: "getState" }
  | { type: "extensionUiResponse"; response: unknown };

type ExtensionToWebviewMessage =
  | { type: "rpcEvent"; event: PiRpcMessage }
  | { type: "extensionUiRequest"; request: PiRpcMessage }
  | { type: "system"; text: string }
  | { type: "stderr"; text: string }
  | { type: "running"; value: boolean }
  | { type: "reset" }
  | { type: "state"; state: unknown };

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
