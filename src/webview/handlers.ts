// Translates inbound pi RPC events and extension UI requests into conversation
// state changes. Event payloads are loosely typed (PiRpcMessage), so each
// handler reads the fields it expects defensively.
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
import { inputEl } from "./dom";
import { post } from "./bridge";
import { flashConnectionNotice } from "./connectionBanner";
import { ensureAnimating } from "./animator";
import { autoResizeInput, updateInputState } from "./input";

// pi wraps provider failures like: `Codex error: {"type":"error","status":400,
// "error":{"message":"..."}}`. Pull out the human-readable message when present.
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
      // Not JSON — fall through to the raw text.
    }
  }
  return text || "The model returned an error.";
}

// A turn whose error text matches this is almost certainly a transient transport
// drop (e.g. the laptop slept and pi's provider socket idled out), not a real
// model/auth failure — so we soften it and let the connection banner own recovery.
// This sniffs pi's *formatted* message because pi exposes no structured transport
// flag; widen the list if pi rewords these errors.
const TRANSIENT_DISCONNECT_RE = /idle timeout|websocket|connection|disconnect|econnreset|timed out/i;

export function handleRpcEvent(event: any): void {
  switch (event.type) {
    case "agent_start":
      // A fresh run: usually a new prompt (currentAssistantId already nulled by submitInput's
      // idle-reset → new bubble), or a retry/compaction continuation (id still alive → the same
      // bubble is reused). setRunning(true)→ensureActivity()→ensureAssistant() handles both.
      setRunning(true);
      break;
    case "agent_end":
      // willRetry: pi will re-run this SAME logical turn via agent.continue() (a fresh
      // agent_start follows). Don't finalize/clear the bubble or the retry fragments into a new
      // one — keep running so the spinner stays and the bubble is reused.
      if (!event.willRetry) setRunning(false);
      break;
    case "turn_start":
    case "turn_end":
      // One LLM call within a run. NOT an exchange boundary (a tool-use loop emits many turns
      // per user message), so the bubble is unaffected — intentional no-op.
      break;
    case "message_start":
      // pi emits message_start for user, assistant, AND toolResult messages. A `user` one marks
      // a new logical exchange (steering / follow-up / the initial prompt): close out the
      // current bubble so the reply opens a fresh one below the (locally-added) user message.
      // assistant/toolResult message_start are no-ops (text/steps arrive via the events below).
      if (event.message?.role === "user") closeExchangeBoundary();
      break;
    case "message_update": {
      if (!state.running) break;
      const delta = event.assistantMessageEvent;
      if (delta && delta.type === "text_delta" && delta.delta) appendAssistant(delta.delta);
      break;
    }
    case "message_end": {
      if (!state.running) break;
      const message = event.message;
      if (message && message.role === "assistant") {
        // Token/cost usage rides on the assistant message — accumulate it for display.
        recordUsage(message.usage);
        // A turn can end in an error (e.g. provider/model/auth rejection) with no
        // content. A transient provider drop (sleep idle-timeout / websocket) is NOT a
        // real failure, so we surface it as a brief, auto-hiding banner notice instead of
        // cluttering the conversation; real errors still post to the chat. Either way we
        // clear `running` so the spinner can't stick if the trailing agent_end was lost.
        if (message.errorMessage) {
          const text = formatTurnError(message.errorMessage);
          const transient = TRANSIENT_DISCONNECT_RE.test(text);
          if (transient) {
            flashConnectionNotice("Connection interrupted — the turn was paused. Continue when ready.");
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
      if (event.isError) {
        const activity = ensureActivity();
        activity.expanded = true;
      }
      break;
    case "queue_update":
      state.status = "Queued: " + ((event.steering || []).length + (event.followUp || []).length) + " follow-up";
      scheduleRender();
      break;
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
      // A transient provider failure inside the current turn — pi retries automatically (a fresh
      // agent_start follows). Show it as a live timeline step on the SAME bubble so the spinner
      // reads as "still working" rather than stalled. (No `running` guard: agent_end{willRetry}
      // already kept us running, but be defensive — the bubble must exist.)
      const attempt = typeof event.attempt === "number" ? event.attempt : undefined;
      const max = typeof event.maxAttempts === "number" ? event.maxAttempts : undefined;
      const detail = attempt && max ? `attempt ${attempt}/${max}` : "";
      recordActivity("auto-retry", "Retrying", detail, "running");
      break;
    }
    case "auto_retry_end":
      recordActivity("auto-retry", event.success === false ? "Retry failed" : "Retried", "", event.success === false ? "error" : "done");
      break;
    case "session_info_changed":
      // The session title changed (pi auto-title / rename). The webview's title comes from the
      // host's `state` post; the host reacts to this event (rpcEventRouter) — webview no-op.
      break;
    case "extension_error":
      addMessage("system", "Extension error: " + (event.error || "unknown"), { error: true });
      break;
  }
}

export function handleExtensionUiRequest(request: any): void {
  const method = request.method;
  if (method === "notify") {
    addMessage("system", request.message || "Notification", { error: request.notifyType === "error" });
    return;
  }
  if (method === "setStatus") {
    // The status subtitle under the title was removed — there's no surface for this,
    // and we never want a "Pi is working" filler. Intentionally ignored.
    return;
  }
  if (method === "setTitle") return;
  if (method === "setWidget") {
    if (request.widgetLines) recordActivity("widget", "Status", request.widgetLines.join(String.fromCharCode(10)), "running");
    return;
  }
  if (method === "set_editor_text") {
    inputEl.value = request.text || "";
    autoResizeInput();
    updateInputState();
    inputEl.focus();
    return;
  }

  if (method === "confirm") {
    const text = [request.title || "Approval requested", request.message || ""]
      .filter(Boolean)
      .join(String.fromCharCode(10) + String.fromCharCode(10));
    addMessage("system", text, { ui: { kind: "confirm", requestId: request.id } });
    return;
  }

  const response: Record<string, unknown> = { type: "extension_ui_response", id: request.id };
  if (method === "input") {
    const value = window.prompt(request.title || "Input", request.placeholder || "");
    if (value === null) response.cancelled = true;
    else response.value = value;
  } else if (method === "editor") {
    const value = window.prompt(request.title || "Editor", request.prefill || "");
    if (value === null) response.cancelled = true;
    else response.value = value;
  } else if (method === "select") {
    const options: string[] = request.options || [];
    const newline = String.fromCharCode(10);
    const value = window.prompt(
      (request.title || "Select") + newline + newline + options.map((option, index) => index + 1 + ". " + option).join(newline),
    );
    const index = Number(value) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= options.length) response.cancelled = true;
    else response.value = options[index];
  } else {
    response.cancelled = true;
  }
  post({ type: "extensionUiResponse", response });
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
