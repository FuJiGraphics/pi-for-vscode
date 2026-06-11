import * as path from "node:path";
import * as vscode from "vscode";
import type { PiSessionSummary } from "./sessionStore";
import type { SessionListItem } from "./protocol";

export interface SessionQuickPickItem extends vscode.QuickPickItem {
  action?: "new";
  sessionPath?: string;
}

function workspaceLabel(summary: PiSessionSummary): string {
  if (summary.isCurrentWorkspace) return "Current workspace";
  return summary.cwd ? path.basename(summary.cwd) : "Unknown workspace";
}

function messageCountLabel(count: number): string {
  return `${count} message${count === 1 ? "" : "s"}`;
}

export function toSessionQuickPickItem(summary: PiSessionSummary, workspaceCwd?: string): SessionQuickPickItem {
  const descriptionParts = [
    summary.isCurrent ? "Current" : undefined,
    workspaceLabel(summary),
    messageCountLabel(summary.messageCount),
    formatRelativeTime(summary.updatedAt),
  ].filter(Boolean);

  return {
    label: `${summary.isCurrent ? "$(check)" : "$(history)"} ${summary.title}`,
    description: descriptionParts.join(" • "),
    detail: [summary.preview, summary.cwd && summary.cwd !== workspaceCwd ? summary.cwd : undefined, summary.filePath].filter(Boolean).join("\n"),
    sessionPath: summary.filePath,
  };
}

// Runtime liveness flags injected by the provider (not derivable from the on-disk
// summary): whether a background pi runtime is mid-turn on this session, and whether
// it has a buffered UI request waiting for the user to switch to it.
export function toSessionListItem(
  summary: PiSessionSummary,
  runtime?: { isRunning?: boolean; needsInput?: boolean },
): SessionListItem {
  const metaParts = [
    workspaceLabel(summary),
    messageCountLabel(summary.messageCount),
    formatRelativeTime(summary.updatedAt),
  ].filter(Boolean);

  return {
    filePath: summary.filePath,
    title: summary.title,
    preview: summary.preview,
    meta: metaParts.join(" • "),
    isCurrent: summary.isCurrent,
    isRunning: runtime?.isRunning,
    needsInput: runtime?.needsInput,
  };
}

export function formatRelativeTime(timestamp: number): string {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (elapsedSeconds < 60) return "just now";
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h ago`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 30) return `${elapsedDays}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/** A trimmed, non-empty string field from a loose record, else undefined. */
export function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
