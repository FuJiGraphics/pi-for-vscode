import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { ensureBundledPi, getBundleRoot, type PiRuntime } from "./piResolver";

// Validated pi extensions shipped inside resources/pi-bundle.tar.gz. Each is
// loaded via `-e <pkg>/<entry>` only when the user has not already installed
// that package and the matching pi-for-vscode.bundle.<setting> toggle is on.
interface BundledPiPackage {
  /** npm package name; must match scripts/build-pi-bundle.mjs BUNDLED_PACKAGES. */
  name: string;
  /** Gated by pi-for-vscode.bundle.<setting>. */
  setting: "todo" | "web";
  /** Extension file relative to the package dir. */
  entry: string;
}

const BUNDLED_PI_PACKAGES: BundledPiPackage[] = [
  { name: "@juicesharp/rpiv-todo", setting: "todo", entry: "index.ts" },
  { name: "pi-web-access", setting: "web", entry: "index.ts" },
];
// Bridges shipped with this UI shell (always attempted — they ARE the VS Code client glue):
// auth (login/logout commands) and usage (rate-limit header forwarding).
const BRIDGE_RELATIVE_PATHS: ReadonlyArray<readonly string[]> = [
  ["resources", "pi-extensions", "vscode-auth-bridge.ts"],
  ["resources", "pi-extensions", "vscode-usage-bridge.ts"],
];

/** Pure: does a pi `settings.json` `packages` array already reference this package name? */
export function packageInList(packages: unknown, pkgName: string): boolean {
  return Array.isArray(packages) && packages.some((p) => typeof p === "string" && p.includes(pkgName));
}

export class BundledExtensionResolver {
  constructor(private readonly context: vscode.ExtensionContext) {}

  // `-e <file>` flags for this VS Code client's bridge plus optional bundled pi
  // packages. The auth bridge is always attempted because it belongs to this UI
  // shell; todo/web still follow the existing use-installed-else-bundled policy.
  async computeArgs(runtime: PiRuntime, cwd: string): Promise<string[]> {
    const args = this.computeBridgeArgs();
    const cfg = vscode.workspace.getConfiguration("pi-for-vscode");
    if (cfg.get<"auto" | "always" | "never">("useBundledPi", "auto") === "never") return args;

    const wanted = BUNDLED_PI_PACKAGES.filter(
      (pkg) => cfg.get<boolean>(`bundle.${pkg.setting}`, true) && !this.isPackageRegistered(pkg.name, cwd),
    );
    if (wanted.length === 0) return args;

    try {
      if (runtime.source !== "bundled") await ensureBundledPi(this.context);
    } catch {
      return args;
    }

    const nodeModules = path.join(getBundleRoot(this.context), "node_modules");
    for (const pkg of wanted) {
      const file = path.join(nodeModules, pkg.name, pkg.entry);
      if (fs.existsSync(file)) args.push("-e", file);
    }
    return args;
  }

  private computeBridgeArgs(): string[] {
    const args: string[] = [];
    for (const relative of BRIDGE_RELATIVE_PATHS) {
      const file = vscode.Uri.joinPath(this.context.extensionUri, ...relative).fsPath;
      if (fs.existsSync(file)) args.push("-e", file);
    }
    return args;
  }

  // True when a package name appears in the user's pi `packages` list (global or
  // project), meaning their own install owns it and the bundled copy must not be
  // loaded on top.
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
        // Missing or unreadable settings: not registered here; keep checking.
      }
    }
    return false;
  }
}
