#!/usr/bin/env node
// Build one platform-specific .vsix per supported target, each carrying that
// target's pi bundle. Linux is intentionally omitted until pi-tui ships a Linux
// prebuild (see plan / README).
//
// Usage: node scripts/package-all.mjs

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGETS = ["darwin-arm64", "darwin-x64", "win32-x64", "win32-arm64"];

function run(cmd, args) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", cwd: ROOT });
}

function main() {
  const outDir = path.join(ROOT, "dist");
  fs.mkdirSync(outDir, { recursive: true });

  // Compile host + webview once; vsce:prepublish would repeat it per package otherwise.
  run("npm", ["run", "compile"]);

  for (const target of TARGETS) {
    run("node", ["scripts/build-pi-bundle.mjs", "--target", target]);
    const out = path.join(outDir, `pi-for-vscode-${target}.vsix`);
    run("npx", ["vsce", "package", "--target", target, "-o", out]);
    const sizeMb = (fs.statSync(out).size / (1024 * 1024)).toFixed(1);
    console.log(`[package-all] ${target} -> ${out} (${sizeMb} MB)`);
  }

  console.log(`\n[package-all] done. ${TARGETS.length} packages in ${outDir}`);
}

main();
