import * as vscode from "vscode";
import type { WebviewPresenter } from "./webviewPresenter";

// Mirrors the active editor (file + selected line range) to the webview's context chip.
// Only a PATH REFERENCE ever crosses the bridge — never file content. Reading the file
// stays with pi's read tool (thin-wrapper boundary), which also keeps prompts small.
export class EditorContextTracker implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private debounce: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly presenter: WebviewPresenter) {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.post()),
      // Selections change on every keystroke/drag — debounce to one post per pause.
      vscode.window.onDidChangeTextEditorSelection(() => this.postDebounced()),
    );
  }

  /** Send the current snapshot now (used on webview `ready` and editor switches). */
  post(): void {
    this.presenter.post(this.snapshot());
  }

  private postDebounced(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.post(), 150);
  }

  private snapshot(): { type: "editorContext"; path?: string; startLine?: number; endLine?: number } {
    const editor = vscode.window.activeTextEditor;
    const document = editor?.document;
    // Untitled/output/diff-virtual docs and files outside the workspace have no path pi
    // could read relative to its cwd → post pathless, which hides the chip.
    if (!editor || !document || document.uri.scheme !== "file" || !vscode.workspace.getWorkspaceFolder(document.uri)) {
      return { type: "editorContext" };
    }
    const relativePath = vscode.workspace.asRelativePath(document.uri, false);
    const selection = editor.selection;
    if (selection && !selection.isEmpty) {
      return {
        type: "editorContext",
        path: relativePath,
        startLine: selection.start.line + 1,
        endLine: selection.end.line + 1,
      };
    }
    return { type: "editorContext", path: relativePath };
  }

  dispose(): void {
    if (this.debounce) clearTimeout(this.debounce);
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }
}
