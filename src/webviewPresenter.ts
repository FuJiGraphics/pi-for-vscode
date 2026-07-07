import * as vscode from "vscode";
import type { ExtensionToWebviewMessage } from "./protocol";

// Owns the single WebviewView and is the ONLY place that calls webview.postMessage. Every
// other unit shows something to the user by going through here, so message posting + listener
// lifetime live in one spot with one reason to change.
export class WebviewPresenter {
  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];
  private lastUsageMessage?: ExtensionToWebviewMessage;

  attach(view: vscode.WebviewView): void {
    this.view = view;
  }

  pushDisposable(...disposables: vscode.Disposable[]): void {
    this.disposables.push(...disposables);
  }

  disposeListeners(): void {
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }

  hasView(): boolean {
    return !!this.view;
  }

  post(message: ExtensionToWebviewMessage): void {
    void this.view?.webview.postMessage(message);
  }

  // Usage data is account-global and fire-and-forget; posts to a closed sidebar are
  // dropped, so keep the latest one to re-seed a freshly (re)created webview.
  postUsage(message: ExtensionToWebviewMessage): void {
    this.lastUsageMessage = message;
    this.post(message);
  }

  repostUsage(): void {
    if (this.lastUsageMessage) this.post(this.lastUsageMessage);
  }

  postSystem(text: string): void {
    // Teardown noise, not user information: when a runtime is reaped (tab closed, session
    // deleted, window closing) its in-flight RPCs reject with this exact message, and the
    // rejections bubble up through whatever await was pending. Showing it painted a scary
    // "pi RPC client disposed" system bubble right after closing the last tab.
    if (text.includes("pi RPC client disposed")) return;
    this.post({ type: "system", text });
  }

  postConnection(status: "reconnecting" | "connected" | "disconnected"): void {
    this.post({ type: "connection", status });
  }

  postTheme(theme: unknown, kind: "light" | "dark" | "highContrast" | "highContrastLight"): void {
    this.post({ type: "theme", theme, kind });
  }
}
