# pi-for-vscode 확장 작성 규율

이 문서는 pi-for-vscode(VS Code 확장)를 일관되게 유지하기 위한 작성 규율이다. 어떤 에이전트가
읽어도 따를 수 있도록 특정 AI에 종속되지 않은 형태로 쓴다. 프로젝트 전반의 정체성·규칙은
[../AGENTS.md](../AGENTS.md)를 단일 진실 출처로 삼는다.

## 1. 파일 레이아웃

새 코드를 어디에 둘지:

- [../src/extension.ts](../src/extension.ts) — `activate()`만. webview view provider 등록 +
  커맨드 등록 + 시작 시 자동 오픈. 커맨드 본문은 여기 쓰지 않고 provider 메서드에 위임한다.
- [../src/chatViewProvider.ts](../src/chatViewProvider.ts) — `PiChatViewProvider`. webview HTML/CSS
  생성, webview↔host 메시지 라우팅(`handleWebviewMessage`), Pi RPC 이벤트 → webview 포워딩,
  세션 UI(QuickPick). 가장 큰 파일이며 대부분의 UI 변경이 여기서 일어난다.
- [../src/piBroker.ts](../src/piBroker.ts) — 분리형 broker, `pi --mode rpc` 스폰, idle timeout.
- [../src/piRpcClient.ts](../src/piRpcClient.ts) — line-delimited JSON-RPC 클라이언트.
- [../src/sessionStore.ts](../src/sessionStore.ts) — `~/.pi/agent/sessions/*.jsonl` 파싱.

## 2. 새 커맨드 추가 = 한 커밋에 동시 갱신

커맨드 하나를 추가할 때 다음을 **모두 같은 커밋에서** 갱신한다. 하나라도 빠지면 동작하지 않거나
컴파일 에러가 난다.

1. **[../src/extension.ts](../src/extension.ts)** — `vscode.commands.registerCommand("pi-for-vscode.X", () => provider.X())`를 `context.subscriptions.push(...)`에 추가.
2. **`PiChatViewProvider`** — 위임받을 `X()` 메서드 구현.
3. **[../package.json](../package.json) `activationEvents`** — `"onCommand:pi-for-vscode.X"` 추가.
4. **[../package.json](../package.json) `contributes.commands`** — `{ "command": "pi-for-vscode.X", "title": "Pi for VS Code: <Action>", "icon": "$(...)" }`. title 접두사는 `Pi for VS Code:`로 통일.
5. **(메뉴 노출 필요 시) [../package.json](../package.json) `contributes.menus`** — `view/title`(현재 패턴: `"when": "view == pi-for-vscode.chat"`, `"group": "navigation"`) 또는 `editor/title`에 추가.

> 커맨드 ID는 현재 별도 constants 파일 없이 `extension.ts`와 `package.json`에 인라인 문자열
> 리터럴로 존재한다. `pi-for-vscode.` 접두사를 항상 일관되게 유지한다. (커맨드가 더 늘어 관리가
> 어려워지면 그때 상수화를 검토.)

현재 커맨드: `pi-for-vscode.open`, `pi-for-vscode.newSession`, `pi-for-vscode.sessions`,
`pi-for-vscode.stop`.

## 3. Webview 메시지 추가 = 한 커밋에 동시 갱신

메시지 프로토콜은 두 방향의 타입 유니온으로 정의된다(`chatViewProvider.ts` 하단):

- `WebviewToExtensionMessage` — webview → host (예: `ready`, `prompt`, `abort`, `newSession`,
  `sessions`, `requestSessions`, `switchSession`, `getState`, `copy`, `extensionUiResponse`)
- `ExtensionToWebviewMessage` — host → webview (예: `rpcEvent`, `extensionUiRequest`, `system`,
  `stderr`, `running`, `reset`, `state`, `sessionMessages`, `sessionList`)

새 메시지 한 종류를 추가할 때 **같은 커밋에서**:

1. 해당 방향의 유니온 타입에 `{ type: "..."; ... }` 변형을 추가.
2. host 측: webview→host 메시지면 `handleWebviewMessage`의 `switch (message.type)`에 `case` 추가.
3. webview 측: host→webview 메시지면 webview 스크립트의 `message.type` 디스패치에 분기 추가.
   webview→host 액션이면 UI 핸들러에서 `vscode.postMessage({ type: "...", ... })` 호출 추가.

