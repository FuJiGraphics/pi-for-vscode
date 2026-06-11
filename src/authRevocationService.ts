import type { ModelListItem } from "./protocol";
import type { PiRpcClient } from "./piRpcClient";
import type { SessionRuntime } from "./sessionRuntime";
import type { WebviewPresenter } from "./webviewPresenter";
import { asRecord, stringField } from "./sessionFormat";

// Reacts to an EXTERNAL auth.json change (a login/logout in another pi — e.g. another VS Code
// window or machine sharing ~/.pi/agent) by forcing the affected pi to reload its model
// registry and correcting a now-invalid model selection.
//
// Why this is needed: pi caches its model registry in-memory and only recomputes it on
// modelRegistry.refresh() (which the auth bridge calls after its own login/logout). A
// long-running pi therefore keeps serving a revoked model from get_available_models, so the
// VS Code side stays "authenticated" pointing at a dead model. The auth.json fs.watch is the
// only cross-process signal; on it we invoke the bridge's /refresh-auth on the visible
// session's pi, re-fetch, and validate the selection against the fresh list.
//
// Only the ACTIVE runtime is validated (its model is the one shown). Other open tabs are
// marked dirty and self-correct the next time they become active.
export interface AuthRevocationDeps {
  activeRuntime(): SessionRuntime | undefined;
  forEachRuntime(cb: (rt: SessionRuntime) => void): void;
  /** Side-effect-free pi state read (get_state); undefined on any failure. */
  requestState(client: PiRpcClient): Promise<Record<string, unknown> | undefined>;
  /** ModelService.fetchModels: re-fetch + post the list + feed the auth verdict, returns items. */
  fetchModels(): Promise<ModelListItem[]>;
}

export class AuthRevocationService {
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly presenter: WebviewPresenter,
    private readonly deps: AuthRevocationDeps,
  ) {}

  /** auth.json changed (login/logout from ANY pi). Mark every runtime stale; correct the
   *  visible one now if it's idle (a running one is drained when its turn ends). Returns the
   *  drain promise for tests; production callers fire-and-forget. */
  onAuthFileChanged(): Promise<void> {
    this.deps.forEachRuntime((rt) => {
      rt.authDirty = true;
    });
    const active = this.deps.activeRuntime();
    return active ? this.maybeDrain(active) : Promise.resolve();
  }

  /** A runtime became idle or was just activated — drain its pending auth refresh if it's the
   *  visible session. Wired from SessionRuntimeManager (setRunning→idle and activateRuntime). */
  handleRuntimeSettled(rt: SessionRuntime): Promise<void> {
    return this.maybeDrain(rt);
  }

  private async maybeDrain(rt: SessionRuntime): Promise<void> {
    if (!rt.authDirty) return;
    if (rt !== this.deps.activeRuntime()) return; // only the visible session is validated/corrected
    if (rt.isRunning) return; // never interrupt a turn (a deferred drain runs when it ends)
    // A dead client is NOT skipped: forceRefresh self-guards on it, and fetchModels →
    // ensureActiveRuntime revives the runtime — a freshly spawned pi reads auth.json at
    // construction, so the respawn IS the refresh. Live client → reload; dead client → respawn.
    if (this.inFlight.has(rt.id)) return;
    this.inFlight.add(rt.id);
    try {
      await this.refreshAndValidate(rt);
    } catch {
      // best-effort; a later auth change re-arms the dirty flag
    } finally {
      rt.authDirty = false;
      this.inFlight.delete(rt.id);
    }
  }

  private async refreshAndValidate(rt: SessionRuntime): Promise<void> {
    await this.forceRefresh(rt);
    // Re-fetch against the now-fresh registry: posts the list + drives the auth verdict (an
    // empty list flips authState→unauthenticated → the full-screen onboarding gate, no prompt).
    const items = await this.deps.fetchModels();
    if (items.length === 0) return; // 0 models → gate handles it; never prompt or auto-switch
    const client = this.deps.activeRuntime()?.client; // re-resolve: an await may have reaped rt
    if (!client?.isStarted) return;
    const selected = asRecord((await this.deps.requestState(client))?.model);
    const provider = stringField(selected, "provider")?.toLowerCase();
    if (!provider) return; // no model selected → nothing to correct
    const available = new Set(items.map((item) => item.provider.toLowerCase()));
    if (available.has(provider)) return; // selection still valid (provider has usable auth)
    // Provider revoked elsewhere but other models remain → ask the user (per product decision).
    this.presenter.post({ type: "modelInvalidated", previousModel: stringField(selected, "name") ?? stringField(selected, "id") });
  }

  // Make pi reload its model/auth registry from disk via the bundled bridge's /refresh-auth.
  // Guarded: an UNregistered command would otherwise reach the LLM as a literal prompt, so we
  // confirm it exists first (absent only when the bridge failed to load — auth is degraded
  // anyway and the user is told to use a terminal pi). Skipped while the runtime is running.
  private async forceRefresh(rt: SessionRuntime): Promise<void> {
    const client = rt.client;
    if (!client?.isStarted || rt.isRunning) return;
    if (!(await this.refreshCommandAvailable(client))) return;
    await client.request({ type: "prompt", message: "/refresh-auth" }, 10_000).catch(() => undefined);
  }

  private async refreshCommandAvailable(client: PiRpcClient): Promise<boolean> {
    const response = await client.request({ type: "get_commands" }, 10_000).catch(() => undefined);
    if (!response || response.success === false) return false;
    const data = asRecord(response.data);
    const commands = Array.isArray(data?.commands) ? data.commands : [];
    return commands.some((command) => asRecord(command)?.name === "refresh-auth");
  }
}
