// Computes the webview's auth verdict. Two READ-ONLY signals, both owned by pi:
//   1. The outcome of pi's own `get_available_models` — authoritative: pi returns only
//      models whose provider has usable auth, so a SUCCESSFUL-but-empty list means
//      "not authenticated" (an RPC failure / missing runtime means "unknown").
//   2. ~/.pi/agent/auth.json METADATA — provider ids + credential kind only; key material
//      is never read into memory beyond JSON.parse and never leaves this module. Direct
//      read-only access to pi's home dir follows the sessionStore.ts precedent
//      (~/.pi/agent/sessions/*.jsonl). pi stays the authority; we never write.
// An fs.watch on auth.json turns every login/logout — including ones done in a terminal
// pi — into an automatic re-check, which is what dismisses the onboarding gate.
// "unknown" FAILS OPEN: the webview never blocks the chat on it.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthProviderStatus } from "./protocol";
import type { WebviewPresenter } from "./webviewPresenter";

export type ModelsOutcome = "models" | "empty" | "unknown";
export type AuthStatus = "authenticated" | "unauthenticated" | "unknown";

/** Pure verdict: positive signals win; only a CONFIRMED empty (models fetch succeeded
 *  with zero results AND no stored credentials) yields "unauthenticated". */
export function deriveAuthStatus(outcome: ModelsOutcome, stored: AuthProviderStatus[]): AuthStatus {
  if (outcome === "models" || stored.length > 0) return "authenticated";
  if (outcome === "empty") return "unauthenticated";
  return "unknown";
}

/** Tolerant metadata extraction from auth.json — never throws, never surfaces key
 *  material (only the provider id and the credential `type` discriminator). */
export function providersFromAuthJson(raw: string): AuthProviderStatus[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const providers: AuthProviderStatus[] = [];
    for (const [id, credential] of Object.entries(parsed as Record<string, unknown>)) {
      if (!id || !credential || typeof credential !== "object") continue;
      providers.push({ id, authType: (credential as { type?: unknown }).type === "oauth" ? "oauth" : "api_key" });
    }
    return providers.sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return [];
  }
}

export interface AuthStatusDeps {
  /** Re-fetch the model list (quiet) so the authoritative outcome confirms a file change. */
  refreshModels(): Promise<void>;
}

export class AuthStatusService {
  private outcome: ModelsOutcome = "unknown";
  private lastKnown: AuthStatus = "unknown"; // a transient failure keeps the last verdict
  private watcher?: fs.FSWatcher;
  private debounce?: ReturnType<typeof setTimeout>;
  private readonly authFile = path.join(os.homedir(), ".pi", "agent", "auth.json");

  constructor(
    private readonly presenter: WebviewPresenter,
    private readonly deps: AuthStatusDeps,
  ) {}

  /** Watch pi's agent dir for auth.json changes (login/logout from ANY pi, ours or a
   *  terminal's). Missing dir → no watcher; the other triggers still cover us. */
  start(): void {
    try {
      this.watcher = fs.watch(path.dirname(this.authFile), (_event, filename) => {
        if (filename && filename !== "auth.json") return;
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => {
          this.debounce = undefined;
          void this.postAuthState();
          // Confirm through pi: the refreshed model list flows back via noteModels.
          void this.deps.refreshModels();
        }, 300);
      });
    } catch {
      this.watcher = undefined;
    }
  }

  /** Fed by ModelService with every fetch outcome (items on success, undefined on
   *  failure / missing runtime). */
  noteModels(models: readonly unknown[] | undefined): void {
    this.outcome = models === undefined ? "unknown" : models.length > 0 ? "models" : "empty";
    void this.postAuthState();
  }

  async postAuthState(): Promise<void> {
    const providers = await this.readStoredProviders();
    let status = deriveAuthStatus(this.outcome, providers);
    if (status === "unknown" && this.lastKnown !== "unknown") status = this.lastKnown;
    else this.lastKnown = status;
    this.presenter.post({ type: "authState", status, providers });
  }

  private async readStoredProviders(): Promise<AuthProviderStatus[]> {
    try {
      return providersFromAuthJson(await fsp.readFile(this.authFile, "utf8"));
    } catch {
      return []; // no file = no stored credentials (env-var auth still shows via models)
    }
  }

  dispose(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.watcher?.close();
    this.watcher = undefined;
  }
}