**메시지 흐름은 단방향이다:**

- webview → host: `vscode.postMessage({ type, ... })`
- host → webview: `this.view?.webview.postMessage(message)`

webview는 로컬 UI 상태만 들고, 진실은 host(설정 + Pi 세션)에 있다.

> 현재 host는 들어온 메시지를 `message as WebviewToExtensionMessage`로 캐스팅할 뿐 런타임 타입
> validator(`is...Message` 같은 것)는 없다. 메시지 종류가 늘어 신뢰성이 중요해지면 런타임
> validator를 추가하는 것이 좋은 하드닝이다(현재는 없음 — 있는 것처럼 쓰지 말 것).

## 4. Pi RPC 레이어 (host ↔ pi)

- `PiRpcClient.send(command)` — fire-and-forget. 응답을 기다리지 않는다.
- `PiRpcClient.request(command, timeoutMs = 30_000)` — `id` 기반 요청/응답. Promise 반환.
- broker는 transport/control 명령(`ping`, `broker_shutdown`)만 직접 처리한다. Pi 명령(`set_model`,
  `get_available_models`, extension command prompt 등)은 Pi stdin으로 그대로 통과시킨다.
- 모델 목록/전환은 Pi 공식 RPC를 따른다: `get_available_models`, `set_model { provider, modelId }`.
- provider 인증은 VS Code SecretStorage/env 주입이 아니라 Pi `authStorage`와 bundled auth bridge(`/login`,
  `/logout`)를 통해 처리한다.
- 와이어 포맷: broker 소켓 위 **line-delimited JSON**(한 줄당 JSON 한 개).
- Pi가 올려보내는 이벤트는 host가 받아 webview에 `{ type: "rpcEvent", event }`로 포워딩한다.
  주요 이벤트: `agent_start`, `agent_end`, `message_update`, `message_end`,
  `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `queue_update`,
  `compaction_start`, `compaction_end`, `extension_ui_request`, `extension_error`.
- broker 수명주기: 분리형으로 떠 있고 `pi-for-vscode.brokerIdleTimeoutMinutes` 후 idle 종료.
  `pi --mode rpc`로 스폰하며 `pi-for-vscode.persistSessions`가 false면 `--no-session`을 붙인다.
  추가 인자는 `pi-for-vscode.extraArgs`로 전달.

## 5. HTML / CSS / CSP

- webview HTML/CSS는 `chatViewProvider.ts`에서 **인라인 생성**한다. 외부 `.css` 파일을 두지 않는다.
- **CSP는 이미 적용되어 있다**: 렌더마다 `getNonce()`로 nonce를 생성하고
  `Content-Security-Policy` 메타(`default-src 'none'; ... script-src 'nonce-${nonce}';`)와
  `<script nonce="${nonce}">`를 쓴다. 인라인 스크립트는 반드시 이 nonce를 단다. 외부 리소스
  로드(원격 URL, CDN)는 금지.
- 색은 VS Code 테마 변수(`var(--vscode-...)`)를 쓴다. 하드코딩 hex는 꼭 필요한 경우로 한정.

## 6. 빌드 / 실행

- `npm run compile` → `tsc -p ./` → `out/extension.js`
- `npm run watch` → 개발 중 자동 컴파일
- `npm run lint` → `tsc -p ./ --noEmit` (타입 체크만)
- `F5` → Extension Development Host에서 실행 → **Pi for VS Code: Open**
- `npm run package` → `.vsix` 생성 (`vsce package`)
- `vscode:prepublish`는 `compile`만 호출한다.

## 7. 범위 밖

- 언어 문법(tmLanguage)·시맨틱 토큰, LSP 클라이언트/서버, 디버그 어댑터, 태스크 provider
- 번들러(webpack/esbuild), 테스트 프레임워크 셋업
- `pi` 바이너리 자체의 로직·설정·스킬(이 repo가 아니라 Pi 쪽 소관)
- 마켓플레이스 게시 절차 → [marketplace-publish.md](marketplace-publish.md) 참고
