import type * as vscode from "vscode";
import type { PiRpcClient } from "./piRpcClient";
import type { PiRpcMessage } from "./protocol";

// One independent Pi execution context. Each running session gets its own runtime,
// which owns its own broker socket + `pi --mode rpc` process. The client is connected
// only while the runtime is ACTIVE or RUNNING; a background+idle runtime drops its
// client and survives as a stub (id/sessionFile/model) so its detached broker idle-reaps
// the pi and a later activation can reattach (warm) or respawn from disk (cold).
export interface SessionRuntime {
  readonly id: string;
  client?: PiRpcClient;
  cwd: string;
  sessionFile?: string;
  isRunning: boolean;
  model?: string;
  pendingUiRequest?: PiRpcMessage;
  /** Whether the webview has been given this session's initial view (state + messages). */
  seeded?: boolean;
  readonly disposables: vscode.Disposable[];
}

export interface PiConfiguration {
  extraArgs: string[];
  persistSessions: boolean;
  defaultStreamingBehavior: "followUp" | "steer";
  brokerIdleTimeoutMinutes: number;
}
