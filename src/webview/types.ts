// UI-side data shapes for the chat webview. These describe how messages and
// activity are held in the webview's local state, independent of the pi RPC
// wire format (which arrives as loosely-typed PiRpcMessage events).
import type { ImageAttachment, SessionStats } from "../protocol";

/** Per-call token breakdown (from pi's message.usage) for the usage tooltips. */
export interface UsageBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

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
  /** Marks a thinking block or a demoted narration text segment (vs a tool step).
   *  (Older persisted views may still carry kind:"generation" checkpoint rows — those
   *  are filtered out on restore; see sessionStore.sanitizeView.) */
  kind?: "thinking" | "text";
  /** kind === "text" only: intermediate narration markdown demoted from the bubble at a
   *  toolUse boundary. IMMUTABLE after creation (safe to fold its length into render keys). */
  text?: string;
  /** kind === "thinking" only: the accumulated reasoning text. VOLATILE for rendering —
   *  must stay out of the message render key (the live painter updates it per frame). */
  thinkingText?: string;
  /** kind === "thinking" only: pi sent a redacted_thinking block. */
  redacted?: boolean;
  /** Raw pi tool name (e.g. "edit", "write", "web_search", "todo") — the prettified verb
   *  in `label` collapses several tools to one word, so card rendering keys off this. */
  tool?: string;
  /** Raw tool input args (e.g. {command}, {path,offset,limit}) for rich card rendering. */
  input?: Record<string, unknown>;
  /** Tool output enriched from the session file (bash stdout, read content, web result).
   *  `diff` carries pi's real line-numbered unified diff for `edit` (upgrades the diff card
   *  from the synthetic args-based one); `firstChangedLine` is its first changed line. */
  output?: { text: string; isError: boolean; diff?: string; firstChangedLine?: number };
  /** Per-step expand state for showing the output/diff card. */
  expanded?: boolean;
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
  /** Token usage for this turn, summed across its API calls (from pi's message.usage). */
  tokens?: number;
  /** Cost in USD for this turn, summed across its API calls. */
  cost?: number;
  /** Input/output/cache breakdown summed across the turn's API calls (usage tooltip). */
  usage?: UsageBreakdown;
  /** This turn was cut off (user pressed Stop, or VS Code closed mid-turn) — renders an
   *  inline "Interrupted" marker below the turn. */
  interrupted?: boolean;
  /** User message sent mid-run, still waiting in pi's steer/follow-up queue — renders
   *  dimmed with a "Queued" chip until pi echoes its message_start. */
  pending?: boolean;
}

export interface AppState {
  messages: UiMessage[];
  running: boolean;
  modelLabel: string;
  sessionName: string;
  sessionFile: string;
  thinkingLevel: string;
  thinkingLevels: string[];
  currentAssistantId: string | null;
  lastSentText: string;
  lastSentAt: number;
  /** Cumulative token usage for the visible session (sum of every turn's usage). */
  sessionTokens: number;
  /** Cumulative cost in USD for the visible session. */
  sessionCost: number;
  /** Authoritative session stats from pi's get_session_stats (tokens/cost/context %).
   *  recordUsage bumps tokens/cost optimistically mid-turn; the agent_end push replaces
   *  the whole object, self-correcting any drift. */
  stats?: SessionStats;
  /** This session was mid-turn when VS Code last closed — shows an "interrupted" notice
   *  until the user continues. Set on restore from persisted state; cleared on next turn. */
  interrupted?: boolean;
}
