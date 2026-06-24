import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

export interface WorkspaceTarget {
  cwd?: string;
  name?: string;
}

export function getWorkspaceTarget(): WorkspaceTarget {
  const folder = getActiveWorkspaceFolder();
  if (!folder) return { name: vscode.workspace.name };
  return { cwd: folder.uri.fsPath, name: folder.name };
}

// The active workspace folder, or undefined when VS Code has no folder open (an empty window).
export function getWorkspaceCwd(): string | undefined {
  return getWorkspaceTarget().cwd;
}

// The directory Pi actually runs in: the workspace folder when one is open, else the home dir.
// Mirrors Claude Code, which works in a folderless window (it just operates from a default cwd);
// the extension must not refuse to start a session merely because no folder is open. Sessions
// opened this way are scoped under the home dir's session store, same as any other project.
export function getAgentCwd(): string {
  return getWorkspaceCwd() ?? os.homedir();
}

export function getWorkspaceName(cwd?: string): string | undefined {
  if (cwd) {
    const folder = vscode.workspace.workspaceFolders?.find((candidate) => samePath(candidate.uri.fsPath, cwd));
    return folder?.name ?? path.basename(cwd);
  }

  return getWorkspaceTarget().name;
}

export function samePath(left?: string, right?: string): boolean {
  if (!left || !right) return false;
  const normalizedLeft = normalizePath(left);
  const normalizedRight = normalizePath(right);
  return normalizedLeft === normalizedRight;
}

function getActiveWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) return undefined;

  const activeEditorUri = vscode.window.activeTextEditor?.document.uri;
  if (activeEditorUri) {
    const activeFolder = vscode.workspace.getWorkspaceFolder(activeEditorUri);
    if (activeFolder) return activeFolder;
  }

  return folders[0];
}

function normalizePath(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
