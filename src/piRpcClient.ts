import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import * as vscode from "vscode";

export type PiRpcMessage = Record<string, unknown>;

export interface PiRpcClientOptions {
  piPath: string;
  cwd?: string;
  persistSessions: boolean;
  extraArgs: string[];
}

interface PendingRequest {
  resolve: (message: PiRpcMessage) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class PiRpcClient implements vscode.Disposable {
  private process?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private readonly decoder = new StringDecoder("utf8");
  private requestId = 0;
  private readonly pending = new Map<string, PendingRequest>();

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
    return this.process !== undefined && !this.process.killed;
  }

  start(): void {
    if (this.isStarted) return;

    const args = ["--mode", "rpc"];
    if (!this.options.persistSessions) args.push("--no-session");
    args.push(...this.options.extraArgs);

    this.process = spawn(this.options.piPath, args, {
      cwd: this.options.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    this.process.stderr.on("data", (chunk: Buffer) => {
      this.stderrEmitter.fire(chunk.toString("utf8"));
    });
    this.process.on("error", (error) => {
      this.rejectAll(error);
      this.errorEmitter.fire(error);
    });
    this.process.on("close", (code, signal) => {
      this.rejectAll(new Error(`pi RPC process closed (${code ?? "null"}${signal ? `, ${signal}` : ""})`));
      this.closeEmitter.fire({ code, signal });
      this.process = undefined;
      this.buffer = "";
    });
  }

  send(command: PiRpcMessage): void {
    this.start();
    const proc = this.process;
    if (!proc) throw new Error("pi RPC process is not available");
    proc.stdin.write(`${JSON.stringify(command)}\n`);
  }

  request(command: PiRpcMessage, timeoutMs = 30_000): Promise<PiRpcMessage> {
    this.start();
    const id = typeof command.id === "string" ? command.id : `req-${++this.requestId}`;
    const payload = { ...command, id };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for response to ${String(command.type ?? "command")}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timeout });

      try {
        this.send(payload);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  dispose(): void {
    this.rejectAll(new Error("pi RPC client disposed"));
    this.process?.kill();
    this.process = undefined;
    this.eventEmitter.dispose();
    this.stderrEmitter.dispose();
    this.closeEmitter.dispose();
    this.errorEmitter.dispose();
  }

  private handleStdout(chunk: Buffer): void {
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
}
