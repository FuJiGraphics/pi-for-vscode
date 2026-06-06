// Message protocol shared between the extension host and the webview.
// This module must stay free of node/vscode imports so the webview bundle
// (built by esbuild) can import it without pulling in host-only dependencies.

export type PiRpcMessage = Record<string, unknown>;

// ---- Pi RPC wire contract (host ↔ pi) ----
//
// Pi's RPC payloads arrive as loose PiRpcMessage records — that looseness is
// deliberate, so pi can ADD events/fields without breaking us (handlers ignore
// unknown event types). These interfaces type only the fields we already read,
// so a pi *rename* (e.g. message.role → message.actor) trips tsc instead of
// silently no-op'ing at runtime. They are read-side views, not validators:
// every field stays optional because the wire is still untrusted.

/** A block inside an assistant/user message's `content` array. */
export interface PiContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  source?: { type?: string; data?: string; media_type?: string };
}

/** The `message` payload on a `message_end` event. */
export interface PiMessage {
  role?: string;
  content?: PiContentBlock[] | string;
  errorMessage?: string;
  stopReason?: string;
  timestamp?: number;
}

/** The streaming delta carried by a `message_update` event. */
export interface PiAssistantMessageDelta {
  type?: string;
  delta?: string;
}

export interface PiAgentLifecycleEvent {
  type: "agent_start" | "agent_end";
}
export interface PiMessageUpdateEvent {
  type: "message_update";
  assistantMessageEvent?: PiAssistantMessageDelta;
}
export interface PiMessageEndEvent {
  type: "message_end";
  message?: PiMessage;
}
export interface PiToolExecutionEvent {
  type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end";
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  isError?: boolean;
}
export interface PiQueueUpdateEvent {
  type: "queue_update";
  steering?: unknown[];
  followUp?: unknown[];
}
export interface PiCompactionEvent {
  type: "compaction_start" | "compaction_end";
  reason?: string;
  errorMessage?: string;
}
export interface PiExtensionErrorEvent {
  type: "extension_error";
  error?: string;
}

/** Envelope every `request()` resolves with (built by the broker / forwarded from pi). */
export interface PiRpcResponse {
  type: "response";
  id?: string;
  command?: string;
  success?: boolean;
  error?: string;
  data?: unknown;
}

// Commands the broker handles itself instead of forwarding to pi's stdin.
// Used by piBroker.handleClientLine to separate broker vocabulary from pi
// passthrough — keep in sync with the cases in handleClientLine.
// (`ping` is the transport keepalive: answered directly, never reaches pi.)
export const BROKER_COMMANDS: ReadonlySet<string> = new Set(["ping", "broker_shutdown", "set_model"]);

// Commands that must NOT respawn a dead pi process (they are read-only / control
// only). Restarting pi on these would auto-resume an interrupted session and
// re-hit the original provider error — see the comment in handleClientLine.
export const PI_NO_RESTART_COMMANDS: ReadonlySet<string> = new Set(["get_state", "abort"]);

export interface SessionListItem {
  filePath: string;
  title: string;
  preview?: string;
  meta: string;
  isCurrent: boolean;
  /** A background pi runtime is mid-turn on this session (shows a running badge). */
  isRunning?: boolean;
  /** That runtime has a buffered extension_ui_request awaiting activation (shows a needs-input badge). */
  needsInput?: boolean;
}

export interface ModelListItem {
  /** Qualified id passed back to pi via --model, e.g. "openai-codex/gpt-5.5". */
  id: string;
  /** Bare model id shown as the title, e.g. "gpt-5.5". */
  model: string;
  provider: string;
  /** Whether the model supports a thinking level (capability flag). */
  thinking: boolean;
  isCurrent: boolean;
}

/** A slash command Pi exposes via the `get_commands` RPC (skill / prompt-template / extension). */
export interface CommandListItem {
  /** Text inserted after the slash, e.g. "review" or "skill:foo" (no leading slash). */
  name: string;
  description: string;
  source: "extension" | "prompt" | "skill";
  scope?: "user" | "project" | "temporary";
  /** Short badge tag computed host-side, e.g. "p", "u:npm:foo". */
  sourceTag?: string;
}

export interface ImageAttachment {
  data: string;
  mimeType: string;
  name?: string;
  width?: number;
  height?: number;
}

export type WebviewToExtensionMessage =
  | { type: "ready"; hasMessages?: boolean; sessionFile?: string }
  | { type: "prompt"; text: string; images?: ImageAttachment[] }
  | { type: "abort" }
  | { type: "newSession" }
  | { type: "sessions" }
  | { type: "requestSessions" }
  | { type: "switchSession"; sessionPath: string }
  | { type: "deleteSession"; sessionPath: string }
  | { type: "renameSession"; sessionPath: string; name: string }
  | { type: "requestModels" }
  | { type: "requestCommands" }
  | { type: "setModel"; modelId: string }
  | { type: "setThinkingLevel"; level: string }
  | { type: "addProviderKey" }
  | { type: "getState" }
  | { type: "copy"; text?: string }
  // Connection lifecycle: the webview nudges the host to verify/reconnect the
  // broker socket — `wake` after a sleep/visibility gap, `reconnect` from the
  // disconnected banner's Retry button.
  | { type: "wake" }
  | { type: "reconnect" }
  | { type: "extensionUiResponse"; response: unknown };

export type ExtensionToWebviewMessage =
  | { type: "rpcEvent"; event: PiRpcMessage }
  | { type: "extensionUiRequest"; request: PiRpcMessage }
  | { type: "system"; text: string }
  | { type: "stderr"; text: string }
  | { type: "running"; value: boolean }
  | { type: "reset" }
  | { type: "state"; state: unknown }
  | { type: "sessionMessages"; messages: unknown[]; force?: boolean }
  | { type: "sessionList"; sessions: SessionListItem[] }
  | { type: "modelList"; models: ModelListItem[] }
  | { type: "commandList"; commands: CommandListItem[] }
  // Drives the slim connection banner under the header. "connected" auto-hides.
  | { type: "connection"; status: "reconnecting" | "connected" | "disconnected" };
