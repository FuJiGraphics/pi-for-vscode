// Message protocol shared between the extension host and the webview.
// This module must stay free of node/vscode imports so the webview bundle
// (built by esbuild) can import it without pulling in host-only dependencies.

export type PiRpcMessage = Record<string, unknown>;

export interface SessionListItem {
  filePath: string;
  title: string;
  preview?: string;
  meta: string;
  isCurrent: boolean;
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
  | { type: "commandList"; commands: CommandListItem[] };
