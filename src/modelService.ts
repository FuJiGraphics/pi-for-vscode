import type { PiRpcClient } from "./piRpcClient";
import type { ModelListItem } from "./protocol";
import { asRecord } from "./sessionFormat";
import type { SessionRuntime } from "./sessionRuntime";
import type { WebviewPresenter } from "./webviewPresenter";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function supportsThinking(model: Record<string, unknown>): boolean {
  if (model.reasoning === true) return true;
  const map = asRecord(model.thinkingLevelMap);
  return Boolean(map && Object.values(map).some((value) => value !== null && value !== false));
}

/** Case-insensitive match against Pi's current full Model object. */
export function isCurrentModelItem(item: Pick<ModelListItem, "provider" | "modelId" | "id">, currentModel: unknown): boolean {
  const current = asRecord(currentModel);
  const currentProvider = stringField(current, "provider")?.toLowerCase();
  const currentId = stringField(current, "id")?.toLowerCase();
  if (!currentId) return false;

  const provider = item.provider.toLowerCase();
  const modelId = item.modelId.toLowerCase();
  const qualified = item.id.toLowerCase();
  if (currentProvider) return currentProvider === provider && (currentId === modelId || currentId === qualified);
  return currentId === modelId || currentId === qualified;
}

/** Pure mapper from Pi's `get_available_models` full model objects to picker rows. */
export function modelListItemsFromRpc(models: unknown, currentModel?: unknown): ModelListItem[] {
  if (!Array.isArray(models)) return [];

  const items: ModelListItem[] = [];
  for (const value of models) {
    const model = asRecord(value);
    if (!model) continue;
    const provider = stringField(model, "provider");
    const modelId = stringField(model, "id");
    if (!provider || !modelId) continue;

    const id = `${provider}/${modelId}`;
    const label = stringField(model, "name") ?? stringField(model, "displayName") ?? modelId;
    const item: ModelListItem = {
      id,
      modelId,
      model: label,
      provider,
      thinking: supportsThinking(model),
      isCurrent: false,
    };
    item.isCurrent = isCurrentModelItem(item, currentModel);
    items.push(item);
  }
  return items;
}

/** Manager surface the model service borrows to reach the active runtime. */
export interface ModelServiceDeps {
  ensureActiveRuntime(): Promise<SessionRuntime | undefined>;
  requestState(client: PiRpcClient): Promise<Record<string, unknown> | undefined>;
  postState(): Promise<unknown>;
  reportRuntimeError(error: unknown): void;
}

// Model picker + switching through Pi's official RPC. Pi owns auth, providers,
// and model persistence; the VS Code side only renders and forwards choices.
export class ModelService {
  constructor(
    private readonly presenter: WebviewPresenter,
    private readonly deps: ModelServiceDeps,
  ) {}

  async postModelList(): Promise<void> {
    const rt = await this.deps.ensureActiveRuntime().catch((error) => {
      this.deps.reportRuntimeError(error);
      return undefined;
    });
    const client = rt?.client;
    if (!client) {
      this.presenter.post({ type: "modelList", models: [] });
      return;
    }

    try {
      const [modelsResponse, state] = await Promise.all([
        client.request({ type: "get_available_models" }, 15_000),
        this.deps.requestState(client),
      ]);
      if (modelsResponse.success === false) {
        this.presenter.postSystem(`Failed to load models: ${String(modelsResponse.error ?? "unknown error")}`);
        this.presenter.post({ type: "modelList", models: [] });
        return;
      }

      const data = asRecord(modelsResponse.data);
      const models = Array.isArray(data?.models) ? data.models : modelsResponse.data;
      this.presenter.post({ type: "modelList", models: modelListItemsFromRpc(models, asRecord(state)?.model) });
    } catch (error) {
      this.presenter.postSystem(`Failed to load models: ${error instanceof Error ? error.message : String(error)}`);
      this.presenter.post({ type: "modelList", models: [] });
    }
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    const providerId = provider.trim();
    const id = modelId.trim();
    if (!providerId || !id) return;

    const rt = await this.deps.ensureActiveRuntime();
    if (!rt?.client) return;

    const response = await rt.client.request({ type: "set_model", provider: providerId, modelId: id }, 30_000);
    if (response.success === false) {
      this.presenter.postSystem(`Failed to switch model: ${String(response.error ?? "unknown error")}`);
      return;
    }

    await this.deps.postState();
    await this.postModelList();
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
}
