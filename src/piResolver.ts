import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

// Pinned, known-good version of @earendil-works/pi-coding-agent the extension is
// tested against. The in-vsix bundle (resources/pi-bundle.tar.gz) ships this exact
// version, and the managed install lands under globalStorage/pi/<PINNED>/.
export const PINNED_PI_VERSION = "0.80.3";

// Minimum Node.js the pi CLI requires (its package.json engines.node).
const MIN_NODE_VERSION = "22.19.0";

// Path of the bundled tarball inside the packaged extension.
const BUNDLE_TARBALL_REL = path.join("resources", "pi-bundle.tar.gz");

// Entry point of pi after the tarball is extracted. The tarball carries an
// `npm install --prefix`-shaped tree, so the agent lives under node_modules/.
const BUNDLE_PI_ENTRY_REL = path.join("node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");

export type PiLaunchKind = "executable" | "node-script";
export type PiSource = "configured" | "path" | "bundled";

export interface PiRuntime {
  /** Absolute path (or bare command name) to launch. */
  piEntry: string;
  /** "executable": spawn piEntry directly. "node-script": spawn nodePath with piEntry. */
  launchKind: PiLaunchKind;
  /** Node binary used when launchKind === "node-script". */
  nodePath?: string;
  /** When true the node binary is VS Code's Electron, so ELECTRON_RUN_AS_NODE must stay set. */
  runAsNode: boolean;
  /** Where the runtime came from (for diagnostics). */
  source: PiSource;
}

/** Raised when no usable pi could be located or installed. Message is user-facing. */
export class PiNotInstalledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiNotInstalledError";
  }
}

/** Raised when neither the host runtime nor a system node satisfies pi's engine floor. */
export class NodeTooOldError extends Error {
  constructor(public readonly current: string) {
    super(
      `The bundled Pi agent needs Node.js >= ${MIN_NODE_VERSION}, but the available runtime is ${current}. ` +
        `Update VS Code, install Node.js >= ${MIN_NODE_VERSION}, or install the pi CLI and set pi-for-vscode.piPath.`,
    );
    this.name = "NodeTooOldError";
  }
}

/**
 * Decide which pi to launch, honoring the user's own install first.
 * Precedence: explicit piPath path/command -> system PATH `pi` -> bundled pi.
 * Controlled by pi-for-vscode.useBundledPi ("auto" | "always" | "never").
 */
export async function resolvePiRuntime(context: vscode.ExtensionContext): Promise<PiRuntime> {
  const cfg = vscode.workspace.getConfiguration("pi-for-vscode");
  const useBundled = cfg.get<"auto" | "always" | "never">("useBundledPi", "auto");
  const inspected = cfg.inspect<string>("piPath");
  const explicitlySet = !!(inspected && (inspected.globalValue ?? inspected.workspaceValue ?? inspected.workspaceFolderValue));
  const piPathSetting = (cfg.get<string>("piPath", "pi") || "pi").trim();

  if (useBundled !== "always") {
    // An explicit path (absolute or containing a separator) is used verbatim.
    if (looksLikePath(piPathSetting)) {
      return { piEntry: piPathSetting, launchKind: "executable", runAsNode: false, source: "configured" };
    }
    // A bare command name (default "pi" included) is resolved against PATH.
    const found = findExecutableOnPath(piPathSetting || "pi");
    if (found) {
      return { piEntry: found, launchKind: "executable", runAsNode: false, source: explicitlySet ? "configured" : "path" };
    }
  }

  if (useBundled === "never") {
    throw new PiNotInstalledError(
      `Pi CLI '${piPathSetting}' was not found on PATH and pi-for-vscode.useBundledPi is "never". ` +
        `Install pi or set pi-for-vscode.piPath to its location.`,
    );
  }

  const entry = await ensureBundledPi(context);
  const node = await resolveNode();
  return { piEntry: entry, launchKind: "node-script", nodePath: node.nodePath, runAsNode: node.runAsNode, source: "bundled" };
}

/** Absolute root of the managed/bundled pi install for the pinned version. */
export function getBundleRoot(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, "pi", PINNED_PI_VERSION);
}

/**
 * Extract the in-vsix pi tarball into globalStorage on first use (offline).
 * Idempotent: returns immediately if a prior extraction left the .installed sentinel.
 */
