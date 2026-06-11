// Diff parsing + added/removed line counts for Edit/Write steps. Pure and DOM-free (same
// contract as cards.ts) so it unit-tests directly. cards.ts renders FROM these parsers —
// keeping them here (not in cards.ts) avoids an import cycle and keeps both files lean.
import type { ActivityStep } from "./types";

// Parse pi's real edit diff (details.diff): lines are "<sign><lineNo> <content>", sign one of
// space/+/-. Non-matching lines render as neutral context with no number.
export function parsePiDiff(diff: string): Array<{ lineNo: string; sign: " " | "+" | "-"; content: string }> {
  const out: Array<{ lineNo: string; sign: " " | "+" | "-"; content: string }> = [];
  for (const line of diff.split("\n")) {
    const m = /^([ +-])(\d+) ?(.*)$/.exec(line);
    if (m) out.push({ sign: m[1] as " " | "+" | "-", lineNo: m[2], content: m[3] });
    else if (line.length) out.push({ sign: " ", lineNo: "", content: line });
  }
  return out;
}

// Normalize pi's edit args into [{oldText,newText}]: the schema is an `edits` array, but
// some models send it as a JSON string, and the legacy shape is a flat oldText/newText.
export function normalizeEdits(input: Record<string, unknown>): Array<{ oldText: string; newText: string }> {
  let edits: unknown = input.edits;
  if (typeof edits === "string") {
    try {
      edits = JSON.parse(edits);
    } catch {
      edits = undefined;
    }
  }
  if (Array.isArray(edits)) {
    return edits
      .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
      .map((e) => ({ oldText: typeof e.oldText === "string" ? e.oldText : "", newText: typeof e.newText === "string" ? e.newText : "" }));
  }
  if (typeof input.oldText === "string" || typeof input.newText === "string") {
    return [{ oldText: typeof input.oldText === "string" ? input.oldText : "", newText: typeof input.newText === "string" ? input.newText : "" }];
  }
  return [];
}

export interface DiffStats {
  added: number;
  removed: number;
}

function countLines(text: string): number {
  return text ? text.split("\n").length : 0;
}

/** Added/removed line counts for an Edit/Write step's "+N -N" badge (Codex-style).
 *  Edit prefers pi's real diff (exact); until it's enriched the args give an estimate
 *  (the badge re-rolls when the diff lands — the row's render sig flips on output).
 *  Write counts its content as all-added. Other tools have no stats. */
export function diffStatsFor(step: ActivityStep): DiffStats | undefined {
  const tool = (step.tool || step.label || "").toLowerCase();
  if (tool === "write") {
    const content = typeof step.input?.content === "string" ? (step.input.content as string) : "";
    return content ? { added: countLines(content), removed: 0 } : undefined;
  }
  if (tool !== "edit") return undefined;
  const realDiff = step.output?.diff;
  if (realDiff) {
    let added = 0;
    let removed = 0;
    for (const row of parsePiDiff(realDiff)) {
      if (row.sign === "+") added++;
      else if (row.sign === "-") removed++;
    }
    return { added, removed };
  }
  const edits = normalizeEdits(step.input || {});
  if (!edits.length) return undefined;
  let added = 0;
  let removed = 0;
  for (const edit of edits) {
    added += countLines(edit.newText);
    removed += countLines(edit.oldText);
  }
  return { added, removed };
}
