import * as vscode from "vscode";
import { resolvePiRuntime } from "./piResolver";
import { listPiModels, PROVIDER_ENV_VARS, type PiModel } from "./modelStore";
import type { ModelListItem } from "./protocol";
import type { PiRpcClient } from "./piRpcClient";
import type { SessionRuntime } from "./sessionRuntime";
import type { WebviewPresenter } from "./webviewPresenter";
import type { ModelSecretsStore } from "./modelSecretsStore";
import { asRecord } from "./sessionFormat";
import { readSessionFile } from "./stateHelpers";
import { getWorkspaceCwd } from "./workspace";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

/** Case-insensitive match of a model against the "current" reference (id / model / id-suffix). */
export function isCurrentModel(model: PiModel, ref: string | undefined): boolean {
  if (!ref) return false;
  const r = ref.toLowerCase();
  return model.id.toLowerCase() === r || model.model.toLowerCase() === r || model.id.toLowerCase().endsWith("/" + r);
}

/** Manager surface the model service borrows to reach the active runtime + reseed after a restart. */
export interface ModelServiceDeps {
  ensureActiveRuntime(): Promise<SessionRuntime | undefined>;
  activeRuntime(): SessionRuntime | undefined;
  requestState(client: PiRpcClient): Promise<Record<string, unknown> | undefined>;
  setRunning(rt: SessionRuntime, value: boolean): void;
  seedRuntime(rt: SessionRuntime, force?: boolean): Promise<void>;
  postState(): Promise<unknown>;
  isCurrentWorkspaceSession(sessionPath: string): Promise<boolean>;
  reportRuntimeError(error: unknown): void;
}

// Model selection, thinking level, BYOK key entry, and the model picker list. Persistence
// lives in ModelSecretsStore (leaf); runtime reach-through goes via ModelServiceDeps.
export class ModelService {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly presenter: WebviewPresenter,
    private readonly secrets: ModelSecretsStore,
    private readonly deps: ModelServiceDeps,
  ) {}

  async postModelList(): Promise<void> {
    let runtime;
    try {
      runtime = await resolvePiRuntime(this.context);
    } catch (error) {
      this.deps.reportRuntimeError(error);
      this.presenter.post({ type: "modelList", models: [] });
      return;
    }
    const cwd = getWorkspaceCwd();
    const secrets = await this.secrets.getSecretsEnv();
    const models = await listPiModels(runtime, { cwd, secrets });
    const currentRef = await this.currentModelRef();
    const items: ModelListItem[] = models.map((model) => ({
      id: model.id,
      model: model.model,
      provider: model.provider,
      thinking: model.thinking,
      isCurrent: isCurrentModel(model, currentRef),
    }));
    this.presenter.post({ type: "modelList", models: items });
  }

  async setModel(modelId: string): Promise<void> {
    if (!modelId) return;
    const rt = await this.deps.ensureActiveRuntime();
    if (!rt?.client) return;

    // Capture the active session so we can restore it after this runtime's pi restarts.
    const sessionFile = readSessionFile(await this.deps.requestState(rt.client));

    const secrets = await this.secrets.getSecretsEnv();
    const response = await rt.client.request({ type: "set_model", model: modelId, secrets }, 30_000);
    if (response.success === false) {
      this.presenter.postSystem(`Failed to switch model: ${String(response.error ?? "unknown error")}`);
      return;
    }
    // Per-runtime model — set_model only restarts THIS runtime's broker's pi, so other
    // sessions are unaffected. The global key is just the default seed for new runtimes.
    rt.model = modelId;
    await this.secrets.setSelectedModel(modelId);

    this.deps.setRunning(rt, false);
    if (sessionFile && await this.deps.isCurrentWorkspaceSession(sessionFile)) {
      await rt.client.request({ type: "switch_session", sessionPath: sessionFile }, 30_000).catch(() => undefined);
    }
    // The pi restarted on the new model — re-seed this session's view (model + messages).
    await this.deps.seedRuntime(rt, true);
  }

  async setThinkingLevel(level: string): Promise<void> {
    const trimmed = level.trim().toLowerCase();
    if (!THINKING_LEVELS.has(trimmed)) return;

    const rt = await this.deps.ensureActiveRuntime();
    if (!rt?.client) return;

    const response = await rt.client.request({ type: "set_thinking_level", level: trimmed }, 10_000);
    if (response.success === false) {
      this.presenter.postSystem(`Failed to change thinking level: ${String(response.error ?? "unknown error")}`);
      return;
    }
    await this.deps.postState();
  }

  async addProviderKey(): Promise<void> {
    const providers = Object.keys(PROVIDER_ENV_VARS).sort();
    const provider = await vscode.window.showQuickPick(providers, {
      title: "Add Provider API Key",
      placeHolder: "Select the provider whose API key you want to add (BYOK)",
    });
    if (!provider) return;
    const envVar = PROVIDER_ENV_VARS[provider];
    const key = await vscode.window.showInputBox({
      title: `${provider} API key`,
      prompt: `Stored securely in VS Code; passed to pi as ${envVar}.`,
      password: true,
      ignoreFocusOut: true,
    });
    if (!key || !key.trim()) return;

    await this.secrets.storeProviderKey(envVar, key.trim());
    this.presenter.postSystem(`Saved ${provider} API key. Pick one of its models to start using it.`);
    await this.postModelList();
  }

  private async currentModelRef(): Promise<string | undefined> {
    // Prefer the active session's own model so the picker's current marker reflects
    // what the visible session is using, not just the global default.
    const activeModel = this.deps.activeRuntime()?.model;
    if (activeModel) return activeModel;
    const stored = this.secrets.storedModel();
    if (stored) return stored;
    const client = this.deps.activeRuntime()?.client;
    if (!client?.isStarted) return undefined;
    const state = await this.deps.requestState(client);
    const model = asRecord(state?.model);
    if (typeof model?.id === "string") return model.id;
    if (typeof model?.name === "string") return model.name;
    return undefined;
  }
}
