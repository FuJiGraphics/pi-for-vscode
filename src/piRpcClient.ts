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

// Transport keepalive / recovery tuning. The host↔broker link is a local UNIX
// socket (or named pipe) with no built-in idle timeout, so a half-open socket
// after the laptop sleeps stays "connected" until we probe it. The heartbeat
// detects that within ~one interval; reconnect reattaches to the still-running
// detached broker (or relaunches it) with capped exponential backoff + jitter.
const HEARTBEAT_INTERVAL_MS = 20_000;
const HEARTBEAT_TIMEOUT_MS = 4_000;
const MAX_RECONNECT_ATTEMPTS = 6;
const RECONNECT_BASE_MS = 500;
const RECONNECT_CAP_MS = 10_000;

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
  brokerScriptPath: string;
  brokerStoragePath: string;
  brokerIdleTimeoutMs: number;
  /**
   * Distinguishes multiple concurrent runtimes for the same workspace/config so
   * each running session gets its OWN broker + pi process. Folded into the broker
   * identity hash. Omitted (undefined) reproduces the legacy single cwd-hash broker.
   */
  instanceId?: string;
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
  private heartbeatTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempts = 0;
  private reconnecting = false;

  private readonly eventEmitter = new vscode.EventEmitter<PiRpcMessage>();
  private readonly stderrEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<{ code: number | null; signal: NodeJS.Signals | null }>();
  private readonly errorEmitter = new vscode.EventEmitter<Error>();
  private readonly reconnectingEmitter = new vscode.EventEmitter<void>();
  private readonly reconnectedEmitter = new vscode.EventEmitter<void>();

  readonly onEvent = this.eventEmitter.event;
  readonly onStderr = this.stderrEmitter.event;
  /** Terminal close: pi process died, or transport reconnection was exhausted. */
  readonly onClose = this.closeEmitter.event;
  readonly onError = this.errorEmitter.event;
  /** A transport drop was detected; auto-reconnect has started. */
  readonly onReconnecting = this.reconnectingEmitter.event;
  /** The socket was re-attached after a drop; callers should resync state. */
  readonly onReconnected = this.reconnectedEmitter.event;

  constructor(private readonly options: PiRpcClientOptions) {}

  get isStarted(): boolean {
    // `reconnecting` keeps this true through the backoff window so callers don't
    // tear down and recreate a client that is already recovering itself.
    return this.connected || this.starting !== undefined || this.reconnecting;
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

  /**
   * Immediately verify the link is alive (used on wake / view-visible). Sends a
   * heartbeat now; if it fails, the heartbeat path tears down the dead socket and
   * begins reconnecting. Cheap no-op when already disconnected/reconnecting.
   */
  probe(): void {
    if (this.disposed) return;
    if (!this.connected || !this.socket || this.socket.destroyed) {
      this.beginReconnect();
      return;
    }
    void this.sendHeartbeat();
  }

  /**
   * Best-effort teardown that first asks the detached broker to shut down, so it
   * doesn't outlive the extension host with an orphaned pi (matches Claude Code:
   * the process dies on reload, the transcript on disk is the resume source). The
   * shutdown line is written synchronously into the socket buffer before we tear
   * down; if it doesn't land, the broker's idle timeout reaps the pi as a backstop.
   */
  disposeAndShutdownBroker(): void {
    const socket = this.socket;
    if (socket && !socket.destroyed && this.connected) {
      try {
        socket.write(`${JSON.stringify({ type: "broker_shutdown" })}\n`);
      } catch {
        // best-effort; idle timeout backstops
      }
    }
    this.dispose();
  }

  dispose(): void {
    this.disposed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.reconnecting = false;
    this.rejectAll(new Error("pi RPC client disposed"));
    this.socket?.destroy();
    this.socket = undefined;
    this.connected = false;
    this.eventEmitter.dispose();
    this.stderrEmitter.dispose();
    this.closeEmitter.dispose();
    this.errorEmitter.dispose();
    this.reconnectingEmitter.dispose();
    this.reconnectedEmitter.dispose();
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
    this.startHeartbeat();

    socket.on("data", (chunk: Buffer) => this.handleSocketData(chunk));
    socket.on("error", (error) => {
      if (this.disposed) return;
      // A transport error is a transient drop, not a user-facing failure — fail any
      // in-flight requests but stay quiet; the trailing "close" drives reconnect and
      // the banner. (broker_error / parse / start errors still surface via onError.)
      this.rejectAll(error instanceof Error ? error : new Error(String(error)));
    });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.resetConnection();
      if (this.disposed) return;
      this.rejectAll(new Error("Pi background broker connection closed"));
      // A dropped socket (sleep/half-open/broker restart) is recoverable: reattach
      // to the running broker instead of surfacing a terminal close right away.
      this.beginReconnect();
    });
  }

  // ---- transport keepalive + auto-reconnect ----------------------------------

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => void this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  // Drop the current socket's bookkeeping (not the socket object itself — callers
  // capture/destroy it as needed). Shared by the "close" handler and the heartbeat
  // failure path so the two stay in lockstep.
  private resetConnection(): void {
    this.socket = undefined;
    this.connected = false;
    this.buffer = "";
    this.stopHeartbeat();
  }

  private async sendHeartbeat(): Promise<void> {
    if (this.disposed || !this.connected || !this.socket || this.socket.destroyed) return;
    try {
      await this.request({ type: "ping" }, HEARTBEAT_TIMEOUT_MS);
    } catch {
      if (this.disposed) return;
      // No pong within the window → the socket is dead/half-open. Capture it first
      // so resetConnection() leaves the "close" handler inert, then destroy + reconnect.
      const dead = this.socket;
      this.resetConnection();
      dead?.destroy();
      this.rejectAll(new Error("Pi heartbeat timed out"));
      this.beginReconnect();
    }
  }

  private beginReconnect(): void {
    if (this.disposed || this.reconnecting) return;
    this.reconnecting = true;
    this.reconnectAttempts = 0;
    this.reconnectingEmitter.fire();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    const attempt = this.reconnectAttempts++;
    if (attempt >= MAX_RECONNECT_ATTEMPTS) {
      this.reconnecting = false;
      this.closeEmitter.fire({ code: null, signal: null });
      return;
    }
    const backoff = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** attempt);
    const delayMs = backoff + Math.floor(Math.random() * 250);
    this.reconnectTimer = setTimeout(() => void this.attemptReconnect(), delayMs);
    this.reconnectTimer.unref?.();
  }

  private async attemptReconnect(): Promise<void> {
    if (this.disposed) return;
    try {
      // ensureStarted dedupes with any concurrent user-triggered send and reuses
      // connectToBroker (reattach to the live broker, else relaunch one).
      await this.ensureStarted();
      this.reconnecting = false;
      this.reconnectAttempts = 0;
      this.reconnectedEmitter.fire();
    } catch {
      this.scheduleReconnect();
    }
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
      // Heartbeat acks are pure transport noise — don't surface them as events.
      if (message.command === "ping") return;
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
          // Last key on purpose: undefined is dropped by JSON.stringify, so a client
          // with no instanceId hashes byte-identically to the legacy single-broker id.
          instanceId: this.options.instanceId,
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
