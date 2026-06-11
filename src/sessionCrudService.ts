import * as path from "node:path";
import * as vscode from "vscode";
import { deleteSession, renameSession } from "./sessionStore";
import { asRecord, toSessionQuickPickItem, type SessionQuickPickItem } from "./sessionFormat";
import { getWorkspaceCwd, samePath } from "./workspace";
import type { SessionRuntimeManager } from "./sessionRuntimeManager";
import type { WebviewPresenter } from "./webviewPresenter";

// Session list / new / switch / delete / rename and the quick-pick. Orchestrates the runtime
// manager (spawn/activate/reap) and falls back to direct file ops when no live pi owns the
// session. Owns no runtime state itself.
export class SessionCrudService {
  private readonly switchingByPath = new Map<string, Promise<void>>();

  constructor(
    private readonly manager: SessionRuntimeManager,
    private readonly presenter: WebviewPresenter,
    private readonly open: () => Promise<void>,
  ) {}

  // New Session is a genuinely new execution unit: spawn a fresh runtime so any
  // previously-active (and possibly still-running) session keeps its own pi alive.
  async newSession(): Promise<void> {
    const cwd = getWorkspaceCwd();
    if (!cwd) {
      this.presenter.postSystem("Open a workspace folder to start a project-scoped Pi session.");
      return;
    }
    const previous = this.manager.active;
    const rt = await this.manager.createRuntime(cwd);
    if (!rt?.client) return;

    const response = await rt.client.request({ type: "new_session" });
    if (response.success === false) {
      this.presenter.postSystem(`Failed to start a new session: ${String(response.error ?? "unknown error")}`);
      await this.manager.reapRuntime(rt);
      return;
    }
    const data = asRecord(response.data);
    if (data?.cancelled === true) {
      await this.manager.reapRuntime(rt);
      return;
    }

    this.manager.setActiveRuntimeId(rt.id);
    if (previous && previous !== rt) this.manager.handleSwitchAway(previous);
    this.manager.setRunning(rt, false);
    await this.manager.seedRuntime(rt);
    this.presenter.post({ type: "activate", sessionId: rt.id });
    await this.manager.postSessionList();
  }

  async sessions(): Promise<void> {
    await this.open();
    const cwd = getWorkspaceCwd();
    if (!cwd) {
      this.presenter.postSystem("Open a workspace folder to view project-scoped Pi sessions.");
      return;
    }
    const summaries = await this.manager.collectSessions();

    const items: SessionQuickPickItem[] = [
      {
        label: "$(add) New Session",
        description: "Start a fresh Pi session",
        action: "new",
      },
      ...summaries.map((summary) => toSessionQuickPickItem(summary, cwd)),
    ];

    const picked = await vscode.window.showQuickPick(items, {
      title: "Pi Sessions",
      placeHolder: summaries.length > 0 ? "Select a session to resume" : "No saved sessions found for this workspace yet",
      matchOnDescription: true,
      matchOnDetail: true,
    });

    if (!picked) return;
    if (picked.action === "new") {
      await this.newSession();
      return;
    }
    if (picked.sessionPath) await this.switchSession(picked.sessionPath);
  }

  // Switching is "change what's visible", never "stop/reuse the executor":
  //   1. a live (or warm-stub) runtime already owns the session → activate it.
  //   2. otherwise spawn a fresh runtime and load the file into it.
  // It never blocks on the current session being busy — that session keeps running.
  async switchSession(sessionPath: string): Promise<void> {
    const key = this.sessionPathKey(sessionPath);
    const inFlight = this.switchingByPath.get(key);
    if (inFlight) {
      await inFlight;
      return;
    }
    const work = this.switchSessionOnce(sessionPath).finally(() => this.switchingByPath.delete(key));
    this.switchingByPath.set(key, work);
    await work;
  }