export async function ensureBundledPi(context: vscode.ExtensionContext): Promise<string> {
  const root = getBundleRoot(context);
  const entry = path.join(root, BUNDLE_PI_ENTRY_REL);
  const sentinel = path.join(root, ".installed");

  if (fs.existsSync(sentinel) && fs.existsSync(entry)) return entry;

  const tarball = path.join(context.extensionUri.fsPath, BUNDLE_TARBALL_REL);
  if (!fs.existsSync(tarball)) {
    throw new PiNotInstalledError(
      `The bundled Pi agent is missing from this build (${tarball}). Install the pi CLI manually or set pi-for-vscode.piPath.`,
    );
  }

  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Pi: setting up the bundled agent…", cancellable: false },
    async () => {
      // Drop any partial/previous extraction before re-extracting.
      if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
      fs.mkdirSync(root, { recursive: true });

      await extractTarball(tarball, root);

      if (!fs.existsSync(entry)) {
        throw new PiNotInstalledError(`Bundled Pi extraction did not produce ${entry}.`);
      }
      fs.writeFileSync(sentinel, `${PINNED_PI_VERSION}\n`, "utf8");
      return entry;
    },
  );
}

/** Force a clean re-extraction of the bundled pi (used by the Repair command). */
export async function repairBundledPi(context: vscode.ExtensionContext): Promise<string> {
  const root = getBundleRoot(context);
  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  return ensureBundledPi(context);
}

/**
 * Pick the Node runtime for the bundled pi. Prefer VS Code's own Electron-as-node
 * (no extra binary to ship) when it meets pi's engine floor; otherwise fall back to
 * a system node on PATH; otherwise fail with an actionable error.
 */
async function resolveNode(): Promise<{ nodePath: string; runAsNode: boolean }> {
  if (versionGte(process.versions.node, MIN_NODE_VERSION)) {
    return { nodePath: process.execPath, runAsNode: true };
  }
  const systemNode = findExecutableOnPath("node");
  if (systemNode) {
    const version = await getNodeVersion(systemNode);
    if (version && versionGte(version, MIN_NODE_VERSION)) {
      return { nodePath: systemNode, runAsNode: false };
    }
  }
  throw new NodeTooOldError(process.versions.node);
}

function extractTarball(tarball: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // `tar` is available on macOS and on Windows 10 1803+ (bsdtar) and handles gzip.
    execFile("tar", ["-xzf", tarball, "-C", dest], (error) => (error ? reject(error) : resolve()));
  });
}

// One `--version` probe per pi entry per window (the promise is cached, so concurrent
// runtimes share a single child process). The bundled pi skips the probe entirely.
const piVersionCache = new Map<string, Promise<string | undefined>>();

/** Detect the version of a non-bundled pi via `pi --version`; undefined on any failure. */
export function detectPiVersion(runtime: PiRuntime): Promise<string | undefined> {
  if (runtime.source === "bundled") return Promise.resolve(PINNED_PI_VERSION);
  const cached = piVersionCache.get(runtime.piEntry);
  if (cached) return cached;
  const command = runtime.launchKind === "node-script" ? runtime.nodePath ?? "node" : runtime.piEntry;
  const args = runtime.launchKind === "node-script" ? [runtime.piEntry, "--version"] : ["--version"];
  const env = runtime.runAsNode ? { ...process.env, ELECTRON_RUN_AS_NODE: "1" } : process.env;
  const probe = new Promise<string | undefined>((resolve) => {
    execFile(command, args, { timeout: 5000, env }, (error, stdout) => {
      if (error) {
        resolve(undefined);
        return;
      }
      const match = /\d+\.\d+\.\d+/.exec(String(stdout));
      resolve(match ? match[0] : undefined);
    });
  });
  piVersionCache.set(runtime.piEntry, probe);
  return probe;
}

function getNodeVersion(nodePath: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(nodePath, ["--version"], { timeout: 5000 }, (error, stdout) => {
      if (error) {
        resolve(undefined);
        return;
      }
      resolve(stdout.trim().replace(/^v/, ""));
    });
  });
}

function looksLikePath(value: string): boolean {
  return value.includes("/") || value.includes("\\") || path.isAbsolute(value);
}

function findExecutableOnPath(command: string): string | undefined {
  const envPath = process.env.PATH ?? process.env.Path ?? "";
  const dirs = envPath.split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").map((e) => e.trim()).filter(Boolean)
      : [""];

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Not in this directory; keep looking.
      }
    }
  }
  return undefined;
}

function versionGte(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}
