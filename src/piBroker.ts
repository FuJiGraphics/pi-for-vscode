import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { PI_NO_RESTART_COMMANDS } from "./protocol";

interface BrokerConfig {
  socketPath: string;
  piPath: string;
  launchKind: "executable" | "node-script";
  nodePath?: string;
  runAsNode: boolean;
  cwd?: string;
  persistSessions: boolean;
  extraArgs: string[];
  idleTimeoutMs: number;
  logPath?: string;
}

type JsonMessage = Record<string, unknown>;

const config = readConfig();
const clients = new Set<net.Socket>();
let piProcess: ChildProcessWithoutNullStreams | undefined;
let stdoutBuffer = "";
let stdoutDecoder = new StringDecoder("utf8");
let isAgentRunning = false;
let idleTimer: NodeJS.Timeout | undefined;
let shuttingDown = false;

process.title = "pi-for-vscode-broker";

function readConfig(): BrokerConfig {
  const raw = process.env.PI_FOR_VSCODE_BROKER_CONFIG;
  if (!raw) throw new Error("PI_FOR_VSCODE_BROKER_CONFIG is required");

  const parsed = JSON.parse(raw) as Partial<BrokerConfig>;
  if (!parsed.socketPath || !parsed.piPath) {
    throw new Error("Invalid Pi broker configuration: socketPath and piPath are required");
  }

  return {
    socketPath: parsed.socketPath,
    piPath: parsed.piPath,
    launchKind: parsed.launchKind === "node-script" ? "node-script" : "executable",
    nodePath: parsed.nodePath,
    runAsNode: parsed.runAsNode === true,
    cwd: parsed.cwd,
    persistSessions: parsed.persistSessions ?? true,
    extraArgs: Array.isArray(parsed.extraArgs) ? parsed.extraArgs : [],
    idleTimeoutMs: typeof parsed.idleTimeoutMs === "number" ? parsed.idleTimeoutMs : 30 * 60 * 1000,
    logPath: parsed.logPath,
  };
}

function log(message: string, error?: unknown): void {
  const suffix = error instanceof Error ? ` ${error.stack ?? error.message}` : error === undefined ? "" : ` ${String(error)}`;
  const line = `[${new Date().toISOString()}] ${message}${suffix}\n`;
  if (!config.logPath) return;

  try {
    fs.mkdirSync(path.dirname(config.logPath), { recursive: true });
    fs.appendFileSync(config.logPath, line, "utf8");
  } catch {
    // Detached broker has no stderr. Ignore logging failures.
  }
}

function startPi(): void {
  if (piProcess && !piProcess.killed) return;

  const args = ["--mode", "rpc"];
  if (!config.persistSessions) args.push("--no-session");
  args.push(...config.extraArgs);

  const env = { ...process.env };
  delete env.PI_FOR_VSCODE_BROKER_CONFIG;

  let command: string;
  let commandArgs: string[];
  if (config.launchKind === "node-script") {
    // The bundled pi is a Node ESM script with no usable shebang once it leaves a
    // global bin dir, so run it under an explicit Node binary.
    command = config.nodePath ?? process.execPath;
    commandArgs = [config.piPath, ...args];
    // When nodePath is VS Code's Electron, ELECTRON_RUN_AS_NODE must stay set or it
    // boots the Electron UI instead of behaving as Node.
    if (config.runAsNode) env.ELECTRON_RUN_AS_NODE = "1";
    else delete env.ELECTRON_RUN_AS_NODE;
  } else {
    // A real executable (system pi or a user-configured path): spawn it directly.
    command = config.piPath;
    commandArgs = args;
    delete env.ELECTRON_RUN_AS_NODE;
  }

  log(`Starting pi RPC: ${command} ${commandArgs.join(" ")}`);
  stdoutBuffer = "";
  stdoutDecoder = new StringDecoder("utf8");
  const proc = spawn(command, commandArgs, {
    cwd: config.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  piProcess = proc;

  proc.stdout.on("data", (chunk: Buffer) => {
    if (piProcess !== proc) return;
    handlePiStdout(chunk);
  });
  proc.stderr.on("data", (chunk: Buffer) => {
    if (piProcess !== proc) return;
    broadcastJson({ type: "stderr", text: chunk.toString("utf8") });
  });
  proc.on("error", (error) => {
    log("Pi process error", error);
    broadcastJson({ type: "broker_error", error: error.message });
  });
  proc.on("close", (code, signal) => {
    if (piProcess !== proc) return;
    log(`Pi process closed (${code ?? "null"}${signal ? `, ${signal}` : ""})`);
    isAgentRunning = false;
    piProcess = undefined;
    broadcastJson({ type: "broker_pi_close", code, signal });
    scheduleIdleShutdown();
  });
}

function handlePiStdout(chunk: Buffer): void {
  stdoutBuffer += stdoutDecoder.write(chunk);

  while (true) {
    const newlineIndex = stdoutBuffer.indexOf("\n");
    if (newlineIndex === -1) break;

    let line = stdoutBuffer.slice(0, newlineIndex);
    stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    handlePiLine(line);
  }
}

function handlePiLine(line: string): void {
  if (!line.trim()) return;

  try {
    const message = JSON.parse(line) as JsonMessage;
    if (message.type === "agent_start") isAgentRunning = true;
    if (message.type === "agent_end") {
      isAgentRunning = false;
      scheduleIdleShutdown();
    }
  } catch (error) {
    log("Failed to parse pi stdout JSON", error);
  }

  broadcastLine(`${line}\n`);
}

function handleClient(socket: net.Socket): void {
  clients.add(socket);
  clearIdleShutdown();
  startPi();

  const decoder = new StringDecoder("utf8");
  let buffer = "";

  socket.on("data", (chunk: Buffer) => {
    buffer += decoder.write(chunk);

    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) break;

      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      handleClientLine(socket, line);
    }
  });

  socket.on("error", (error) => log("Client socket error", error));
  socket.on("close", () => {
    clients.delete(socket);
    scheduleIdleShutdown();
  });

  socket.write(`${JSON.stringify({ type: "broker_ready" })}\n`);
}

