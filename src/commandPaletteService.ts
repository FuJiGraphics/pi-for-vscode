import type { CommandListItem } from "./protocol";
import type { SessionRuntime } from "./sessionRuntime";
import type { WebviewPresenter } from "./webviewPresenter";
import { asRecord } from "./sessionFormat";
import { buildSourceTag } from "./stateHelpers";

/** Manager surface the palette borrows to reach the active runtime's client. */
export interface CommandPaletteDeps {
  ensureActiveRuntime(): Promise<SessionRuntime | undefined>;
}

// Builds the slash-command palette by asking the active pi for its commands (get_commands)
// and tagging each with a provenance badge.
export class CommandPaletteService {
  constructor(private readonly presenter: WebviewPresenter, private readonly deps: CommandPaletteDeps) {}

  async postCommandList(): Promise<void> {
    const rt = await this.deps.ensureActiveRuntime();
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
      const source = record.source === "skill" || record.source === "prompt" ? record.source : "extension";
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
    this.presenter.post({ type: "commandList", commands });
  }
}
