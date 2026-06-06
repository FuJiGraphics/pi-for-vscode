# Changelog

## Unreleased

- Bundle the pi agent so the extension works without a pre-installed `pi`. A known-good build ships inside each platform-specific `.vsix` and is extracted on first use (offline).
- Add `pi-for-vscode.useBundledPi` (`auto` | `always` | `never`) and the **Reinstall/Repair Bundled Pi Agent** command.
- Prefer a user's own `pi` (explicit `piPath` or one on `PATH`) over the bundled copy.
- Run the bundled agent under VS Code's Node runtime (or a system `node`) when it meets pi's engine floor.
- Add `scripts/build-pi-bundle.mjs` and `npm run package:all` for platform-specific packaging (macOS/Windows; Linux pending an upstream prebuild).

## 0.0.1

- Initial project scaffold.