function handleClientLine(socket: net.Socket, line: string): void {
  if (!line.trim()) return;

  let command: JsonMessage;
  try {
    command = JSON.parse(line) as JsonMessage;
  } catch (error) {
    socket.write(`${JSON.stringify({ type: "response", command: "parse", success: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    return;
  }

  // Transport keepalive: the client heartbeats with `ping` to detect a dead /
  // half-open socket (e.g. after the laptop sleeps). The broker answers directly
  // and never forwards it to pi, so it neither wakes nor restarts the agent.
  if (command.type === "ping") {
    socket.write(`${JSON.stringify({ type: "response", id: command.id, command: "ping", success: true })}\n`);
    return;
  }

  if (command.type === "broker_shutdown") {
    socket.write(`${JSON.stringify({ type: "response", id: command.id, command: "broker_shutdown", success: true })}\n`);
    void shutdown(0);
    return;
  }

  // Only restart a dead Pi process for commands that initiate new work.
  // get_state and abort must not restart Pi — restarting on get_state creates a
  // loop where postState() after agent_end respawns Pi, which auto-resumes the
  // interrupted session and hits the same provider error (e.g. usage limit) again.
  if (!PI_NO_RESTART_COMMANDS.has(String(command.type))) startPi();

  const proc = piProcess;
  if (!proc || proc.stdin.destroyed) {
    socket.write(`${JSON.stringify({ type: "response", id: command.id, command: String(command.type ?? "command"), success: false, error: "Pi process is not available" })}\n`);
    return;
  }

  proc.stdin.write(`${line}\n`);
}

function broadcastJson(message: JsonMessage): void {
  broadcastLine(`${JSON.stringify(message)}\n`);
}

function broadcastLine(line: string): void {
  for (const client of clients) {
    if (!client.destroyed && client.writable) client.write(line);
  }
}

function clearIdleShutdown(): void {
  if (!idleTimer) return;
  clearTimeout(idleTimer);
  idleTimer = undefined;
}

function scheduleIdleShutdown(): void {
  clearIdleShutdown();
  if (clients.size > 0 || isAgentRunning || shuttingDown) return;

  if (config.idleTimeoutMs <= 0) {
    void shutdown(0);
    return;
  }

  idleTimer = setTimeout(() => {
    if (clients.size === 0 && !isAgentRunning) void shutdown(0);
  }, config.idleTimeoutMs);
  idleTimer.unref();
}

async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearIdleShutdown();
  log("Shutting down broker");

  for (const client of clients) client.destroy();
  clients.clear();

  if (piProcess && !piProcess.killed) {
    piProcess.kill();
    piProcess = undefined;
  }

  await closeServer();
  cleanupSocketFile();
  process.exit(exitCode);
}

function cleanupSocketFile(): void {
  if (process.platform === "win32") return;
  try {
    if (fs.existsSync(config.socketPath)) fs.unlinkSync(config.socketPath);
  } catch (error) {
    log("Failed to remove socket file", error);
  }
}

function prepareSocketPath(): void {
  if (process.platform === "win32") return;
  fs.mkdirSync(path.dirname(config.socketPath), { recursive: true });
  try {
    if (fs.existsSync(config.socketPath)) fs.unlinkSync(config.socketPath);
  } catch (error) {
    log("Failed to prepare socket path", error);
  }
}

const server = net.createServer(handleClient);

function closeServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
process.on("uncaughtException", (error) => {
  log("Uncaught broker exception", error);
  broadcastJson({ type: "broker_error", error: error.message });
  void shutdown(1);
});
process.on("unhandledRejection", (reason) => {
  log("Unhandled broker rejection", reason);
  broadcastJson({ type: "broker_error", error: reason instanceof Error ? reason.message : String(reason) });
});

prepareSocketPath();
startPi();
server.listen(config.socketPath, () => {
  log(`Broker listening on ${config.socketPath}`);
  scheduleIdleShutdown();
});
server.on("error", (error) => {
  log("Broker server error", error);
  void shutdown(1);
});
