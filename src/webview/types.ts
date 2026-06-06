// UI-side data shapes for the chat webview. These describe how messages and
// activity are held in the webview's local state, independent of the pi RPC
// wire format (which arrives as loosely-typed PiRpcMessage events).
import type { ImageAttachment } from "../protocol";

export type UiRole = "user" | "assistant" | "system" | "tool";

export interface UiImageAttachment extends ImageAttachment {
  id: string;
  name: string;
}

export interface ActivityStep {
  id: string;
  label: string;
  detail: string;
  status: "running" | "done" | "error";
  startedAt: number;
  endedAt?: number;
}

export interface Activity {
  startedAt: number;
  endedAt: number | null;
  expanded: boolean;
  steps: ActivityStep[];
}

export interface UiPrompt {
  kind: "confirm";
  requestId: string;
  resolved?: boolean;
}

export interface UiMessage {
  id: string;
  role: UiRole;
  text: string;
  pre?: boolean;
  error?: boolean;
  createdAt: number;
  attachments?: UiImageAttachment[];
  activity?: Activity;
  ui?: UiPrompt;
  /** Characters of `text` revealed so far for the typewriter effect. Only set
   * on the live-streaming assistant message; undefined means "show in full". */
  revealed?: number;
}

export interface AppState {
  messages: UiMessage[];
  running: boolean;
  status: string;
  modelLabel: string;
  sessionName: string;
  sessionFile: string;
  thinkingLevel: string;
  thinkingLevels: string[];
  currentAssistantId: string | null;
  lastSentText: string;
  lastSentAt: number;
}
