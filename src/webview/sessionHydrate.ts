// Rebuilds the webview conversation from pi's on-disk session messages. A run of
// consecutive assistant + toolResult messages folds into ONE UiMessage whose activity
// timeline matches what the live event stream produces: thinking blocks → (intermediate)
// narration text steps → tool steps enriched with their toolResult outputs. Restored
// sessions are therefore structurally indistinguishable from live ones (asserted by
// the rpcSequences parity test).
import { state } from "./state";
import { scheduleRender } from "./render";
import { prettifyToolName, summarizeArgs, textFromContent } from "./conversation";
import { thinkingStepFromBlock } from "./thinkingSteps";
import { TEXT_STEP_MAX } from "./textSteps";
import type { ActivityStep, UiImageAttachment, UiMessage } from "./types";

// Mirrors the host's truncateToolOutput (stateHelpers.ts) — the webview tsconfig only
// includes src/webview + protocol.ts, so the 6-line helper is copied rather than imported.
const OUTPUT_MAX_CHARS = 4000;
const OUTPUT_MAX_LINES = 40;
function truncateOutput(text: string): string {
  let out = text.length > OUTPUT_MAX_CHARS ? text.slice(0, OUTPUT_MAX_CHARS) + "\n…(truncated)" : text;
  const lines = out.split("\n");
  if (lines.length > OUTPUT_MAX_LINES) out = lines.slice(0, OUTPUT_MAX_LINES).join("\n") + "\n…(truncated)";
  return out;
}

function blocksOf(content: unknown): Array<Record<string, unknown>> {
  return Array.isArray(content)
    ? content.filter((b): b is Record<string, unknown> => !!b && typeof b === "object")
    : [];
}

function imageAttachmentFromBlock(block: Record<string, unknown>, index: number): UiImageAttachment | undefined {
  if (block.type !== "image") return undefined;

  let data = typeof block.data === "string" ? block.data : "";
  let mimeType = typeof block.mimeType === "string" ? block.mimeType : "";
  const source = block.source && typeof block.source === "object" ? block.source as Record<string, unknown> : undefined;
  if (!data && source?.type === "base64" && typeof source.data === "string") data = source.data;
  if (!mimeType && source?.type === "base64" && typeof source.media_type === "string") mimeType = source.media_type;

  data = data.trim();
  mimeType = mimeType.trim().toLowerCase();
  if (!data || !mimeType.startsWith("image/")) return undefined;
  const extension = mimeType.split("/")[1] || "image";
  return {
    id: "session-image-" + index + "-" + data.slice(0, 10),
    name: "image." + extension,
    data,
    mimeType,
  };
}

function imageAttachmentsFromContent(content: unknown): UiImageAttachment[] {
  return blocksOf(content)
    .map((block, index) => imageAttachmentFromBlock(block, index))
    .filter((attachment): attachment is UiImageAttachment => Boolean(attachment));
}

/** user / custom / compactionSummary messages map one-to-one (assistant runs fold separately). */
function simpleMessageToUi(message: any, index: number): UiMessage | null {
  if (!message || typeof message !== "object") return null;
  const timestamp = typeof message.timestamp === "number" ? message.timestamp : Date.now();
  if (message.role === "user") {
    const text = textFromContent(message.content, false).trim();
    const attachments = imageAttachmentsFromContent(message.content);
    return text || attachments.length > 0
      ? { id: "session-user-" + index + "-" + timestamp, role: "user", text, attachments, createdAt: timestamp }
      : null;
  }
  if (message.role === "custom" && message.display) {
    const text = textFromContent(message.content, true).trim();
    return text ? { id: "session-custom-" + index + "-" + timestamp, role: "system", text, createdAt: timestamp } : null;
  }
  if (message.role === "compactionSummary" && message.summary) {
    return {
      id: "session-summary-" + index + "-" + timestamp,
      role: "system",
      text: "Compacted context: " + message.summary,
      createdAt: timestamp,
    };
  }
  return null;
}

/** Fold one run of consecutive assistant/toolResult messages into a single UiMessage.
 *  Per assistant message, steps land in live-stream order: thinking blocks (as streamed),
 *  the narration text (demoted when the message is intermediate — has toolCalls, stopped
 *  for toolUse, or is not the run's last), then the tool steps. Tool step ids reuse the
 *  on-disk toolCall ids, identical to live ids. */
