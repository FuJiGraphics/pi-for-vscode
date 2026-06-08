import * as vscode from "vscode";

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

const CLOCK_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';

const NEW_CHAT_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><line x1="12" y1="7" x2="12" y2="13"/><line x1="9" y1="10" x2="15" y2="10"/></svg>';

export function getChatHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = getNonce();
  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "chat", "chat.css"));
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "chat", "main.js"));

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' 'strict-dynamic';" />
  <link rel="stylesheet" href="${cssUri}" />
  <title>Pi for VS Code</title>
</head>
<body>
  <div class="app">
    <header class="topbar">
      <div class="title-row">
        <div id="title" class="title">Pi</div>
      </div>
      <div class="top-actions">
        <button id="history" class="icon-button" title="Session history" aria-label="Session history">${CLOCK_ICON}</button>
        <button id="newSession" class="icon-button" title="New session" aria-label="New session">${NEW_CHAT_ICON}</button>
        <button class="icon-button" title="Settings" aria-label="Settings">⚙</button>
      </div>
    </header>
    <div id="connection-banner" class="connection-banner" role="status" aria-live="polite" hidden></div>
    <main id="messages" tabindex="0"></main>
    <button id="jumpLatest" class="jump-latest" hidden aria-label="Jump to latest">↓ Jump to latest</button>
    <section id="history-panel" class="history-panel" aria-label="Session history">
      <input id="history-search" class="history-search" type="text" placeholder="Search sessions…" aria-label="Search sessions" />
      <div id="history-list" class="history-list"></div>
    </section>
    <section id="model-panel" class="model-panel" aria-label="Model picker">
      <input id="model-search" class="model-search" type="text" placeholder="Search models…" aria-label="Search models" />
      <div id="model-list" class="model-list"></div>
    </section>
    <section id="command-panel" class="command-panel" aria-label="Slash commands">
      <div id="command-list" class="command-list" role="listbox"></div>
    </section>
    <footer class="composer-wrap">
      <div id="composer" class="composer">
        <div id="attachmentTray" class="attachment-tray" hidden></div>
        <textarea id="input" placeholder="Ask Pi to work in this project"></textarea>
        <input id="imageInput" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden />
        <div class="composer-actions">
          <button id="attachImage" class="ghost-button" title="Attach image" aria-label="Attach image">＋</button>
          <button class="pill-button" title="Approval mode" aria-label="Approval mode">✋ <span class="optional">Ask for approval</span>⌄</button>
          <button id="stop" class="stop-button" disabled hidden>Stop</button>
          <span class="spacer"></span>
          <div id="thinkingControl" class="thinking-control" hidden aria-label="Thinking level"></div>
          <button id="model" class="model-button" title="Model" aria-label="Model">Pi⌄</button>
          <button id="send" class="send-button empty" title="Send" aria-label="Send">↑</button>
        </div>
      </div>
    </footer>
  </div>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
