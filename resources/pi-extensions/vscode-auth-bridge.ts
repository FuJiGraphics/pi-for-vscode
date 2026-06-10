type AuthType = "oauth" | "api_key";
type AnyRecord = Record<string, any>;

interface ProviderOption {
  id: string;
  name: string;
  authType: AuthType;
}

const WIDGET_KEY = "vscode-auth-bridge";
const FALLBACK_MESSAGE = "Pi auth APIs are not available in this runtime. Run `pi /login` in a terminal, then start a new VS Code Pi session.";

function asRecord(value: unknown): AnyRecord | undefined {
  return value && typeof value === "object" ? value as AnyRecord : undefined;
}

function safeArray(value: unknown): AnyRecord[] {
  return Array.isArray(value) ? value.map(asRecord).filter(Boolean) as AnyRecord[] : [];
}

function stringField(record: AnyRecord | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getAuthBridge(ctx: AnyRecord): { modelRegistry: AnyRecord; authStorage: AnyRecord } | undefined {
  const modelRegistry = asRecord(ctx?.modelRegistry);
  const authStorage = asRecord(modelRegistry?.authStorage);
  if (!modelRegistry || !authStorage) return undefined;
  if (typeof authStorage.set !== "function") return undefined;
  if (typeof authStorage.login !== "function") return undefined;
  if (typeof authStorage.logout !== "function") return undefined;
  return { modelRegistry, authStorage };
}

function providerName(modelRegistry: AnyRecord, providerId: string): string {
  if (typeof modelRegistry.getProviderDisplayName === "function") {
    const value = modelRegistry.getProviderDisplayName(providerId);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return providerId;
}

function getOAuthProviders(authStorage: AnyRecord): AnyRecord[] {
  return typeof authStorage.getOAuthProviders === "function" ? safeArray(authStorage.getOAuthProviders()) : [];
}

function getLoginProviderOptions(modelRegistry: AnyRecord, authStorage: AnyRecord, authType: AuthType): ProviderOption[] {
  const seen = new Set<string>();
  const options: ProviderOption[] = [];

  if (authType === "oauth") {
    for (const provider of getOAuthProviders(authStorage)) {
      const id = stringField(provider, "id");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      options.push({ id, name: stringField(provider, "name") ?? providerName(modelRegistry, id), authType: "oauth" });
    }
    return sortOptions(options);
  }

  const models = typeof modelRegistry.getAll === "function" ? safeArray(modelRegistry.getAll()) : [];
  for (const model of models) {
    const id = stringField(model, "provider");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    options.push({ id, name: providerName(modelRegistry, id), authType: "api_key" });
  }
  return sortOptions(options);
}

function getLogoutProviderOptions(modelRegistry: AnyRecord, authStorage: AnyRecord): ProviderOption[] {
  if (typeof authStorage.list !== "function" || typeof authStorage.get !== "function") return [];
  const options: ProviderOption[] = [];
  for (const providerId of authStorage.list()) {
    if (typeof providerId !== "string") continue;
    const credential = authStorage.get(providerId);
    if (!credential) continue;
    options.push({
      id: providerId,
      name: providerName(modelRegistry, providerId),
      authType: asRecord(credential)?.type === "oauth" ? "oauth" : "api_key",
    });
  }
  return sortOptions(options);
}

function sortOptions(options: ProviderOption[]): ProviderOption[] {
  return options.sort((a, b) => a.name.localeCompare(b.name));
}

async function selectOption(ui: AnyRecord, title: string, options: ProviderOption[]): Promise<ProviderOption | undefined> {
  const labels = options.map((option) => `${option.name} (${option.id})`);
  const selected = await ui.select(title, labels);
  if (typeof selected !== "string") return undefined;
  const index = labels.indexOf(selected);
  return index >= 0 ? options[index] : undefined;
}

async function selectAuthType(ui: AnyRecord): Promise<AuthType | undefined> {
  const subscriptionLabel = "Use a subscription";
  const apiKeyLabel = "Use an API key";
  const selected = await ui.select("Select authentication method:", [subscriptionLabel, apiKeyLabel]);
  if (selected === subscriptionLabel) return "oauth";
  if (selected === apiKeyLabel) return "api_key";
  return undefined;
}

function refreshModels(modelRegistry: AnyRecord): void {
  if (typeof modelRegistry.refresh === "function") modelRegistry.refresh();
}

async function loginWithApiKey(ctx: AnyRecord, bridge: { modelRegistry: AnyRecord; authStorage: AnyRecord }, option: ProviderOption): Promise<void> {
  if (option.id === "amazon-bedrock") {
    ctx.ui.notify("Amazon Bedrock uses AWS credentials. Run `pi /login` in a terminal for the full setup flow.", "warning");
    return;
  }
  const key = await ctx.ui.input(`${option.name} API key`, "Paste API key");
  if (typeof key !== "string" || !key.trim()) {
    ctx.ui.notify("Login cancelled.", "warning");
    return;
  }
  bridge.authStorage.set(option.id, { type: "api_key", key: key.trim() });
  refreshModels(bridge.modelRegistry);
  ctx.ui.notify(`Saved API key for ${option.name}.`, "info");
}

function firstUrl(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : "";
  const match = /https?:\/\/[^\s)]+/i.exec(text);
  return match?.[0];
}

function widgetLines(lines: unknown[]): string[] {
  return lines.map((line) => String(line ?? "")).filter((line) => line.length > 0);
}

async function loginWithOAuth(ctx: AnyRecord, bridge: { modelRegistry: AnyRecord; authStorage: AnyRecord }, option: ProviderOption): Promise<void> {
  try {
    await bridge.authStorage.login(option.id, {
      onAuth: (info: unknown) => {
        const record = asRecord(info);
        const url = stringField(record, "url");
        const instructions = stringField(record, "instructions");
        ctx.ui.setWidget(WIDGET_KEY, widgetLines(["Pi authentication", instructions, url ? `Open URL: ${url}` : undefined]));
        if (url) ctx.ui.notify(`Open this URL to continue login:\n${url}`, "info");
      },
      onDeviceCode: (info: unknown) => {
        const record = asRecord(info);
        const url = stringField(record, "verificationUri") ?? stringField(record, "verificationUrl") ?? firstUrl(stringField(record, "message"));
        const code = stringField(record, "userCode") ?? stringField(record, "code");
        ctx.ui.setWidget(WIDGET_KEY, widgetLines(["Pi authentication", url ? `Open URL: ${url}` : undefined, code ? `Code: ${code}` : undefined]));
        ctx.ui.notify(widgetLines(["Complete device authorization.", url, code ? `Code: ${code}` : undefined]).join("\n"), "info");
      },
      onProgress: (message: unknown) => {
        if (typeof message === "string" && message.trim()) ctx.ui.notify(message.trim(), "info");
      },
      onPrompt: async (prompt: unknown) => {
        const record = asRecord(prompt);
        const message = typeof prompt === "string" ? prompt : stringField(record, "message") ?? stringField(record, "title") ?? "Authentication input";
        const placeholder = stringField(record, "placeholder") ?? "";
        return await ctx.ui.input(message, placeholder);
      },
      onSelect: async (prompt: unknown) => {
        const record = asRecord(prompt);
        const options = Array.isArray(record?.options) ? record.options : [];
        const labels = options.map((entry: unknown) => {
          const option = asRecord(entry);
          return stringField(option, "label") ?? stringField(option, "name") ?? stringField(option, "value") ?? String(entry);
        });
        const title = stringField(record, "message") ?? stringField(record, "title") ?? "Select an option";
        const selected = await ctx.ui.select(title, labels);
        const index = labels.indexOf(selected);
        if (index < 0) return undefined;
        const option = asRecord(options[index]);
        return option?.value ?? option?.id ?? options[index];
      },
      onManualCodeInput: async () => {
        const value = await ctx.ui.input("Paste redirect URL", "http://127.0.0.1/...");
        if (typeof value !== "string" || !value.trim()) throw new Error("Login cancelled");
        return value.trim();
      },
    });
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    refreshModels(bridge.modelRegistry);
    ctx.ui.notify(`Logged in to ${option.name}.`, "info");
  } catch (error) {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    const message = error instanceof Error ? error.message : String(error);
    if (message !== "Login cancelled") ctx.ui.notify(`Failed to login to ${option.name}: ${message}`, "error");
  }
}

// "/login subscription" / "/login api-key" (from the VS Code onboarding cards) pre-answer
// the method select; a bare "/login" keeps the interactive select.
function parseLoginMethod(args: string): AuthType | undefined {
  const token = String(args || "").trim().split(/\s+/)[0]?.toLowerCase();
  if (token === "subscription" || token === "oauth") return "oauth";
  if (token === "api-key" || token === "apikey" || token === "key") return "api_key";
  return undefined;
}

async function login(args: string, ctx: AnyRecord): Promise<void> {
  const bridge = getAuthBridge(ctx);
  if (!bridge) {
    ctx.ui.notify(FALLBACK_MESSAGE, "warning");
    return;
  }

  const authType = parseLoginMethod(args) ?? await selectAuthType(ctx.ui);
  if (!authType) return;
  const options = getLoginProviderOptions(bridge.modelRegistry, bridge.authStorage, authType);
  if (options.length === 0) {
    ctx.ui.notify(authType === "oauth" ? "No subscription providers are available." : "No API key providers are available.", "warning");
    return;
  }

  const option = await selectOption(ctx.ui, authType === "oauth" ? "Select subscription provider:" : "Select API key provider:", options);
  if (!option) return;
  if (option.authType === "oauth") await loginWithOAuth(ctx, bridge, option);
  else await loginWithApiKey(ctx, bridge, option);
}

async function logout(args: string, ctx: AnyRecord): Promise<void> {
  const bridge = getAuthBridge(ctx);
  if (!bridge) {
    ctx.ui.notify(FALLBACK_MESSAGE, "warning");
    return;
  }

  const options = getLogoutProviderOptions(bridge.modelRegistry, bridge.authStorage);
  if (options.length === 0) {
    ctx.ui.notify("No stored Pi credentials to remove.", "info");
    return;
  }

  // "/logout <provider>" (from the VS Code settings rows) skips the provider select.
  const requested = String(args || "").trim().split(/\s+/)[0];
  const preselected = requested ? options.find((candidate) => candidate.id === requested) : undefined;
  const option = preselected ?? await selectOption(ctx.ui, "Select provider to sign out:", options);
  if (!option) return;
  bridge.authStorage.logout(option.id);
  refreshModels(bridge.modelRegistry);
  ctx.ui.notify(
    option.authType === "oauth"
      ? `Logged out of ${option.name}.`
      : `Removed stored API key for ${option.name}. Environment variables and models.json config are unchanged.`,
    "info",
  );
}

export default function vscodeAuthBridge(pi: AnyRecord): void {
  if (!pi || typeof pi.registerCommand !== "function") return;

  pi.registerCommand("login", {
    description: "Sign in to a Pi provider or save an API key",
    handler: login,
  });
  pi.registerCommand("logout", {
    description: "Remove credentials stored by Pi authentication",
    handler: logout,
  });
}
