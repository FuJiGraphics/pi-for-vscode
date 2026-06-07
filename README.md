# Pi for VS Code

Use Pi Coding Agent through a native VS Code webview interface.

Pi for VS Code is an independent interface for Pi Coding Agent. It starts a detached background broker, the broker runs `pi --mode rpc` over stdio, and the VS Code webview talks to that broker over a local socket. No VS Code integrated terminal is required.

## The pi agent

You do **not** need to install `pi` yourself — a known-good pi build is bundled with the extension. Resolution order:

1. `pi-for-vscode.piPath`, if you set it to an explicit path.
2. A `pi` found on your `PATH` (your own, possibly customized install — preferred when present).
3. The **bundled** agent, extracted into the extension's storage on first use (works offline).

This is controlled by `pi-for-vscode.useBundledPi` (`auto` | `always` | `never`). Run **Pi for VS Code: Reinstall/Repair Bundled Pi Agent** if the bundled copy gets damaged.

The bundled agent runs under VS Code's own Node runtime when it satisfies pi's engine floor (Node ≥ 22.19); otherwise a system `node` is used. macOS and Windows are supported today (Linux is pending an upstream prebuild).

## Bundled tools

Two validated pi extensions ship with the agent so common capabilities work out of the box:

- **Todos** (`@juicesharp/rpiv-todo`) — lets Pi plan and track multi-step work; the chat renders it as a live checklist.
- **Web access** (`pi-web-access`) — web search, code search, and URL/content fetch.

These follow a **use-installed-else-bundled** policy: if you have already registered the same package in your own pi (`~/.pi/agent/settings.json`), your copy is used and the bundled one is skipped. Each is gated by a setting (`pi-for-vscode.bundle.todo` / `pi-for-vscode.bundle.web`, both on by default); turn one off to keep it out of the system prompt entirely.

## Status

Early scaffold / MVP.

## Development

```bash
npm install
npm run compile
```

Then press `F5` in VS Code and run **Pi for VS Code: Open**.

Use **Pi for VS Code: Sessions** or the Sessions button in the Pi view to resume an existing Pi session.

### Packaging

The platform-specific `.vsix` files (each carrying that platform's pi bundle) are built with:

```bash
npm run package:all     # builds dist/pi-for-vscode-<target>.vsix for each target
# or for one target:
npm run build:pi-bundle -- --target darwin-arm64 && npx vsce package --target darwin-arm64
```

The pi bundle (`resources/pi-bundle.tar.gz`) is a generated artifact and is not committed.

## Settings

- `pi-for-vscode.piPath`: Path to the `pi` CLI executable. Leave as `pi` to auto-detect on `PATH`.
- `pi-for-vscode.useBundledPi`: When to use the bundled agent (`auto` | `always` | `never`).
- `pi-for-vscode.extraArgs`: Extra CLI arguments passed to `pi --mode rpc`.
- `pi-for-vscode.persistSessions`: Use Pi's normal session storage. Disable to pass `--no-session`.
- `pi-for-vscode.defaultStreamingBehavior`: Queue mode for prompts sent while Pi is running.
- `pi-for-vscode.brokerIdleTimeoutMinutes`: How long the detached Pi broker stays alive after VS Code disconnects.
- `pi-for-vscode.bundle.todo`: Load the bundled todo extension (skipped if you already have your own).
- `pi-for-vscode.bundle.web`: Load the bundled web-access extension (skipped if you already have your own).
