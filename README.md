# Pi for VS Code

Use Pi Coding Agent through a native VS Code webview interface.

Pi for VS Code is an independent interface for Pi Coding Agent. It runs `pi --mode rpc` in the extension host and renders a sidebar chat UI inside VS Code.

## Status

Early scaffold / MVP.

## Development

```bash
npm install
npm run compile
```

Then press `F5` in VS Code and run **Pi for VS Code: Open**.

## Settings

- `pi-for-vscode.piPath`: Path to the `pi` CLI executable.
- `pi-for-vscode.extraArgs`: Extra CLI arguments passed to `pi --mode rpc`.
- `pi-for-vscode.persistSessions`: Use Pi's normal session storage. Disable to pass `--no-session`.
- `pi-for-vscode.defaultStreamingBehavior`: Queue mode for prompts sent while Pi is running.
