import * as vscode from "vscode";
import type { ExtensionToWebviewMessage } from "./protocol";

// Owns the single WebviewView and is the ONLY place that calls webview.postMessage. Every
// other unit shows something to the user by going through here, so message posting + listener
// lifetime live in one spot with one reason to change.
export class WebviewPresenter {
  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];

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

  postSystem(text: string): void {
    this.post({ type: "system", text });
  }

  postConnection(status: "reconnecting" | "connected" | "disconnected"): void {
    this.post({ type: "connection", status });
  }
}
