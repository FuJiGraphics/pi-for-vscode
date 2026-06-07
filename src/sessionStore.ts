import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface PiSessionSummary {
  filePath: string;
  cwd?: string;
  title: string;
  preview?: string;
  name?: string;
  firstUserMessage?: string;
  lastMessage?: string;
  messageCount: number;
  createdAt?: number;
  updatedAt: number;
  isCurrent: boolean;
  isCurrentWorkspace: boolean;
}

interface SessionEntry {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  cwd?: string;
  name?: string;
  message?: {
    role?: string;
    content?: unknown;
    timestamp?: number;
  };
  customType?: string;
  content?: unknown;
  display?: boolean;
  details?: unknown;
  summary?: string;
  fromId?: string;
  tokensBefore?: number;
}

export async function listPiSessions(options: {
  cwd?: string;
  currentSessionFile?: string;
  max?: number;
} = {}): Promise<PiSessionSummary[]> {
  const roots = new Set<string>();
  if (options.cwd) roots.add(getDefaultProjectSessionDir(options.cwd));
  else roots.add(path.join(os.homedir(), ".pi", "agent", "sessions"));

  const currentSessionFile = options.currentSessionFile ? path.resolve(options.currentSessionFile) : undefined;
  const currentRoot = currentSessionFile ? findSessionsRoot(currentSessionFile) : undefined;
  if (currentRoot) roots.add(currentRoot);

  const files: string[] = [];
  for (const root of roots) {
    files.push(...await collectSessionFiles(root));
  }

  const uniqueFiles = [...new Set(files.map((file) => path.resolve(file)))];
  const summaries = (await Promise.all(uniqueFiles.map((file) => parseSessionFile(file, options.cwd, currentSessionFile)))).filter(
    (summary): summary is PiSessionSummary => summary !== undefined,
  );

  const scopedSummaries = options.cwd ? summaries.filter((summary) => summary.isCurrentWorkspace) : summaries;

  // Stable newest-first. Do NOT float the current session to the top — that made the
  // list reshuffle every time you switched sessions. The current session keeps its
  // "Current" badge in its chronological (most-recently-updated) place.
  scopedSummaries.sort((a, b) => {
    if (a.isCurrentWorkspace !== b.isCurrentWorkspace) return a.isCurrentWorkspace ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });

  return scopedSummaries.slice(0, options.max ?? 80);
}

export async function deleteSession(filePath: string): Promise<void> {
  await fs.unlink(filePath);
}

export async function renameSession(filePath: string, name: string): Promise<void> {
  // Fallback used only when pi is NOT running on this session (otherwise the host
  // routes the rename through pi's `set_session_name` RPC so pi's in-memory state
  // stays in sync — see PiChatViewProvider.renameSession).
  //
  // Pi records the display name as a `session_info` entry and reads the latest one
  // by file order. We mirror pi's entry shape (a tree node: `id` + `parentId`
  // pointing at the current leaf). A bare line without `id`/`parentId` becomes
  // pi's leaf on reload with an undefined id and corrupts the session tree.
  const text = await fs.readFile(filePath, "utf8").catch(() => "");
  const { leafId, ids } = scanTree(text);
  const entry = JSON.stringify({
    type: "session_info",
    id: freshEntryId(ids),
    parentId: leafId,
    timestamp: new Date().toISOString(),
    name: name.trim(),
  });
  await fs.appendFile(filePath, entry + "\n", "utf8");
}

// Walk the entries to find the current leaf (last entry with an id) and the set of
// used ids, mirroring how pi rebuilds its tree index from the file.
function scanTree(text: string): { leafId: string | null; ids: Set<string> } {
  const ids = new Set<string>();
  let leafId: string | null = null;
  for (const entry of parseSessionEntries(text)) {
    if (entry.type === "session") continue;
    if (typeof entry.id === "string") {
      ids.add(entry.id);
      leafId = entry.id;
    }
  }
  return { leafId, ids };
}

