# Changelog

## Unreleased

- Bundle two validated pi extensions — **todos** (`@juicesharp/rpiv-todo`) and **web access** (`pi-web-access`) — and load them automatically unless you already have your own. Gated by `pi-for-vscode.bundle.todo` / `pi-for-vscode.bundle.web` (both on by default).
- Render a Claude-style tool timeline: Read/Write/Edit cards with a line-number gutter, a +/- sign column, and full-row add/remove bands; Edit cards upgrade to pi's real line-numbered unified diff once available. Plus Bash IN/OUT, a live todo checklist, web search/fetch results, per-generation token checkpoints, and an inline "Interrupted" marker.
- Bundle the pi agent so the extension works without a pre-installed `pi`. A known-good build ships inside each platform-specific `.vsix` and is extracted on first use (offline).
- Add `pi-for-vscode.useBundledPi` (`auto` | `always` | `never`) and the **Reinstall/Repair Bundled Pi Agent** command.
- Prefer a user's own `pi` (explicit `piPath` or one on `PATH`) over the bundled copy.
- Run the bundled agent under VS Code's Node runtime (or a system `node`) when it meets pi's engine floor.
- Add `scripts/build-pi-bundle.mjs` and `npm run package:all` for platform-specific packaging (macOS/Windows; Linux pending an upstream prebuild).

## 0.0.1

- Initial project scaffold.
