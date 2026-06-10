// Claude-style slash-command palette. Typing "/" as the first character of the
// composer opens a filterable, keyboard-navigable menu of commands grouped by
// source. Pi commands (skills / prompt-templates / extensions) come from the
// `get_commands` RPC; a few client built-ins (/new, /model, /history, /stop) are
// merged in so "/" is a single entry point. Mirrors the modelPicker popover.
import { appEl, commandListEl, commandPanelEl, composerEl } from "./dom";
import { post } from "./bridge";
import { escapeHtml } from "./util";
import { clearComposer, setComposerToCommand } from "./input";
import { closeModelPicker, toggleModelPicker } from "./modelPicker";
import { closeHistory, toggleHistory } from "./history";
import { setRunning } from "./conversation";
import type { CommandListItem } from "../protocol";

type CommandSource = "builtin" | "extension" | "prompt" | "skill";

interface CommandRow {
  name: string; // inserted after "/" (e.g. "new", "review", "skill:foo")
  description: string;
  source: CommandSource;
  origin: "pi" | "client";
  sourceTag?: string;
  run?: () => void; // client built-ins only
}

// Built-in client actions — mapped to existing webview actions / RPC so the
// palette is a single entry point alongside Pi's own commands.
const BUILTINS: CommandRow[] = [
  {
    name: "new", description: "Start a new session", source: "builtin", origin: "client",
    run: () => { closeHistory(); closeModelPicker(); post({ type: "newSession" }); },
  },
  { name: "model", description: "Switch model", source: "builtin", origin: "client", run: () => toggleModelPicker() },
  { name: "history", description: "Browse session history", source: "builtin", origin: "client", run: () => toggleHistory() },
  {
    name: "stop", description: "Stop Pi", source: "builtin", origin: "client",
    run: () => { setRunning(false); post({ type: "abort" }); },
  },
];

const SECTION_ORDER: CommandSource[] = ["builtin", "extension", "prompt", "skill"];
const SECTION_LABEL: Record<CommandSource, string> = {
  builtin: "Built-in", extension: "Commands", prompt: "Prompts", skill: "Skills",
};

let piCommands: CommandRow[] = [];
let loaded = false;
let query = "";
let activeIndex = 0;
let navItems: CommandRow[] = []; // flattened, header-excluded order backing ↑/↓ + Enter

export function isCommandMenuOpen(): boolean {
  return appEl.classList.contains("command-open");
}

export function openCommandMenu(): void {
  appEl.classList.remove("history-open");
  appEl.classList.remove("model-open");
  appEl.classList.remove("thinking-open");
  appEl.classList.remove("settings-open");
  appEl.classList.add("command-open");
  activeIndex = 0;
  if (!loaded) post({ type: "requestCommands" }); // built-ins show immediately; Pi commands fill in
  applyFilter();
}

export function closeCommandMenu(): void {
  appEl.classList.remove("command-open");
  activeIndex = 0;
}

// Drop the cached pi command list so it is re-fetched. Called when the active session/runtime
// changes: a different pi (with possibly different installed packages/skills) is now active, so
// the previous get_commands snapshot is stale. The next openCommandMenu() re-requests via its
// `!loaded` gate; if the menu is open right now, refetch immediately. Existing rows are kept until
// the fresh list arrives so the menu does not flash empty.
export function invalidateCommands(): void {
  loaded = false;
  if (isCommandMenuOpen()) post({ type: "requestCommands" });
}

export function setCommandQuery(q: string): void {
  query = q;
  activeIndex = 0;
  if (isCommandMenuOpen()) applyFilter();
}

export function renderCommandList(commands: CommandListItem[]): void {
  piCommands = (Array.isArray(commands) ? commands : []).map((c) => ({
    name: c.name,
    description: c.description,
    source: c.source,
    origin: "pi" as const,
    sourceTag: c.sourceTag,
  }));
  loaded = true;
  if (isCommandMenuOpen()) applyFilter();
}

function matches(row: CommandRow, q: string): boolean {
  return (row.name + " " + row.description + " " + (row.sourceTag || "")).toLowerCase().includes(q);
}

