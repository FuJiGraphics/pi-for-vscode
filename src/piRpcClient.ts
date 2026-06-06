import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import * as vscode from "vscode";
import type { PiRpcMessage } from "./protocol";

export type { PiRpcMessage } from "./protocol";

export interface PiRpcClientOptions {
  piPath: string;
  /** "executable": spawn piPath directly. "node-script": spawn nodePath with piPath. */
  launchKind: "executable" | "node-script";
  /** Node binary used when launchKind === "node-script". */
  nodePath?: string;
  /** When true the broker keeps ELECTRON_RUN_AS_NODE set (nodePath is VS Code's Electron). */
  runAsNode: boolean;
  cwd?: string;
  persistSessions: boolean;
  extraArgs: string[];
  /** Initial pi model (qualified "provider/id[:thinking]"); switched at runtime via set_model. */
  model?: string;
  /** BYOK API keys injected into the pi child env, keyed by env var name. */
  secrets?: Record<string, string>;
  brokerScriptPath: string;
  brokerStoragePath: string;
  brokerIdleTimeoutMs: number;
}

interface PendingRequest {
  resolve: (message: PiRpcMessage) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class PiRpcClient implements vscode.Disposable {
  private socket?: net.Socket;
  private connected = false;
  private starting?: Promise<void>;
  private disposed = false;
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  private requestId = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private brokerId?: string;
  private brokerSocketPath?: string;
  private brokerLogPath?: string;

  private readonly eventEmitter = new vscode.EventEmitter<PiRpcMessage>();
  private readonly stderrEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<{ code: number | null; signal: NodeJS.Signals | null }>();
  private readonly errorEmitter = new vscode.EventEmitter<Error>();

  readonly onEvent = this.eventEmitter.event;
  readonly onStderr = this.stderrEmitter.event;
  readonly onClose = this.closeEmitter.event;
  readonly onError = this.errorEmitter.event;

  constructor(private readonly options: PiRpcClientOptions) {}

  get isStarted(): boolean {
    return this.connected || this.starting !== undefined;
  }

  start(): void {
    void this.ensureStarted().catch((error) => {
      this.rejectAll(error instanceof Error ? error : new Error(String(error)));
      if (!this.disposed) this.errorEmitter.fire(error instanceof Error ? error : new Error(String(error)));
    });
  }

  send(command: PiRpcMessage): void {
    void this.sendAsync(command).catch((error) => {
      if (!this.disposed) this.errorEmitter.fire(error instanceof Error ? error : new Error(String(error)));
    });
  }

  request(command: PiRpcMessage, timeoutMs = 30_000): Promise<PiRpcMessage> {
    const id = typeof command.id === "string" ? command.id : `req-${++this.requestId}`;
    const payload = { ...command, id };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for response to ${String(command.type ?? "command")}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timeout });

