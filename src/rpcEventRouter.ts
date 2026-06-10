import type { PiRpcMessage } from "./protocol";
import type { SessionRuntime } from "./sessionRuntime";
import type { SessionStatsService } from "./sessionStatsService";
import type { WebviewPresenter } from "./webviewPresenter";
import { readToolResult } from "./sessionStore";
import { truncateToolOutput } from "./stateHelpers";

// The runtime-manager surface the router calls back into. Bound after both are constructed
// (manager↔router are mutually referential — see SessionRuntimeManager / the composition root).
export interface RpcEventSink {
  activeId(): string | undefined;
  setRunning(rt: SessionRuntime, value: boolean): void;
  postState(): Promise<unknown>;
  postSessionList(): Promise<void>;
  onBackgroundRuntimeFinished(rt: SessionRuntime): void;
}

// Translates one runtime's RPC event stream into presenter posts + manager state transitions.
// Wired by createClientForRuntime's client.onEvent. Owns no state.
export class RpcEventRouter {
  private sink!: RpcEventSink;

  constructor(
    private readonly presenter: WebviewPresenter,
    private readonly stats: SessionStatsService,
  ) {}

  bind(sink: RpcEventSink): void {
    this.sink = sink;
  }

  handleRpcEvent(rt: SessionRuntime, event: PiRpcMessage): void {
    const isActive = rt.id === this.sink.activeId();

    if (event.type === "agent_start") {
      this.sink.setRunning(rt, true);
      // A just-started (e.g. brand-new) session appears / re-sorts in the history list.
      void this.sink.postSessionList();
    } else if (event.type === "agent_end") {
      // willRetry: pi re-runs the SAME turn via agent.continue() (a fresh agent_start follows).
      // Keep the runtime "running" so isRunning (which chatViewProvider.prompt reads to pick a
      // streamingBehavior) and the history badge don't flip between retries.
      if (!(event as { willRetry?: boolean }).willRetry) {
        this.sink.setRunning(rt, false);
        if (isActive) void this.sink.postState();
        else this.sink.onBackgroundRuntimeFinished(rt);
        void this.sink.postSessionList();
        // Authoritative usage/cost/context after the run settles — once per run, also for
        // background runtimes (the tagged post lands in their cached view).
        void this.stats.postStats(rt);
      }
    } else if (event.type === "compaction_end") {
      // Context usage drops sharply after a compaction — refresh the bar immediately.
      void this.stats.postStats(rt);
    } else if (event.type === "thinking_level_changed") {
      if (isActive) void this.sink.postState();
    } else if (event.type === "session_info_changed") {
      // pi changed the session title (auto-title / rename): refresh the active header + the
      // history list so the new name shows without a manual reload.
      if (isActive) void this.sink.postState();
      void this.sink.postSessionList();
    }

    if (event.type === "extension_ui_request") {
      if (isActive) {
        this.presenter.post({ type: "extensionUiRequest", request: event });
      } else {
        // A background pi is blocked waiting for human input it can't show. Buffer it (one
        // slot — pi blocks one at a time); we never auto-answer. It replays on activate.
        rt.pendingUiRequest = event;
        void this.sink.postSessionList();
      }
      return;
    }

    // The live stream carries only tool INPUT — enrich the finished step with its output
    // (bash stdout / read content / web result) read from the session file.
    if (event.type === "tool_execution_end") void this.enrichToolStep(rt, event.toolCallId);

    // Forward EVERY runtime's events, tagged with its session id. The webview keeps a view
    // per session and applies background events to their own view (without rendering), so
    // switching back shows the full, up-to-date conversation + timeline.
    this.presenter.post({ type: "rpcEvent", sessionId: rt.id, event });
  }

  // Read a finished tool's output from the session file and forward it to the webview so the
  // step card can show it (bash OUT, read content, web result). Retries briefly since pi may
  // flush the toolResult a beat after signalling tool_execution_end.
  private async enrichToolStep(rt: SessionRuntime, toolCallId: unknown): Promise<void> {
    if (typeof toolCallId !== "string" || !toolCallId || !rt.sessionFile) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await readToolResult(rt.sessionFile, toolCallId);
      if (result) {
        this.presenter.post({
          type: "toolOutput",
          sessionId: rt.id,
          toolCallId,
          text: truncateToolOutput(result.text),
          isError: result.isError,
          diff: result.diff, // pi's real line-numbered unified diff (edit) — upgrades the card
          firstChangedLine: result.firstChangedLine,
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
}