  private async switchSessionOnce(sessionPath: string): Promise<void> {
    if (!await this.manager.isCurrentWorkspaceSession(sessionPath)) {
      this.presenter.postSystem("That session belongs to a different workspace and cannot be opened from this project.");
      await this.manager.postSessionList();
      return;
    }

    // A live (or warm-stub) runtime already owns this session → activate it. This is an
    // instant swap to its cached webview view; the current session keeps running.
    const existing = this.manager.findRuntimeBySessionFile(sessionPath);
    if (existing) {
      await this.manager.activateRuntime(existing.id);
      return;
    }

    const cwd = getWorkspaceCwd();
    if (!cwd) {
      this.presenter.postSystem("Open a workspace folder to start a project-scoped Pi session.");
      return;
    }
    const rt = await this.manager.createRuntime(cwd);
    if (!rt?.client) return;

    const response = await rt.client.request({ type: "switch_session", sessionPath }, 30_000);
    if (response.success === false) {
      this.presenter.postSystem(`Failed to switch session: ${String(response.error ?? "unknown error")}`);
      await this.manager.reapRuntime(rt);
      return;
    }
    const data = asRecord(response.data);
    if (data?.cancelled === true) {
      await this.manager.reapRuntime(rt);
      return;
    }

    rt.sessionFile = sessionPath;
    await this.manager.activateRuntime(rt.id);
  }

  async deleteSession(sessionPath: string): Promise<void> {
    if (!await this.manager.isCurrentWorkspaceSession(sessionPath)) {
      this.presenter.postSystem("That session belongs to a different workspace and cannot be deleted from this project.");
      await this.manager.postSessionList();
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      "Delete this Pi session? This permanently removes its saved history and cannot be undone.",
      { modal: true },
      "Delete",
    );
    if (confirm !== "Delete") return;
    // Tear down any live runtime holding this session before unlinking its file.
    const rt = this.manager.findRuntimeBySessionFile(sessionPath);
    if (rt) await this.manager.reapRuntime(rt);
    try {
      await deleteSession(sessionPath);
    } catch (error) {
      this.presenter.postSystem(`Failed to delete session: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.manager.postSessionList();
  }

  async renameSession(sessionPath: string, name: string): Promise<void> {
    if (!await this.manager.isCurrentWorkspaceSession(sessionPath)) {
      this.presenter.postSystem("That session belongs to a different workspace and cannot be renamed from this project.");
      await this.manager.postSessionList();
      return;
    }

    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      // When the active runtime's pi has this session loaded, route the rename through
      // its RPC so pi's in-memory session name (what get_state returns) updates too.
      // Writing the file directly behind a running broker leaves pi unaware, so the
      // next get_state/switch_session reports the stale name and the rename "reverts".
      const renamedViaPi = await this.renameActiveSessionViaPi(sessionPath, trimmed);
      if (!renamedViaPi) await renameSession(sessionPath, trimmed);
      if (samePath(sessionPath, this.manager.active?.sessionFile)) await this.manager.postState();
    } catch (error) {
      this.presenter.postSystem(`Failed to rename session: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.manager.postSessionList();
  }

  private sessionPathKey(sessionPath: string): string {
    const resolved = path.resolve(sessionPath);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }

  // Rename via pi's set_session_name RPC when the active runtime is the live owner of
  // this session. Returns false otherwise (caller falls back to a direct file write).
  // Throws if pi rejects the rename.
  private async renameActiveSessionViaPi(sessionPath: string, name: string): Promise<boolean> {
    const rt = this.manager.active;
    const client = rt?.client?.isStarted ? rt.client : undefined;
    if (!rt || !client) return false;
    // Refresh the runtime's loaded-session pointer so we never RPC the wrong session.
    await this.manager.getClientState(rt);
    if (!samePath(sessionPath, rt.sessionFile)) return false;
    const response = await client.request({ type: "set_session_name", name }, 10_000);
    if (response.success === false) {
      throw new Error(String(response.error ?? "pi rejected the rename"));
    }
    return true;
  }
}
