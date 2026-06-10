// Webview-side store for the host's auth verdict + About info. Global (not per-session):
// auth lives in pi's ~/.pi/agent, shared by every runtime. The onboarding gate and the
// settings panel subscribe; the InboundTable feeds it.
import type { AuthProviderStatus } from "../protocol";

export type AuthStatus = "authenticated" | "unauthenticated" | "unknown";

export interface AboutInfo {
  extensionVersion: string;
  piVersion?: string;
  piSource?: string;
}

let status: AuthStatus = "unknown";
let providers: AuthProviderStatus[] = [];
let authAvailable = true; // bridge liveness (commandList) — optimistic until told otherwise
let about: AboutInfo | undefined;

type Listener = () => void;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeAuthState(listener: Listener): void {
  listeners.add(listener);
}

export function authStatus(): AuthStatus {
  return status;
}

export function authProviders(): readonly AuthProviderStatus[] {
  return providers;
}

export function isAuthAvailable(): boolean {
  return authAvailable;
}

export function aboutInfo(): AboutInfo | undefined {
  return about;
}

export function setAuthState(nextStatus: AuthStatus, nextProviders: AuthProviderStatus[]): void {
  status = nextStatus;
  providers = nextProviders;
  emit();
}

export function setAuthAvailable(value: boolean | undefined): void {
  const next = value !== false;
  if (next === authAvailable) return;
  authAvailable = next;
  emit();
}

export function setAboutInfo(value: AboutInfo): void {
  about = value;
  emit();
}