function foldAssistantRun(run: any[], firstIndex: number): UiMessage | null {
  const assistants = run.filter((m) => m.role === "assistant");
  if (assistants.length === 0) return null;
  const results = new Map<string, any>();
  for (const m of run) {
    if (m.role === "toolResult" && typeof m.toolCallId === "string") results.set(m.toolCallId, m);
  }

  const firstTs = typeof assistants[0].timestamp === "number" ? assistants[0].timestamp : Date.now();
  const last = run[run.length - 1];
  const lastTs = typeof last.timestamp === "number" ? last.timestamp : firstTs;
  const steps: ActivityStep[] = [];
  let bubble = "";
  let tokens = 0;
  let cost = 0;

  assistants.forEach((message, mi) => {
    const ts = typeof message.timestamp === "number" ? message.timestamp : firstTs;
    const blocks = blocksOf(message.content);
    const toolCalls = blocks.filter((b) => b.type === "toolCall");
    const intermediate =
      toolCalls.length > 0 || message.stopReason === "toolUse" || mi < assistants.length - 1;

    blocks
      .filter((b) => b.type === "thinking")
      .forEach((b, bi) => {
        const step = thinkingStepFromBlock(b, ts, bi, firstIndex + mi);
        if (step.thinkingText || step.redacted) steps.push(step);
      });

    const text = textFromContent(message.content, false).trim();
    if (text) {
      if (intermediate) {
        steps.push({
          id: "session-text-" + firstIndex + "-" + mi + "-" + ts,
          kind: "text",
          label: "",
          detail: "",
          status: "done",
          startedAt: ts,
          endedAt: ts,
          text: text.length > TEXT_STEP_MAX ? text.slice(0, TEXT_STEP_MAX) + "\n… [truncated]" : text,
        });
      } else {
        bubble = text;
      }
    }

    // Usage folds into the turn totals only (the done header's chip) — no timeline node,
    // mirroring live recordUsage.
    const usage = message.usage;
    const t = typeof usage?.totalTokens === "number" && Number.isFinite(usage.totalTokens) ? usage.totalTokens : 0;
    const c = typeof usage?.cost?.total === "number" && Number.isFinite(usage.cost.total) ? usage.cost.total : 0;
    tokens += t;
    cost += c;

    toolCalls.forEach((block, bi) => {
      const id = typeof block.id === "string" && block.id ? block.id : "session-tool-" + firstIndex + "-" + mi + "-" + bi;
      const name = typeof block.name === "string" && block.name ? block.name : "tool";
      const args = block.arguments && typeof block.arguments === "object" ? (block.arguments as Record<string, unknown>) : undefined;
      const result = results.get(id);
      const step: ActivityStep = {
        id,
        label: prettifyToolName(name),
        detail: summarizeArgs(args),
        status: result?.isError ? "error" : "done",
        startedAt: ts,
        endedAt: ts,
        tool: name,
        input: args,
      };
      if (result) {
        const details = result.details && typeof result.details === "object" ? (result.details as Record<string, unknown>) : undefined;
        step.output = {
          text: truncateOutput(textFromContent(result.content, true)),
          isError: !!result.isError,
          diff: typeof details?.diff === "string" ? details.diff : undefined,
          firstChangedLine: typeof details?.firstChangedLine === "number" ? details.firstChangedLine : undefined,
        };
      }
      steps.push(step);
    });
  });

  if (!bubble && steps.length === 0) return null;
  return {
    id: "session-assistant-" + firstIndex + "-" + firstTs,
    role: "assistant",
    text: bubble,
    createdAt: firstTs,
    tokens: tokens || undefined,
    cost: cost || undefined,
    activity: steps.length
      ? { startedAt: firstTs, endedAt: lastTs, expanded: true, steps }
      : undefined,
  };
}

export function hydrateSessionMessages(messages: unknown): void {
  const list = Array.isArray(messages) ? messages : [];
  const converted: UiMessage[] = [];
  let i = 0;
  while (i < list.length) {
    const m: any = list[i];
    if (m && typeof m === "object" && (m.role === "assistant" || m.role === "toolResult")) {
      const start = i;
      const run: any[] = [];
      while (i < list.length) {
        const r: any = list[i];
        if (r && typeof r === "object" && (r.role === "assistant" || r.role === "toolResult")) {
          run.push(r);
          i++;
        } else break;
      }
      const folded = foldAssistantRun(run, start);
      if (folded) converted.push(folded);
      continue;
    }
    const single = simpleMessageToUi(m, i);
    if (single) converted.push(single);
    i++;
  }
  state.messages = converted;
  state.currentAssistantId = null;
  scheduleRender();
}
