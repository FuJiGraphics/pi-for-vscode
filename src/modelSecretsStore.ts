import * as vscode from "vscode";

// globalState / SecretStorage keys for model selection + BYOK. Owned here so the keys live
// in exactly one place; both the runtime manager (default model + secrets at spawn) and the
// model service (set model, store keys) talk to this leaf rather than the raw context.
const SELECTED_MODEL_KEY = "pi-for-vscode.selectedModel";
const PROVIDER_KEY_ENV_VARS_KEY = "pi-for-vscode.providerKeyEnvVars";
const SECRET_PREFIX = "pi-for-vscode.apiKey.";

/** Persists the selected-model default and BYOK provider keys. No runtime/manager dependency. */
export class ModelSecretsStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Default model for a freshly created runtime (empty string → undefined). */
  selectedModelDefault(): string | undefined {
    return this.context.globalState.get<string>(SELECTED_MODEL_KEY) || undefined;
  }

  /** Raw stored model preference (no empty-string coalescing). */
  storedModel(): string | undefined {
    return this.context.globalState.get<string>(SELECTED_MODEL_KEY);
  }

  setSelectedModel(modelId: string): Thenable<void> {
    return this.context.globalState.update(SELECTED_MODEL_KEY, modelId);
  }

  /** Stored provider keys as { ENV_VAR: value }, ready to inject into pi's environment. */
  async getSecretsEnv(): Promise<Record<string, string>> {
    const names = this.context.globalState.get<string[]>(PROVIDER_KEY_ENV_VARS_KEY, []);
    const out: Record<string, string> = {};
    for (const name of names) {
      const value = await this.context.secrets.get(SECRET_PREFIX + name);
      if (value) out[name] = value;
    }
    return out;
  }

  /** Store a provider's API key securely and track its env-var name for later retrieval. */
  async storeProviderKey(envVar: string, key: string): Promise<void> {
    await this.context.secrets.store(SECRET_PREFIX + envVar, key);
    const names = this.context.globalState.get<string[]>(PROVIDER_KEY_ENV_VARS_KEY, []);
    if (!names.includes(envVar)) {
      await this.context.globalState.update(PROVIDER_KEY_ENV_VARS_KEY, [...names, envVar]);
    }
  }
}
