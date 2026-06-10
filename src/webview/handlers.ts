// Translates inbound Pi RPC events into conversation state changes.
import { state } from "./state";
import { scheduleRender } from "./render";
import {
  addMessage,
  appendAssistant,
  ensureActivity,
  ensureAssistant,
  prettifyToolName,
  recordActivity,
  recordUsage,
  setRunning,
  summarizeArgs,
  textFromContent,
} from "./conversation";
import { closeExchangeBoundary } from "./turnBoundary";
import { flashConnectionNotice } from "./connectionBanner";
import { ensureAnimating } from "./animator";
import { applyThinkingEvent } from "./thinkingSteps";

export { handleExtensionUiRequest } from "./extensionUi";

function formatTurnError(raw: unknown): string {
  const text = String(raw ?? "").trim();
  const braceAt = text.indexOf("{");
  if (braceAt !== -1) {
    try {
      const parsed = JSON.parse(text.slice(braceAt)) as { message?: unknown; error?: { message?: unknown } };
      const inner = parsed?.error?.message ?? parsed?.message;
      if (typeof inner === "string" && inner) {
        const prefix = text.slice(0, braceAt).replace(/[:\s]+$/, "").trim();
        return prefix ? `${prefix}: ${inner}` : inner;
      }
    } catch {
      // Not JSON; fall through to the raw text.
    }
  }
  return text || "The model returned an error.";
}

const TRANSIENT_DISCONNECT_RE = /idle timeout|websocket|connection|disconnect|econnreset|timed out/i;

export function handleRpcEvent(event: any): void {
  switch (event.type) {
    case "agent_start":
      setRunning(true);
      break;
    case "agent_end":
      if (!event.willRetry) setRunning(false);
      break;
    case "turn_start":
    case "turn_end":
      break;
    case "message_start":
      if (event.message?.role === "user") closeExchangeBoundary();
      break;
    case "message_update": {
      if (!state.running) break;
      const delta = event.assistantMessageEvent;
      if (!delta) break;
      if (delta.type === "text_delta" && delta.delta) {
        appendAssistant(delta.delta);
      } else if (delta.type === "thinking_start" || delta.type === "thinking_delta" || delta.type === "thinking_end") {
        applyThinkingEvent(ensureActivity(), delta);
        ensureAnimating();
        scheduleRender();
      }
      break;
    }
    case "message_end": {
      if (!state.running) break;
      const message = event.message;
      if (message && message.role === "assistant") {
        recordUsage(message.usage);
        if (message.errorMessage) {
          const text = formatTurnError(message.errorMessage);
          if (TRANSIENT_DISCONNECT_RE.test(text)) {
            flashConnectionNotice("Connection interrupted - the turn was paused. Continue when ready.");
          } else {
            addMessage("system", text, { error: true });
          }
          setRunning(false);
          break;
        }
        const text = textFromContent(message.content);
        if (text) {
          const current = ensureAssistant();
          current.text = text;
          ensureAnimating();
          scheduleRender();
        } else if (message.stopReason === "error") {
          addMessage("system", "The model ended the turn with an error and no response.", { error: true });
          setRunning(false);
        }
      }
      break;
    }
    case "tool_execution_start":
      if (!state.running) break;
      recordActivity(
        event.toolCallId,
        prettifyToolName(event.toolName),
        summarizeArgs(event.args),
        "running",
        event.args && typeof event.args === "object" ? (event.args as Record<string, unknown>) : undefined,
        typeof event.toolName === "string" ? event.toolName : undefined,
      );
      break;
    case "tool_execution_update":
      if (!state.running) break;
      recordActivity(event.toolCallId, prettifyToolName(event.toolName), "", "running");
      break;
    case "tool_execution_end":
      if (!state.running) break;
      recordActivity(event.toolCallId, prettifyToolName(event.toolName), "", event.isError ? "error" : "done");
      if (event.isError) ensureActivity().expanded = true;
      break;
    case "queue_update": {
      const queued = (event.steering || []).length + (event.followUp || []).length;
      state.status = queued > 0 ? queued + " queued" : "";
      scheduleRender();
      break;
    }
    case "compaction_start":
      recordActivity("compaction", "Compacting context", event.reason || "", "running");
      break;
    case "compaction_end":
      recordActivity(
        "compaction",
        event.errorMessage ? "Compaction failed" : "Compaction finished",
        event.errorMessage || "",
        event.errorMessage ? "error" : "done",
      );
      break;
    case "auto_retry_start": {
      const attempt = typeof event.attempt === "number" ? event.attempt : undefined;
      const max = typeof event.maxAttempts === "number" ? event.maxAttempts : undefined;
      recordActivity("auto-retry", "Retrying", attempt && max ? `attempt ${attempt}/${max}` : "", "running");
      break;
    }
    case "auto_retry_end":
      recordActivity("auto-retry", event.success === false ? "Retry failed" : "Retried", "", event.success === false ? "error" : "done");
      break;
    case "session_info_changed":
      break;
    case "extension_error":
      addMessage("system", "Extension error: " + (event.error || "unknown"), { error: true });
      break;
  }
}

export function handleStderr(text: string): void {
  const trimmed = String(text || "").trim();
  if (!trimmed) return;
  if (/error|failed|exception|traceback/i.test(trimmed)) {
    addMessage("system", trimmed, { error: true, pre: trimmed.length > 240 });
  } else if (state.running) {
    recordActivity("stderr-" + trimmed.slice(0, 24), "Pi status", trimmed.slice(0, 120), "running");
  }
}