// Prefix match on the command name ranks ahead of a mere substring match.
function score(row: CommandRow, q: string): number {
  return row.name.toLowerCase().startsWith(q) ? 0 : 1;
}

function itemHtml(row: CommandRow, idx: number, active: boolean): string {
  // The middot that used to fuse "source · sourceTag" is gone: the source is a muted
  // label and the tag (if any) a small pill, separated by the badge's flex gap.
  const badgeInner =
    '<span class="cb-source">' + escapeHtml(row.source) + "</span>" +
    (row.sourceTag ? '<span class="cb-tag">' + escapeHtml(row.sourceTag) + "</span>" : "");
  return (
    '<button class="command-item' + (active ? " active" : "") + '" data-idx="' + idx + '">' +
    '<span class="command-name">/' + escapeHtml(row.name) + "</span>" +
    '<span class="command-desc">' + escapeHtml(row.description) + "</span>" +
    '<span class="command-badge badge-' + row.source + '">' + badgeInner + "</span>" +
    "</button>"
  );
}

function applyFilter(): void {
  const q = query.trim().toLowerCase();
  const all = [...BUILTINS, ...piCommands];
  const filtered = q ? all.filter((r) => matches(r, q)) : all;

  if (filtered.length === 0) {
    navItems = [];
    commandListEl.innerHTML =
      '<div class="command-empty">' + (all.length === 0 ? "No commands available." : "No commands match.") + "</div>";
    return;
  }

  // Group into ordered sections; an unknown future source falls into "Other".
  const known = new Set<CommandSource>(SECTION_ORDER);
  const sections: Array<{ label: string; rows: CommandRow[] }> = [];
  for (const source of SECTION_ORDER) {
    let rows = filtered.filter((r) => r.source === source);
    if (q) rows = [...rows].sort((a, b) => score(a, q) - score(b, q));
    if (rows.length) sections.push({ label: SECTION_LABEL[source], rows });
  }
  const others = filtered.filter((r) => !known.has(r.source));
  if (others.length) sections.push({ label: "Other", rows: others });

  navItems = sections.flatMap((s) => s.rows);
  if (activeIndex >= navItems.length) activeIndex = navItems.length - 1;
  if (activeIndex < 0) activeIndex = 0;

  let html = "";
  let i = 0;
  for (const section of sections) {
    html += '<div class="cmd-section-head">' + escapeHtml(section.label) + "</div>";
    for (const row of section.rows) {
      html += itemHtml(row, i, i === activeIndex);
      i++;
    }
  }
  commandListEl.innerHTML = html;
}

export function moveActive(delta: number): void {
  if (!navItems.length) return;
  activeIndex = (activeIndex + delta + navItems.length) % navItems.length;
  applyFilter();
  const active = commandListEl.querySelector(".command-item.active");
  if (active) active.scrollIntoView({ block: "nearest" });
}

function accept(row: CommandRow): void {
  if (row.origin === "client" && row.run) {
    closeCommandMenu();
    clearComposer();
    row.run();
    return;
  }
  setComposerToCommand(row.name); // insert "/name " and keep focus for arguments
  closeCommandMenu();
}

export function acceptActive(): boolean {
  const row = navItems[activeIndex];
  if (!row) return false;
  accept(row);
  return true;
}

function handleListClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  const item = target && target.closest ? (target.closest(".command-item") as HTMLElement | null) : null;
  if (!item) return;
  const idx = Number(item.dataset.idx);
  if (Number.isInteger(idx) && navItems[idx]) accept(navItems[idx]);
}

function handleOutsideClick(event: MouseEvent): void {
  if (!isCommandMenuOpen()) return;
  const target = event.target as Node | null;
  if (!target) return;
  if (commandPanelEl.contains(target) || composerEl.contains(target)) return;
  closeCommandMenu();
}

export function initCommandMenu(): void {
  commandListEl.addEventListener("click", handleListClick);
  document.addEventListener("click", handleOutsideClick);
}
