# Changelog

## Unreleased

- Chrome-style session tabs in the top bar: one tab per OPEN session, click to switch instantly, × to close (the saved session stays reopenable from history), running sessions show a pulse dot, and double-click renames inline. Past sessions stay in the clock popover.
- Replace "Generated N tokens" timeline rows with a live turn-total counter in the status header that rolls up slot-machine style as each model call's usage lands; the finished turn keeps the exact total in its header chip.
- Codex-style "+N −N" added/removed line badges on Edit/Write rows, counting pi's real diff once enriched (args-based estimate until then) and rolling to the new value on change.
- Diff colors now follow the editor theme's git/diff palette (added = VS Code green, removed = VS Code red) across the new badges, diff signs, and full-row add/remove bands.
- Looser timeline rhythm: more breathing room between step rows, cards, and narration (Claude Code-style density).
- Fix: a collapsed "Thought for Xs" row no longer leaks the first reasoning line into the step — thoughts appear only when the row is clicked open.
- Redesign the composer footer in a Claude Code-style layout: active-file references now sit in the action row after the `+` button, the context gauge shows the remaining percent in the center, and Codex OAuth usage appears as always-visible 5h/1w bars above the composer.
- Simplify the session stats strip below the composer: it keeps the tokens · cost summary and circular context gauge, while the hover popover now focuses only on context usage.
- Redesigned Settings panel: header with close button, card sections with icons, per-provider rows with credential glyphs, destructive hover for sign-out, full-width sign-in button.

- Interleave assistant narration chronologically in the activity timeline (Claude Code-style flow): intermediate text now lands between the tool steps it precedes, and the final answer stays in the bubble. This also fixes intermediate narration being overwritten on multi-call turns.
- Show EVERY timeline step — the 16-step cap is gone. A keyed row reconciler updates only changed rows, so long turns stay smooth and hover/animations survive streaming.
- Restore sessions with full fidelity: reopened sessions now rebuild tool steps (with outputs and diffs), narration, thinking blocks, and per-turn usage — structurally identical to the live view.
- Per-tool visual identity: icons and color tones for read/bash/edit/write/grep/find/ls/todo/web tools, with row-entry and completion animations (reduced-motion aware).
- Real-time chat feel: mid-run sends render instantly as dimmed "Queued" bubbles that resolve in order; shorter send debounce windows.
- Model picker now shows per-model pricing ($/Mtok in/out), context window, and vision/thinking badges — all reported by pi's model registry (no hardcoded prices).
- New thinking-level chip ("Thinking: high") with a popover describing every level; unsupported levels are shown disabled. Note: `xhigh` is now offered only when the model explicitly supports it (pi previously clamped it silently).
- Session usage strip above the composer: cumulative tokens · cost and a context-usage bar ("N% left"), refreshed from pi's session stats after each run and on compaction.
- Sign-in is now separated from the workspace: a full-screen onboarding screen appears when no provider is authenticated (subscription/OAuth or API key), and the chat unlocks once login completes — including logins done in a terminal pi.
- New Settings panel (gear button): per-provider account status with sign-out, sign-in entry point, and extension/pi version info. Auth actions moved out of the model picker.

- Bundle two validated pi extensions — **todos** (`@juicesharp/rpiv-todo`) and **web access** (`pi-web-access`) — and load them automatically unless you already have your own. Gated by `pi-for-vscode.bundle.todo` / `pi-for-vscode.bundle.web` (both on by default).
- Render a Claude-style tool timeline: Read/Write/Edit cards with a line-number gutter, a +/- sign column, and full-row add/remove bands; Edit cards upgrade to pi's real line-numbered unified diff once available. Plus Bash IN/OUT, a live todo checklist, web search/fetch results, per-generation token checkpoints, and an inline "Interrupted" marker.
- Bundle the pi agent so the extension works without a pre-installed `pi`. A known-good build ships inside each platform-specific `.vsix` and is extracted on first use (offline).
- Add `pi-for-vscode.useBundledPi` (`auto` | `always` | `never`) and the **Reinstall/Repair Bundled Pi Agent** command.
- Prefer a user's own `pi` (explicit `piPath` or one on `PATH`) over the bundled copy.
- Run the bundled agent under VS Code's Node runtime (or a system `node`) when it meets pi's engine floor.
- Add `scripts/build-pi-bundle.mjs` and `npm run package:all` for platform-specific packaging (macOS/Windows; Linux pending an upstream prebuild).

## 0.0.1

- Initial project scaffold.
