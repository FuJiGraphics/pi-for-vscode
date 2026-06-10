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

export interface PiAgentStartEvent {
  type: "agent_start";
}
/** `agent_end` carries `willRetry` when pi will auto-retry the just-ended run via
 *  agent.continue() — i.e. the SAME logical turn continues in a fresh run, so the UI must
 *  not finalize/fragment its current bubble. See agent-loop.js runAgentLoopContinue. */
export interface PiAgentEndEvent {
  type: "agent_end";
  willRetry?: boolean;
}
/** `turn_start`/`turn_end` bracket one LLM call. A single agent run (or logical exchange)
 *  contains MANY turns during a tool-use loop, so they are NOT bubble boundaries. */
export interface PiTurnEvent {
  type: "turn_start" | "turn_end";
}
/** `message_start`/`message_end` fire for user, assistant, AND toolResult messages — the
 *  `message.role` discriminates. A `role:"user"` `message_start` is the boundary of a new
 *  logical exchange (initial prompt, steering, or follow-up). See agent-loop.js L50-52,95-98. */
export interface PiMessageStartEvent {
  type: "message_start";
  message?: PiMessage;
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
/** pi auto-retries a transient provider failure INSIDE the same logical turn (it re-emits
 *  agent_start via agent.continue()), so the UI shows progress without starting a new bubble. */
export interface PiAutoRetryEvent {
  type: "auto_retry_start" | "auto_retry_end";
  attempt?: number;
  maxAttempts?: number;
  errorMessage?: string;
}
/** The session's display name changed (pi auto-title or an explicit rename). */
export interface PiSessionInfoChangedEvent {
  type: "session_info_changed";
  name?: string;
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
export const BROKER_COMMANDS: ReadonlySet<string> = new Set(["ping", "broker_shutdown"]);

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

/** Pi-reported pricing, USD per million tokens. Passed through verbatim — pi's model
 *  registry is the authority; the extension never hardcodes prices. */
export interface ModelCost {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ModelListItem {
  /** Stable webview id, qualified as "<provider>/<modelId>". */
  id: string;
  /** Bare Pi model id sent to `set_model`, e.g. "claude-sonnet-4-20250514". */
  modelId: string;
  /** Display label shown as the title, usually Pi's full model name. */
  model: string;
  /** Pi provider id sent to `set_model`, e.g. "anthropic". */
  provider: string;
  /** Whether the model supports a thinking level (capability flag). */
  thinking: boolean;
  isCurrent: boolean;
  /** Omitted when pi doesn't report pricing (older pi / custom models). */
  cost?: ModelCost;
  /** Context window in tokens, when pi reports it. */
  contextWindow?: number;
  /** Max output tokens per response, when pi reports it. */
  maxTokens?: number;
  /** Model accepts image input (pi's `input` array contains "image"). */
  vision?: boolean;
}

/** Pi's `get_session_stats`, mapped 1:1 (pi computes cost and the compaction-aware context
 *  estimate — the webview only renders). `context.tokens`/`percent` are null right after a
 *  compaction (unknown until the next assistant response); the whole `context` field is
 *  omitted when pi reports none (no model / zero contextWindow / older pi). */
export interface SessionStats {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  /** Total session cost in USD. */
  cost: number;
  context?: { tokens: number | null; contextWindow: number; percent: number | null };
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
  | { type: "setModel"; provider: string; modelId: string }
  | { type: "setThinkingLevel"; level: string }
  | { type: "login" }
  | { type: "logout" }
  | { type: "getState" }
  | { type: "copy"; text?: string }
  | { type: "openExternal"; url: string }
  // Open a workspace file the user clicked in a rendered message. Path is workspace-relative (or
  // absolute); the host resolves + reveals the line, and silently no-ops if it doesn't exist.
  | { type: "openFile"; path: string; line?: number; col?: number }
  // Code-block actions: insert the snippet at the active editor's cursor, or hand it to Pi to apply
  // (Pi owns the edit; we don't reimplement a merge model).
  | { type: "insertCode"; text: string }
  | { type: "applyCode"; text: string }
  // Connection lifecycle: the webview nudges the host to verify/reconnect the
  // broker socket — `wake` after a sleep/visibility gap, `reconnect` from the
  // disconnected banner's Retry button.
  | { type: "wake" }
  | { type: "reconnect" }
  // Pull the authoritative session usage/cost/context stats (sent on activate; the host
  // also pushes after agent_end and compaction_end).
  | { type: "requestSessionStats" }
  | { type: "extensionUiResponse"; response: unknown };

// Per-session messages carry `sessionId` (the host runtime id) so the webview can keep a
// separate view per session and apply background sessions' events to their own view —
// switching is then a pure in-memory swap (`activate`) with no re-fetch, preserving each
// session's full conversation + activity timeline.
export type ExtensionToWebviewMessage =
  | { type: "rpcEvent"; sessionId: string; event: PiRpcMessage }
  // Tool output (bash stdout, read content, web results) read from the session file after a
  // tool finishes — the live RPC stream carries only tool INPUT, so outputs are enriched here.
  | { type: "toolOutput"; sessionId: string; toolCallId: string; text: string; isError: boolean; diff?: string; firstChangedLine?: number }
  | { type: "extensionUiRequest"; request: PiRpcMessage }
  | { type: "system"; text: string }
  | { type: "stderr"; text: string }
  | { type: "running"; sessionId: string; value: boolean }
  | { type: "reset" }
  | { type: "state"; sessionId: string; state: unknown }
  | { type: "sessionMessages"; sessionId: string; messages: unknown[]; force?: boolean }
  // Make `sessionId` the visible session (instant swap to its cached view).
  | { type: "activate"; sessionId: string }
  // Forget a session's cached view (its runtime was fully reaped/deleted).
  | { type: "dropSession"; sessionId: string }
  | { type: "sessionList"; sessions: SessionListItem[] }
  | { type: "modelList"; models: ModelListItem[] }
  // Authoritative cumulative usage/cost/context for one session (pi's get_session_stats).
  | { type: "sessionStats"; sessionId: string; stats: SessionStats }
  // `authAvailable` reflects whether the bundled auth bridge registered its login command in
  // this pi runtime (derived from get_commands). Omitted when unknown (e.g. RPC failure) —
  // the webview then keeps the optimistic default.
  | { type: "commandList"; commands: CommandListItem[]; authAvailable?: boolean }
  // The active VS Code editor theme, so the webview's Shiki highlighter tracks the editor. `theme`
  // is the resolved VS Code theme JSON (tokenColors etc.) when the host could read it; `kind`
  // always selects a bundled fallback theme. Re-sent on theme change.
  | { type: "theme"; theme?: unknown; kind: "light" | "dark" | "highContrast" | "highContrastLight" }
  // Drives the slim connection banner under the header. "connected" auto-hides.
  | { type: "connection"; status: "reconnecting" | "connected" | "disconnected" }
  // The active editor's file (and selected line range) for the composer's context chip.
  // A pathless post hides the chip (untitled / outside the workspace / no editor).
  // 1-based inclusive lines. Carries a REFERENCE only — file content never crosses here.
  | { type: "editorContext"; path?: string; startLine?: number; endLine?: number };
