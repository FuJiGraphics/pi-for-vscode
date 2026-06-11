import type { PiRpcClient } from "./piRpcClient";
import type { ModelCost, ModelListItem } from "./protocol";
import { asRecord, stringField } from "./sessionFormat";
import type { SessionRuntime } from "./sessionRuntime";
import type { WebviewPresenter } from "./webviewPresenter";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Pi's per-model pricing (USD/Mtok), passed through verbatim. Older pi without a cost
 *  object (or a malformed one) → undefined, and the picker simply omits the price chip. */
function costFromModel(model: Record<string, unknown>): ModelCost | undefined {
  const cost = asRecord(model.cost);
  const input = numberField(cost, "input");
  const output = numberField(cost, "output");
  if (input === undefined || output === undefined) return undefined;
  return { input, output, cacheRead: numberField(cost, "cacheRead"), cacheWrite: numberField(cost, "cacheWrite") };
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
    // Enrichment fields are set only when pi reports them — an older pi simply omits
    // them and the picker renders without the price/context chips.
    const cost = costFromModel(model);
    if (cost) item.cost = cost;
    const contextWindow = numberField(model, "contextWindow");
    if (contextWindow) item.contextWindow = contextWindow;
    const maxTokens = numberField(model, "maxTokens");
    if (maxTokens) item.maxTokens = maxTokens;
    if (Array.isArray(model.input) && (model.input as unknown[]).includes("image")) item.vision = true;
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
  /** Every fetch outcome, for the auth-status verdict: items on success (possibly empty —
   *  that's the authoritative "no provider has auth"), undefined on failure / no runtime. */
  onModelsFetched?(models: ModelListItem[] | undefined): void;
}

// Model picker + switching through Pi's official RPC. Pi owns auth, providers,
// and model persistence; the VS Code side only renders and forwards choices.
export class ModelService {
  constructor(
    private readonly presenter: WebviewPresenter,
    private readonly deps: ModelServiceDeps,
  ) {}

  /** `quiet` suppresses the system-message error spam for background auth checks. */
  async postModelList(quiet = false): Promise<void> {
    await this.fetchModels(quiet);
  }

  /** Fetch the available models + current state, post the list, feed the auth verdict, AND
   *  return the items so callers (AuthRevocationService) can validate the current selection.
   *  Returns [] on any failure / no runtime (also the authoritative "no auth" signal). */
  async fetchModels(quiet = true): Promise<ModelListItem[]> {
    const rt = await this.deps.ensureActiveRuntime().catch((error) => {
      if (!quiet) this.deps.reportRuntimeError(error);
      return undefined;
    });
    const client = rt?.client;
    if (!client) {
      this.deps.onModelsFetched?.(undefined);
      this.presenter.post({ type: "modelList", models: [] });
      return [];
    }

    try {
      const [modelsResponse, state] = await Promise.all([
        client.request({ type: "get_available_models" }, 15_000),
        this.deps.requestState(client),
      ]);
      if (modelsResponse.success === false) {
        if (!quiet) this.presenter.postSystem(`Failed to load models: ${String(modelsResponse.error ?? "unknown error")}`);
        this.deps.onModelsFetched?.(undefined);
        this.presenter.post({ type: "modelList", models: [] });
        return [];
      }

      const data = asRecord(modelsResponse.data);
      const models = Array.isArray(data?.models) ? data.models : modelsResponse.data;
      const items = modelListItemsFromRpc(models, asRecord(state)?.model);
      this.deps.onModelsFetched?.(items);
      this.presenter.post({ type: "modelList", models: items });
      return items;
    } catch (error) {
      if (!quiet) this.presenter.postSystem(`Failed to load models: ${error instanceof Error ? error.message : String(error)}`);
      this.deps.onModelsFetched?.(undefined);
      this.presenter.post({ type: "modelList", models: [] });
      return [];
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