// Mirror of pi's id generation: an 8-char slice of a UUID, retried on collision.
function freshEntryId(used: Set<string>): string {
  for (let i = 0; i < 100; i++) {
    const id = randomUUID().slice(0, 8);
    if (!used.has(id)) return id;
  }
  return randomUUID();
}

export async function readPiSessionCwd(filePath: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }

  for (const entry of parseSessionEntries(text)) {
    if (entry.type === "session") return typeof entry.cwd === "string" ? entry.cwd : undefined;
  }
  return undefined;
}

export async function isPiSessionInWorkspace(filePath: string, cwd: string): Promise<boolean> {
  const sessionCwd = await readPiSessionCwd(filePath);
  return Boolean(sessionCwd && normalizePath(sessionCwd) === normalizePath(cwd));
}

export async function readPiSessionMessages(filePath: string): Promise<unknown[]> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch {
    return [];
  }

  const entries = parseSessionEntries(text);
  const branch = getCurrentBranch(entries);
  const displayEntries = branch.length > 0 ? branch : entries;
  const messages: unknown[] = [];
  for (const entry of displayEntries) {
    if (entry.type === "message" && entry.message) {
      messages.push(entry.message);
    } else if (entry.type === "custom_message" && entry.display) {
      messages.push({
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
        details: entry.details,
        timestamp: timestampToMs(entry.timestamp) ?? Date.now(),
      });
    } else if (entry.type === "compaction" && entry.summary) {
      messages.push({
        role: "compactionSummary",
        summary: entry.summary,
        tokensBefore: entry.tokensBefore ?? 0,
        timestamp: timestampToMs(entry.timestamp) ?? Date.now(),
      });
    }
  }

  return messages;
}

// Pull a finished tool's output (bash stdout, read content, web result) from the session
// file. The live RPC stream carries only tool INPUT, so the webview enriches a finished step
// with this. Tail-reads the file (the result lands near the end right after the tool ran) so
// it stays cheap even for long sessions.
// pi records a finished tool's user-facing message in `content`, and (for edit) the real
// line-numbered unified diff in `details` — surface both so the webview can show a true diff.
export interface ToolResult {
  text: string;
  isError: boolean;
  diff?: string;
  firstChangedLine?: number;
}

export async function readToolResult(filePath: string, toolCallId: string): Promise<ToolResult | undefined> {
  let stat: { size: number };
  try {
    stat = await fs.stat(filePath);
  } catch {
    return undefined;
  }
  const CAP = 512 * 1024;
  const start = Math.max(0, stat.size - CAP);
  let handle: import("node:fs/promises").FileHandle | undefined;
  try {
    handle = await fs.open(filePath, "r");
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    let text = buffer.toString("utf8");
    if (start > 0) {
      const nl = text.indexOf("\n");
      if (nl >= 0) text = text.slice(nl + 1); // drop a partial first line from the tail cut
    }
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let entry: SessionEntry & {
        message?: { role?: string; toolCallId?: string; content?: unknown; isError?: boolean; details?: unknown };
      };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const m = entry.message;
      if (entry.type === "message" && m && m.role === "toolResult" && m.toolCallId === toolCallId) {
        const details = m.details && typeof m.details === "object" ? (m.details as Record<string, unknown>) : undefined;
        const diff = typeof details?.diff === "string" ? details.diff : undefined;
        const firstChangedLine = typeof details?.firstChangedLine === "number" ? details.firstChangedLine : undefined;
        return { text: contentToText(m.content), isError: !!m.isError, diff, firstChangedLine };
      }
    }
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
  return undefined;
}

function parseSessionEntries(text: string): SessionEntry[] {
  const entries: SessionEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as SessionEntry);
    } catch {
      // Skip malformed lines.
    }
  }
  return entries;
}

