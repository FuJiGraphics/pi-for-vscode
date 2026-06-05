import * as vscode from "vscode";
import { PiChatViewProvider } from "./chatViewProvider";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new PiChatViewProvider(context);
  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider("pi-for-vscode.chat", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("pi-for-vscode.open", () => provider.open()),
    vscode.commands.registerCommand("pi-for-vscode.newSession", () => provider.newSession()),
    vscode.commands.registerCommand("pi-for-vscode.stop", () => provider.stop()),
  );

  if (vscode.workspace.getConfiguration("pi-for-vscode").get<boolean>("openOnStartup", false)) {
    void provider.open();
  }
}

export function deactivate(): void {}