      void this.sendAsync(payload).catch((error) => {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  dispose(): void {
    this.disposed = true;
    this.rejectAll(new Error("pi RPC client disposed"));
    this.socket?.destroy();
    this.socket = undefined;
    this.connected = false;
    this.eventEmitter.dispose();
    this.stderrEmitter.dispose();
    this.closeEmitter.dispose();
    this.errorEmitter.dispose();
  }

  private async sendAsync(command: PiRpcMessage): Promise<void> {
    if (this.disposed) throw new Error("pi RPC client disposed");
    await this.ensureStarted();

    const socket = this.socket;
    if (!socket || socket.destroyed || !this.connected) throw new Error("Pi background broker is not connected");

    await new Promise<void>((resolve, reject) => {
      socket.write(`${JSON.stringify(command)}\n`, "utf8", (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private async ensureStarted(): Promise<void> {
    if (this.disposed) throw new Error("pi RPC client disposed");
    if (this.connected && this.socket && !this.socket.destroyed) return;
    if (this.starting) return this.starting;

    this.starting = this.connectToBroker().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async connectToBroker(): Promise<void> {
    const socketPath = this.getBrokerSocketPath();

    try {
      await this.openSocket(socketPath, 250);
      return;
    } catch {
      // No broker is currently listening. Launch one below.
    }

    this.launchBroker(socketPath);

    const deadline = Date.now() + 12_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        await this.openSocket(socketPath, 750);
        return;
      } catch (error) {
        lastError = error;
        await delay(150);
      }
    }

    const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error");
    throw new Error(`Failed to connect to Pi background broker. Log: ${this.getBrokerLogPath()}. Last error: ${detail}`);
  }

  private openSocket(socketPath: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      let settled = false;

      const cleanup = () => {
        clearTimeout(timer);
        socket.removeListener("connect", onConnect);
        socket.removeListener("error", onError);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy();
        reject(error);
      };
      const onConnect = () => {
        if (settled) return;
        if (this.disposed) {
          fail(new Error("pi RPC client disposed"));
          return;
        }
        settled = true;
        cleanup();
        this.attachSocket(socket);
        resolve();
      };
      const onError = (error: Error) => fail(error);
      const timer = setTimeout(() => fail(new Error(`Timed out connecting to ${socketPath}`)), timeoutMs);

      socket.once("connect", onConnect);
      socket.once("error", onError);
    });
  }

  private attachSocket(socket: net.Socket): void {
    this.socket?.destroy();
    this.socket = socket;
    this.connected = true;
    this.buffer = "";
    this.decoder = new StringDecoder("utf8");

    socket.on("data", (chunk: Buffer) => this.handleSocketData(chunk));
    socket.on("error", (error) => {
      if (this.disposed) return;
      this.rejectAll(error instanceof Error ? error : new Error(String(error)));
      this.errorEmitter.fire(error instanceof Error ? error : new Error(String(error)));
    });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.connected = false;
      this.buffer = "";
      if (this.disposed) return;
      this.rejectAll(new Error("Pi background broker connection closed"));
      this.closeEmitter.fire({ code: null, signal: null });
    });
  }

  private launchBroker(socketPath: string): void {
    if (!fs.existsSync(this.options.brokerScriptPath)) {
      throw new Error(`Pi broker script not found: ${this.options.brokerScriptPath}`);
    }

    fs.mkdirSync(this.options.brokerStoragePath, { recursive: true });
    if (process.platform !== "win32") fs.mkdirSync(path.dirname(socketPath), { recursive: true });

    const brokerConfig = {
      socketPath,
      piPath: this.options.piPath,
      launchKind: this.options.launchKind,
      nodePath: this.options.nodePath,
      runAsNode: this.options.runAsNode,
      cwd: this.options.cwd,
      persistSessions: this.options.persistSessions,
      extraArgs: this.options.extraArgs,
      model: this.options.model,
      secrets: this.options.secrets,
      idleTimeoutMs: this.options.brokerIdleTimeoutMs,
      logPath: this.getBrokerLogPath(),
    };

    const child = spawn(process.execPath, [this.options.brokerScriptPath], {
      cwd: this.options.cwd,
      detached: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        PI_FOR_VSCODE_BROKER_CONFIG: JSON.stringify(brokerConfig),
      },
      stdio: "ignore",
    });
    child.unref();
  }

  private handleSocketData(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);

    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) break;

      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;

    let message: PiRpcMessage;
    try {
      message = JSON.parse(line) as PiRpcMessage;
    } catch (error) {
      this.errorEmitter.fire(new Error(`Failed to parse pi RPC JSON: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }

    if (message.type === "broker_ready") return;

    if (message.type === "stderr") {
      if (typeof message.text === "string") this.stderrEmitter.fire(message.text);
      return;
    }

    if (message.type === "broker_error") {
      const error = new Error(String(message.error ?? "Pi background broker error"));
      this.rejectAll(error);
      this.errorEmitter.fire(error);
      return;
    }

    if (message.type === "broker_pi_close") {
      this.rejectAll(new Error("Pi RPC process closed"));
      this.closeEmitter.fire({ code: typeof message.code === "number" ? message.code : null, signal: isNodeSignal(message.signal) ? message.signal : null });
      return;
    }

    if (message.type === "response" && typeof message.id === "string") {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        clearTimeout(pending.timeout);
        pending.resolve(message);
      }
    }

    this.eventEmitter.fire(message);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private getBrokerId(): string {
    if (!this.brokerId) {
      this.brokerId = createHash("sha256")
        .update(JSON.stringify({
          piPath: this.options.piPath,
          launchKind: this.options.launchKind,
          nodePath: this.options.nodePath ?? "",
          runAsNode: this.options.runAsNode,
          cwd: this.options.cwd ?? "",
          persistSessions: this.options.persistSessions,
          extraArgs: this.options.extraArgs,
        }))
        .digest("hex")
        .slice(0, 24);
    }
    return this.brokerId;
  }

  private getBrokerSocketPath(): string {
    if (!this.brokerSocketPath) {
      const id = this.getBrokerId();
      this.brokerSocketPath = process.platform === "win32"
        ? `\\\\.\\pipe\\pi-for-vscode-${id}`
        : path.join(os.tmpdir(), "pi-for-vscode", `${id}.sock`);
    }
    return this.brokerSocketPath;
  }

  private getBrokerLogPath(): string {
    if (!this.brokerLogPath) {
      this.brokerLogPath = path.join(this.options.brokerStoragePath, `broker-${this.getBrokerId()}.log`);
    }
    return this.brokerLogPath;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNodeSignal(value: unknown): value is NodeJS.Signals {
  return typeof value === "string";
}
