#!/usr/bin/env node
// Fail if any tracked src/*.ts grows past the size budget. The whole point of the
// round-6 refactor was to break up a 1100-line god class; this keeps it broken up.
// Pre-existing large files are grandfathered (they are clean single-responsibility
// modules that simply run long — split them only if they take on a second reason to change).

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";

const MAX_LINES = 400;
const GRANDFATHERED = new Set([
  "src/piRpcClient.ts", // transport client: socket + heartbeat + reconnect, one concern, ~525 lines
  "src/sessionStore.ts", // pi session JSONL I/O, one concern, ~416 lines
  "src/sessionRuntimeManager.ts", // runtime lifecycle owner (map+activeId+spawn/revive/reap/state), one concern, ~457 lines
  "src/webview/render.ts", // two-tier DOM render/paint orchestration; pure builders live in cards.ts, ~450 lines
]);

function gitFiles(args) {
  return execFileSync("git", args, { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);
}

const files = [...new Set([
  ...gitFiles(["ls-files", "src"]),
  ...gitFiles(["ls-files", "--others", "--exclude-standard", "src"]),
])]
  .filter((f) => f.endsWith(".ts") && fs.existsSync(f) && !GRANDFATHERED.has(f));

const offenders = [];
for (const file of files) {
  const lines = fs.readFileSync(file, "utf8").split("\n").length;
  if (lines > MAX_LINES) offenders.push(`${file} (${lines} lines)`);
}

if (offenders.length > 0) {
  console.error(`Files over ${MAX_LINES} lines (split by responsibility, or grandfather in scripts/lint-size.mjs):`);
  for (const o of offenders) console.error(`  ${o}`);
  process.exit(1);
}
console.log(`lint:size OK — all src/*.ts within ${MAX_LINES} lines (excluding grandfathered).`);
