// Host side of the clickable-file-reference feature: resolve a path the user clicked in a chat
// message and reveal it in the editor. Paths the agent emits are relative to the cwd the broker
// spawned pi with (workspace folder, or home when no folder is open — see piBroker.ts), so
// relative paths resolve against getAgentCwd(). Best-effort: a missing file is a silent no-op
// (the webview can't check the filesystem, so it links optimistically and the host gates).
import * as path from "node:path";
import * as vscode from "vscode";
import { getAgentCwd } from "./workspace";

export async function openWorkspaceFile(rel: string, line?: number, col?: number): Promise<void> {
  const raw = (rel || "").trim();
  if (!raw) return;
  // Resolve relative paths against the dir Pi runs in (workspace folder, or home when none) —
  // the same cwd the broker spawned pi with, so the agent's relative paths line up.
  const abs = path.isAbsolute(raw) ? raw : path.join(getAgentCwd(), raw);

  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
  } catch {
    return; // file doesn't exist / can't open — silently ignore
  }

  const targetLine = line && line > 0 ? Math.min(line - 1, Math.max(0, doc.lineCount - 1)) : 0;
  const targetCol = col && col > 0 ? col - 1 : 0;
  const pos = new vscode.Position(targetLine, targetCol);
  await vscode.window.showTextDocument(doc, {
    selection: new vscode.Range(pos, pos), // selecting the range scrolls it into view
    viewColumn: vscode.ViewColumn.Active,
    preview: true,
  });
}
