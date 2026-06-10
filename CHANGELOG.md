# Changelog

## Unreleased

- Show provider "Usage remaining" (Codex-style): a new usage bridge subscribes to pi's `after_provider_response` extension event and forwards rate-limit headers (Anthropic subscription 5h/weekly windows, API request/token limits, OpenAI x-ratelimit) into the stats popover — shown only when the provider sends them.
- Bottom status strip below the composer: the active-file reference chip on the left, and on the right the session tokens · cost with a circular context gauge ("61% left", warning tone past 80%). Hovering opens a detailed popover (context breakdown, input/output/cache split, estimated API cost, usage remaining).
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
