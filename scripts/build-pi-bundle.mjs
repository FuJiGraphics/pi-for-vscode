#!/usr/bin/env node
// Build resources/pi-bundle.tar.gz for one platform target.
//
// Installs @earendil-works/pi-coding-agent@<PI_VERSION> into a staging prefix with
// npm's --os/--cpu so only the host-matching native optionalDependencies are pulled,
// prunes runtime-irrelevant files, and tars the resulting node_modules tree. The tar
// is extracted verbatim into globalStorage/pi/<version>/ at first run (see piResolver.ts).
//
// Usage: node scripts/build-pi-bundle.mjs --target darwin-arm64
//        (no --target → host platform)

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Keep in sync with PINNED_PI_VERSION in src/piResolver.ts.
const PI_VERSION = "0.80.6";
const PI_PACKAGE = "@earendil-works/pi-coding-agent";

// Validated pi extensions shipped IN the bundle so todos + web research work out of the
// box. The broker loads each via `-e <pkg>/index.ts` ONLY when the bundled pi is used AND
// the user hasn't already installed it (see chatViewProvider.computeBundledExtensionArgs).
// Keep in sync with BUNDLED_PI_PACKAGES in src/chatViewProvider.ts. Platform-independent
// (pure JS/TS), so installed regardless of --os/--cpu.
const BUNDLED_PACKAGES = ["@juicesharp/rpiv-todo@1.18.2", "pi-web-access@0.10.7"];

const TARGETS = {
  "darwin-arm64": { os: "darwin", cpu: "arm64" },
  "darwin-x64": { os: "darwin", cpu: "x64" },
  "win32-x64": { os: "win32", cpu: "x64" },
  "win32-arm64": { os: "win32", cpu: "arm64" },
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseTarget() {
  const idx = process.argv.indexOf("--target");
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return `${process.platform}-${process.arch}`;
}

function rmrf(target) {
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
}

// Per target, the @mariozechner/clipboard platform packages worth keeping. npm's
// --os/--cpu does not filter these (they carry no os/cpu fields), so they are all
// installed and the non-matching ones are dead weight in a per-platform vsix.
const CLIPBOARD_KEEP = {
  "darwin-arm64": new Set(["clipboard-darwin-arm64", "clipboard-darwin-universal"]),
  "darwin-x64": new Set(["clipboard-darwin-x64", "clipboard-darwin-universal"]),
  "win32-x64": new Set(["clipboard-win32-x64-msvc"]),
  "win32-arm64": new Set(["clipboard-win32-arm64-msvc"]),
};

function prunePiTuiNative(nativeDir, target) {
  const targetOs = TARGETS[target].os;
  for (const osDir of fs.readdirSync(nativeDir)) {
    const osPath = path.join(nativeDir, osDir);
    if (osDir !== targetOs) {
      rmrf(osPath);
      continue;
    }
    const prebuilds = path.join(osPath, "prebuilds");
    if (!fs.existsSync(prebuilds)) continue;
    for (const plat of fs.readdirSync(prebuilds)) {
      if (plat !== target) rmrf(path.join(prebuilds, plat));
    }
  }
}

function pruneTree(dir, target) {
  // Junk dirs to drop, but only when they are NOT a real package (no package.json),
  // so we never delete a dependency that happens to be named "test"/"docs"/etc.
  const dropDir = new Set(["test", "tests", "__tests__", "example", "examples", ".github", "docs"]);
  const clipboardKeep = CLIPBOARD_KEEP[target];

  // Dependencies may be nested (npm does not always hoist), so walk recursively.
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        // Drop non-target clipboard platform packages.
        if (entry.name.startsWith("clipboard-") && !clipboardKeep.has(entry.name)) {
          rmrf(full);
          continue;
        }
        // Trim pi-tui prebuilds down to the target.
        if (entry.name === "native" && path.basename(current) === "pi-tui") {
          prunePiTuiNative(full, target);
          continue;
        }
        if (dropDir.has(entry.name) && !fs.existsSync(path.join(full, "package.json"))) {
          rmrf(full);
          continue;
        }
        walk(full);
      } else {
        const lower = entry.name.toLowerCase();
        if (lower.endsWith(".d.ts") || lower.endsWith(".map") || lower.endsWith(".md") || lower.endsWith(".markdown")) {
          fs.rmSync(full, { force: true });
        }
      }
    }
  };
  walk(dir);
}

function main() {
  const target = parseTarget();
  if (!TARGETS[target]) {
    console.error(`Unsupported target "${target}". Supported: ${Object.keys(TARGETS).join(", ")}`);
    process.exit(1);
  }
  const { os: targetOs, cpu: targetCpu } = TARGETS[target];

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bundle-"));
  console.log(`[build-pi-bundle] target=${target} stage=${stage}`);

  try {
    // An empty private package.json keeps npm from walking up to this repo.
    fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify({ name: "pi-bundle-stage", private: true }) + "\n");

    execFileSync(
      "npm",
      [
        "install",
        `${PI_PACKAGE}@${PI_VERSION}`,
        ...BUNDLED_PACKAGES,
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        "--no-save",
        `--os=${targetOs}`,
        `--cpu=${targetCpu}`,
        "--prefix",
        stage,
      ],
      { stdio: "inherit", cwd: stage },
    );

    const nodeModules = path.join(stage, "node_modules");
    const entry = path.join(nodeModules, "@earendil-works", "pi-coding-agent", "dist", "cli.js");
    if (!fs.existsSync(entry)) {
      throw new Error(`Install did not produce ${entry}`);
    }

    pruneTree(nodeModules, target);

    const resources = path.join(ROOT, "resources");
    fs.mkdirSync(resources, { recursive: true });
    const tarball = path.join(resources, "pi-bundle.tar.gz");
    rmrf(tarball);

    execFileSync("tar", ["-czf", tarball, "-C", stage, "node_modules"], { stdio: "inherit" });
    fs.writeFileSync(
      path.join(resources, "pi-bundle.manifest.json"),
      JSON.stringify({ package: PI_PACKAGE, version: PI_VERSION, target, packages: BUNDLED_PACKAGES }, null, 2) + "\n",
    );

    const sizeMb = (fs.statSync(tarball).size / (1024 * 1024)).toFixed(1);
    console.log(`[build-pi-bundle] wrote ${tarball} (${sizeMb} MB) for ${target}`);
  } finally {
    rmrf(stage);
  }
}

main();
