import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { ensureBundledPi, getBundleRoot, type PiRuntime } from "./piResolver";

// Validated pi extensions shipped inside resources/pi-bundle.tar.gz (see the BUNDLED_PACKAGES
// list in scripts/build-pi-bundle.mjs — keep the two in sync). Each is loaded via
// `-e <pkg>/<entry>` so todos + web research work out of the box, but ONLY when the user has
// not already installed that package into their own pi (settings.json) and the matching
// pi-for-vscode.bundle.<setting> toggle is on. This keeps a user's own version authoritative
// (use-installed-else-bundled) and lets the prompt-bloat be turned off per package.
interface BundledPiPackage {
  /** npm package name; must match an entry in build-pi-bundle.mjs BUNDLED_PACKAGES. */
  name: string;
  /** Gated by pi-for-vscode.bundle.<setting>. */
  setting: "todo" | "web";
  /** Extension file relative to the package dir (its package.json `pi.extensions` entry). */
  entry: string;
}
const BUNDLED_PI_PACKAGES: BundledPiPackage[] = [
  { name: "@juicesharp/rpiv-todo", setting: "todo", entry: "index.ts" },
  { name: "pi-web-access", setting: "web", entry: "index.ts" },
];

/** Pure: does a pi `settings.json` `packages` array already reference this package name? */
export function packageInList(packages: unknown, pkgName: string): boolean {
  return Array.isArray(packages) && packages.some((p) => typeof p === "string" && p.includes(pkgName));
}

export class BundledExtensionResolver {
  constructor(private readonly context: vscode.ExtensionContext) {}

  // `-e <file>` flags for the bundled pi extensions (todo / web), so they work out of the
  // box. Skipped when useBundledPi is "never", when the per-package toggle is off, or when the
  // user already registered the package in their own pi (use-installed-else-bundled). For a
  // non-bundled pi the bundle is extracted on demand so the package files exist to point at;
  // any failure degrades silently — the session still launches without the extra tools.
  async computeArgs(runtime: PiRuntime, cwd: string): Promise<string[]> {
    const cfg = vscode.workspace.getConfiguration("pi-for-vscode");
    if (cfg.get<"auto" | "always" | "never">("useBundledPi", "auto") === "never") return [];

    const wanted = BUNDLED_PI_PACKAGES.filter(
      (pkg) => cfg.get<boolean>(`bundle.${pkg.setting}`, true) && !this.isPackageRegistered(pkg.name, cwd),
    );
    if (wanted.length === 0) return [];

    try {
      // Bundled source is already extracted (its piEntry came from the bundle); otherwise
      // ensure extraction so the package files are present under the same node_modules.
      if (runtime.source !== "bundled") await ensureBundledPi(this.context);
    } catch {
      return [];
    }

    const nodeModules = path.join(getBundleRoot(this.context), "node_modules");
    const args: string[] = [];
    for (const pkg of wanted) {
      const file = path.join(nodeModules, pkg.name, pkg.entry);
      if (fs.existsSync(file)) args.push("-e", file);
    }
    return args;
  }

  // True when a package name appears in the user's pi `packages` list (global or project),
  // meaning their own install owns it and the bundled copy must not be loaded on top.
  private isPackageRegistered(pkgName: string, cwd: string): boolean {
    const files = [
      path.join(os.homedir(), ".pi", "agent", "settings.json"),
      path.join(cwd, ".pi", "settings.json"),
    ];
    for (const file of files) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { packages?: unknown };
        if (packageInList(parsed.packages, pkgName)) return true;
      } catch {
        // Missing or unreadable settings → not registered here; keep checking.
      }
    }
    return false;
  }
}
