import type { ImageAttachment } from "./protocol";
import type { PiRpcClient } from "./piRpcClient";
import { asRecord } from "./sessionFormat";
import type { SessionRuntimeManager } from "./sessionRuntimeManager";
import type { WebviewPresenter } from "./webviewPresenter";

/** Host capabilities this unit borrows: the prompt path (chatViewProvider.prompt) to
 *  resend edited text, and the external opener for the exported HTML (vscode.env). */
export interface ConversationActionsDeps {
  prompt(text: string, images?: ImageAttachment[]): Promise<void>;
  openExported(path: string): void;
}

// Conversation-level actions on the ACTIVE session beyond prompt/abort: edit-rewind
// (pi `fork`), manual compaction (`compact`), and HTML export (`export_html`). Thin
// passthroughs — pi owns every semantic; this unit only routes, verifies, and reports.
export class ConversationActionsService {
  constructor(
    private readonly manager: SessionRuntimeManager,
    private readonly presenter: WebviewPresenter,
    private readonly deps: ConversationActionsDeps,
  ) {}

  // Rewind the active session to just BEFORE its `userOrdinal`-th user message via pi's
  // fork RPC (a BRANCHED session file — the original survives on disk, reopenable from
  // History), then resend the edited text. The webview already truncated its view and
  // showed the new bubble optimistically; any failure force re-seeds so the true state
  // comes straight back.
  async editMessage(userOrdinal: number, originalText: string, text: string, images?: ImageAttachment[]): Promise<void> {
    const rt = this.manager.active;
    if (!rt?.client?.isStarted) {
      this.presenter.postSystem("No active session to edit.");
      // The webview optimistically truncated its view and lit a spinner — restore the
      // real conversation (re-seed puts the edited-away messages back) and drop the
      // spinner. A dead client can't re-seed; the running:false at least clears the spinner.
      if (rt?.client?.isStarted) await this.manager.seedRuntime(rt, true);
      if (rt) this.presenter.post({ type: "running", sessionId: rt.id, value: false });
      return;
    }
    const entryId = await this.resolveForkEntry(rt.client, userOrdinal, originalText);
    if (!entryId) {
      this.presenter.postSystem("Could not locate the edited message in the session history.");
      await this.manager.seedRuntime(rt, true);
      return;
    }
    const response = await rt.client.request({ type: "fork", entryId }, 30_000).catch(() => undefined);
    if (!response || response.success === false || asRecord(response.data)?.cancelled === true) {
      this.presenter.postSystem(`Failed to rewind the conversation: ${String(response?.error ?? "unknown error")}`);
      await this.manager.seedRuntime(rt, true);
      return;
    }
    // pi rebound onto a BRANCHED session file. Push the new sessionFile to the webview
    // view NOW (before the resend's turn starts), so its debounced crash-save persists the
    // forked conversation under the correct file — not under the original session, which a
    // reload would then wrongly resume with the branched timeline. Only sessionFile is sent
    // (no isStreaming), so the optimistic spinner/messages are left untouched.
    await this.manager.getClientState(rt);
    this.presenter.post({ type: "state", sessionId: rt.id, state: { sessionFile: rt.sessionFile } });
    void this.manager.postSessionList();
    await this.deps.prompt(text, images);
  }

  // Map the webview's user-message ordinal onto a pi fork entry id. Ordinal is primary
  // (both sides count user messages with text, in order); the text check catches drift,
  // falling back to a unique exact-text match before giving up.
  private async resolveForkEntry(client: PiRpcClient, userOrdinal: number, originalText: string): Promise<string | undefined> {
    const list = await client.request({ type: "get_fork_messages" }, 10_000).catch(() => undefined);
    const raw = asRecord(list?.data)?.messages;
    const entries = (Array.isArray(raw) ? raw : [])
      .map((entry) => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => !!entry);
    const norm = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim();
    const wanted = norm(originalText);
    let entry = userOrdinal >= 0 ? entries[userOrdinal] : undefined;
    if (wanted && (!entry || norm(entry.text) !== wanted)) {
      const matches = entries.filter((candidate) => norm(candidate.text) === wanted);
      if (matches.length === 1) entry = matches[0];
    }
    return typeof entry?.entryId === "string" && entry.entryId ? entry.entryId : undefined;
  }

  async compact(): Promise<void> {
    const rt = this.manager.active;
    if (!rt?.client?.isStarted) {
      this.presenter.postSystem("No active session to compact.");
      return;
    }
    // Long timeout: compaction runs a model call. Progress shows via pi's compaction events.
    const response = await rt.client.request({ type: "compact" }, 180_000).catch(() => undefined);
    if (!response || response.success === false) {
      this.presenter.postSystem(`Compaction failed: ${String(response?.error ?? "unknown error")}`);
      return;
    }
    void this.manager.postState();
  }

  async exportHtml(): Promise<void> {
    const rt = this.manager.active;
    if (!rt?.client?.isStarted) {
      this.presenter.postSystem("No active session to export.");
      return;
    }
    const response = await rt.client.request({ type: "export_html" }, 30_000).catch(() => undefined);
    const path = asRecord(response?.data)?.path;
    if (!response || response.success === false || typeof path !== "string" || !path) {
      this.presenter.postSystem(`Export failed: ${String(response?.error ?? "unknown error")}`);
      return;
    }
    this.presenter.postSystem(`Exported the session to ${path}`);
    this.deps.openExported(path);
  }
}