function getCurrentBranch(entries: SessionEntry[]): SessionEntry[] {
  const byId = new Map<string, SessionEntry>();
  let leaf: SessionEntry | undefined;

  for (const entry of entries) {
    if (entry.type === "session" || typeof entry.id !== "string") continue;
    byId.set(entry.id, entry);
    leaf = entry;
  }

  const branch: SessionEntry[] = [];
  let current = leaf;
  while (current) {
    branch.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  return branch;
}

async function collectSessionFiles(root: string): Promise<string[]> {
  const result: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 3) return;

    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        result.push(entryPath);
      }
    }
  }

  await walk(root, 0);
  return result;
}

async function parseSessionFile(filePath: string, cwd?: string, currentSessionFile?: string): Promise<PiSessionSummary | undefined> {
  let stat: { mtimeMs: number; birthtimeMs: number };
  let text: string;
  try {
    stat = await fs.stat(filePath);
    text = await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }

  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return undefined;

  let sessionCwd: string | undefined;
  let sessionName: string | undefined;
  let firstUserMessage: string | undefined;
  let lastMessage: string | undefined;
  let createdAt: number | undefined;
  let updatedAt = stat.mtimeMs;
  let messageCount = 0;

  for (const line of lines) {
    let entry: SessionEntry;
    try {
      entry = JSON.parse(line) as SessionEntry;
    } catch {
      continue;
    }

    const entryTime = timestampToMs(entry.timestamp);
    if (entryTime) updatedAt = Math.max(updatedAt, entryTime);

    if (entry.type === "session") {
      sessionCwd = typeof entry.cwd === "string" ? entry.cwd : sessionCwd;
      createdAt = entryTime ?? createdAt;
      continue;
    }

    if (entry.type === "session_info" && typeof entry.name === "string") {
      sessionName = entry.name.trim() || undefined;
      continue;
    }

    if (entry.type !== "message" || !entry.message) continue;
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") continue;

    const text = contentToText(entry.message.content).trim();
    if (!text) continue;

    messageCount++;
    if (role === "user" && !firstUserMessage) firstUserMessage = text;
    lastMessage = text;

    if (typeof entry.message.timestamp === "number") {
      updatedAt = Math.max(updatedAt, entry.message.timestamp);
    }
  }

  const normalizedCwd = cwd ? normalizePath(cwd) : undefined;
  const normalizedSessionCwd = sessionCwd ? normalizePath(sessionCwd) : undefined;
  const isCurrentWorkspace = Boolean(normalizedCwd && normalizedSessionCwd && normalizedCwd === normalizedSessionCwd);
  const isCurrent = Boolean(currentSessionFile && path.resolve(filePath) === currentSessionFile);

  const title = truncate(sessionName || firstUserMessage || path.basename(filePath, ".jsonl"), 90);
  const preview = lastMessage && lastMessage !== title ? truncate(lastMessage, 140) : undefined;

  return {
    filePath,
    cwd: sessionCwd,
    title,
    preview,
    name: sessionName,
    firstUserMessage,
    lastMessage,
    messageCount,
    createdAt: createdAt ?? stat.birthtimeMs,
    updatedAt,
    isCurrent,
    isCurrentWorkspace,
  };
}

function getDefaultProjectSessionDir(cwd: string): string {
  const resolvedCwd = path.resolve(cwd);
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return path.join(os.homedir(), ".pi", "agent", "sessions", safePath);
}

function findSessionsRoot(filePath: string): string | undefined {
  let dir = path.dirname(filePath);
  while (dir && dir !== path.dirname(dir)) {
    if (path.basename(dir) === "sessions") return dir;
    dir = path.dirname(dir);
  }
  return undefined;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content.map((block) => {
    if (!block || typeof block !== "object") return "";
    const typed = block as { type?: string; text?: string; data?: string; mimeType?: string };
    if (typed.type === "text") return typed.text ?? "";
    if (typed.type === "image") return "[image]";
    return "";
  }).filter(Boolean).join("\n");
}

function timestampToMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function normalizePath(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}
