import type { CommandListItem } from "./protocol";
import type { SessionRuntime } from "./sessionRuntime";
import type { WebviewPresenter } from "./webviewPresenter";
import { asRecord } from "./sessionFormat";
import { buildSourceTag } from "./stateHelpers";

/** Manager surface the palette borrows to reach the active runtime's client. */
export interface CommandPaletteDeps {
  ensureRuntime(): Promise<SessionRuntime | undefined>;
}

// Builds the slash-command palette by asking the active pi for its commands (get_commands)
// and tagging each with a provenance badge.
export class CommandPaletteService {
  constructor(private readonly presenter: WebviewPresenter, private readonly deps: CommandPaletteDeps) {}

  async postCommandList(): Promise<void> {
    const rt = await this.deps.ensureRuntime();
    if (!rt?.client) {
      this.presenter.post({ type: "commandList", commands: [] });
      return;
    }
    const response = await rt.client.request({ type: "get_commands" }, 10_000).catch(() => undefined);
    if (!response || response.success === false) {
      this.presenter.post({ type: "commandList", commands: [] });
      return;
    }
    const data = asRecord(response.data);
    const raw = Array.isArray(data?.commands) ? data.commands : [];
    const commands: CommandListItem[] = [];
    for (const entry of raw) {
      const record = asRecord(entry);
      if (!record || typeof record.name !== "string") continue;
      // Agent-facing entries stay OUT of the user palette: pi skills are loaded for the
      // MODEL (surfacing them as slash entries read as broken UI features), and
      // refresh-auth is the auth bridge's VS-Code-internal registry reload hook. Typing
      // "/skill:name" manually still works — pi parses the prompt itself.
      if (record.source === "skill" || record.name === "refresh-auth") continue;
      const source = record.source === "prompt" ? record.source : "extension";
      const sourceInfo = asRecord(record.sourceInfo);
      const scope = sourceInfo?.scope === "user" || sourceInfo?.scope === "project" || sourceInfo?.scope === "temporary"
        ? sourceInfo.scope
        : undefined;
      commands.push({
        name: record.name,
        description: typeof record.description === "string" ? record.description : "",
        source,
        scope,
        sourceTag: buildSourceTag(sourceInfo),
      });
    }
    // The auth bridge (vscode-auth-bridge.ts) registers /login — its absence from a
    // SUCCESSFUL command list means the bridge failed to load in this pi runtime, so the
    // model picker degrades its sign-in buttons instead of offering a dead end.
    const authAvailable = commands.some((command) => command.name === "login");
    this.presenter.post({ type: "commandList", commands, authAvailable });
  }
}
