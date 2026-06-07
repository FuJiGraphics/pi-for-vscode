# Pi for VS Code — Agent Notes

이 파일은 이후 에이전트 세션(Pi / Codex / Cursor 등)이 이 프로젝트의 의도와 규칙을 잊지 않도록
남겨두는 작업 메모입니다. 특정 AI에 종속되지 않는 공용 지침입니다.

## 프로젝트 정체성

pi-for-vscode는 "Pi Coding Agent"용 **네이티브 VS Code webview 클라이언트**입니다. 분리형
백그라운드 broker가 `pi --mode rpc`를 stdio로 띄우고, VS Code webview는 그 broker와 로컬 소켓으로
통신합니다. VS Code 통합 터미널은 필요하지 않습니다.

이 확장은 **얇은 UI 래퍼**입니다. 에이전트 지능(툴 실행, 추론, 세션)은 외부 `pi` 바이너리에
있으며 이 repo에 있지 않습니다. 이 repo가 하는 일은 프롬프트를 Pi에 전달하고 Pi의 RPC 이벤트를
화면에 렌더링하는 것뿐입니다.

> 자매 프로젝트 NAssistant와 달리, pi-for-vscode는 **의도적으로 단일 에이전트(Pi) 전용 채팅
> UI**입니다. NAssistant의 "AI 비종속 · 채팅 UI 없음" 원칙은 여기에 적용되지 않습니다.

## 기술 스택

- VS Code extension
- TypeScript
- npm
- `@types/vscode ^1.94` (engines.vscode `^1.94.0`)
- 빌드는 `tsc`로 직접 컴파일한다. **번들러 없음**.
- 패키징은 `@vscode/vsce`로 한다.
- Pi는 서브프로세스(`pi --mode rpc`)로 실행한다. 경로는 설정 `pi-for-vscode.piPath`.

## 아키텍처 한눈에

| 파일 | 책임 |
| --- | --- |
| [src/extension.ts](src/extension.ts) | `activate()`에서 webview view provider + 커맨드 4개 등록, provider 메서드에 위임 |
| [src/chatViewProvider.ts](src/chatViewProvider.ts) | webview provider, HTML/CSS 인라인 생성, 메시지 라우팅, Pi RPC 이벤트 → webview 포워딩 |
| [src/piBroker.ts](src/piBroker.ts) | 분리형 broker 수명주기, `pi --mode rpc` 스폰, idle timeout |
| [src/piRpcClient.ts](src/piRpcClient.ts) | line-delimited JSON-RPC 클라이언트 (`send` / `request`) |
| [src/sessionStore.ts](src/sessionStore.ts) | Pi 세션 읽기 (`~/.pi/agent/sessions/*.jsonl`) |

메시지 프로토콜은 두 층이다:

1. **webview ↔ host** — `WebviewToExtensionMessage` / `ExtensionToWebviewMessage` 타입 유니온.
2. **host ↔ pi** — `PiRpcClient`를 통한 line-delimited JSON-RPC.

## 반드시 지킬 방향

- 표면적을 작게 유지한다. chat view 외에 무거운 UI를 만들지 않는다.
- Pi의 로직(에이전트 추론·툴 실행)을 확장 안에 재구현하지 않는다. 확장은 전달과 렌더링만 한다.
- Pi의 설정·스킬·시스템 프롬프트는 `pi` 바이너리 또는 `pi-for-vscode.extraArgs` 소관이다. 확장
  코드에 하드코딩하지 않는다.
- Pi 자체 세션 저장소(`~/.pi/agent/sessions/*.jsonl`)와의 호환을 유지한다. 세션 포맷을 바꾸지 않는다.
- 커맨드는 실제 사용자 기능이 있을 때만 추가한다.
- **거대 클래스 금지 — 책임 분리.** 한 클래스·파일은 "바뀔 이유" 하나만 갖는다. 이름을 `and` 없이/
  모호한 `Manager·Helper·Util` 없이 못 짓거나, 무관한 기능 변경이 같은 파일에 자꾸 떨어지거나, 한
  부분만 테스트하려는데 무관한 셋업이 필요하면 — 떼어낼 신호다. 새 책임은 볼트로 붙이지 말고 제
  단위로(webview 표현(`WebviewPresenter`) ↔ 런타임 수명주기(`SessionRuntimeManager`) ↔ RPC 이벤트
  (`RpcEventRouter`) ↔ 모델/BYOK(`ModelService`/`ModelSecretsStore`) ↔ 세션 CRUD(`SessionCrudService`)
  는 서로 다른 단위). 단 소비자 없는 투기적 계층은 금지(확장성 적정선). `scripts/lint-size.mjs`가
  `src/*.ts` 400줄을 강제한다(응집된 대형 모듈만 grandfather). god file 신호는
  [docs/grounded-implementation.md](docs/grounded-implementation.md) 3단계.

## 피해야 할 방향

- Pi RPC 프로토콜이나 세션 포맷을 확장 쪽에서 임의로 변형하기.
- Pi가 해야 할 일을 확장에서 가로채 직접 처리하기.
- 설정이 많거나 설명이 무거운 화면부터 만들기.
- 외부 리소스를 로드하는 webview(아래 CSP 규칙 위반).

## 패키징 경계 — 무엇이 "사용자 Pi 프롬프트"에 실리나

이 확장은 얇은 래퍼다. broker는 **사용자 워크스페이스를 cwd로** `pi --mode rpc`를 띄운다
([src/piBroker.ts](src/piBroker.ts)의 argv: `--mode rpc` + (`--no-session`) + (`--model`) +
`extraArgs`). 그래서 Pi가 기본 자동탐색하는 스킬·`AGENTS.md`·`CLAUDE.md`는 **사용자 프로젝트의
것**이지 이 repo의 것이 아니다(`pi`의 `--no-skills` / `--no-context-files`로 끌 수 있음). 이 repo의
dev 지침은 사용자 cwd에 없으니 사용자 Pi 프롬프트에 절대 들어가지 않는다.

**경계는 단 하나다: 무언가를 사용자 Pi에 실으려면 broker argv에 명시적으로 `--skill <path>` /
`-e <path>`(확장) / `--append-system-prompt`를 추가해야 한다.** 패키지(VSIX)에 들어있다는 사실만으로는
절대 프롬프트에 실리지 않는다. 그러니 위치로 의도를 가른다:

- **dev 전용 (절대 ship 안 함, 프롬프트 무관):** `.claude/`(Claude Code 스킬), `AGENTS.md`,
  `CLAUDE.md`, `docs/`. → [.vscodeignore](.vscodeignore)에서 제외. broker가 절대 `--skill` 하지 않음.
- **번들 Pi 확장(검증된 것만):** `pi-bundle.tar.gz`에 동봉한 npm pi 확장(현재 `@juicesharp/rpiv-todo`
  = todo 툴, `pi-web-access` = web search/fetch). [scripts/build-pi-bundle.mjs](scripts/build-pi-bundle.mjs)의
  `BUNDLED_PACKAGES`로 설치하고, [src/chatViewProvider.ts](src/chatViewProvider.ts)의 `BUNDLED_PI_PACKAGES`/
  `computeBundledExtensionArgs`가 `-e <node_modules>/<pkg>/index.ts`로 **명시 로드**한다. 정책은
  **use-installed-else-bundled**: 사용자가 자기 pi에 같은 패키지를 이미 등록(`settings.json`의 `packages`)
  했으면 그걸 쓰고 동봉본은 안 싣는다. 패키지별 설정 `pi-for-vscode.bundle.todo`/`.web`(기본 true)로
  off하면 프롬프트에 0 영향. 시스템 프롬프트 증가분은 두 패키지 합쳐 **약 2K 토큰**(툴 정의+가이드라인,
  세션당 1회·캐시됨) — 무시 가능한 수준으로 측정돼 의도적으로 기본 ON.
- **사용자에게 제공할 Pi 스킬/프롬프트템플릿:** `resources/pi-skills/`(권장 경로)에 번들 → VSIX에
  포함 → broker가 그 절대경로를 `--skill`로 **명시 전달**. 이 경로의 것만 사용자 Pi에 실린다.
- **그 외 런타임 자산:** `resources/`(pi 번들), `out/`, `media/`는 그대로 ship.

새 확장·스킬·지침을 만들 때 "Claude/dev 작업 도우미냐, 사용자에게 줄 Pi 기능이냐"로 위치를 먼저 가른다.
새 번들 확장을 더할 땐 (1) 검증·반응이 좋은 것만, (2) 토큰 증가분을 측정해 통제 가능한지 확인하고,
(3) 패키지별 토글을 함께 둔다. 한편 실제 ship할 Pi **스킬**이 생기기 전에는 `resources/pi-skills/`와
`--skill` 배선을 미리 만들지 않는다(불필요한 추정 인프라 금지 —
[docs/grounded-implementation.md](docs/grounded-implementation.md) 4단계).

### 사용자가 따로 설치한 Pi 확장과의 호환 (예: `pi0.pi-vscode` 마켓플레이스)

별도의 Pi UI(`pi0.pi-vscode` "Pi Coding Agent"의 "Packages" 뷰, 또는 `pi package add`)로 설치한
extension/skill/prompt/MCP는 **우리가 아무것도 안 해도** 우리 확장에 반영된다. broker가 사용자 pi를
워크스페이스 cwd + 공유 `~/.pi/agent`로 띄우고 `--no-skills`/`--no-context-files`를 안 붙이기 때문이다
(pi의 `getAgentDir()`는 바이너리 위치 무관하게 `~/.pi/agent` — 번들 pi든 시스템 pi든 같은 곳에서 해석).
두 확장은 서로 통신하지 않고 같은 `pi`·`~/.pi/agent`만 공유한다. **이 경계를 깨지 말 것**: 우리 쪽에서
패키지를 가로채 관리하거나 마켓플레이스 UI를 복제하지 않는다(표면적 최소 원칙).

다만 pi는 패키지를 **spawn 시점에** 로드하고, webview 명령 캐시(`commandMenu.ts`의 `loaded`)는 활성
세션이 바뀔 때만 무효화된다(`main.ts`의 `activate` → `invalidateCommands()`). 그래서 세션 도중 새로 설치한
패키지의 슬래시 명령은 **새 세션**(= 새 pi 런타임)에서 보이는 게 정상이다. 이 동작을 바꾸려 pi 프로세스를
임의 재시작하지 말 것.

## 커밋 규칙

- 이 프로젝트의 커밋 작성자 계정은 항상 `fujigraphics <fujigraphics@users.noreply.github.com>`를
  사용한다(영구 git config로 박지 않는다).
- 커밋 타입은 `feat`, `fix`, `refactor`, `chore`(필요 시 `docs`)를 사용한다.
  - `feat`: 기능 추가/설명
  - `fix`: 버그 수정
  - `refactor`: 기존 구조 개선/변경
  - `chore`: 코드 변경 없는 작업
- 커밋 설명은 간결하게 1~5줄의 나열 방식으로 작성한다.
- **커밋 메시지에 AI/에이전트를 작성 주체로 언급하지 않는다**(co-author, "generated with" 푸터 포함 금지).

## 문서 언어 규칙

- 외부 노출 문서의 기본 언어는 **영어**다. 대상: `README.md`, `CHANGELOG.md`, `package.json`의
  `description`/`displayName`/`keywords`, 확장 UI 문자열.
- 한글 항목과 영문 항목을 한 문서 안에서 섞지 않는다. 기존 항목이 한글이어도 새 항목은 영어로 쓰고,
  가능하면 기존 항목도 영어로 다시 쓴다.
- 내부용 문서(`AGENTS.md`, `docs/*.md`, 코드 주석의 짧은 메모)는 한국어 톤을 유지해도 된다.

## 릴리스 / 마켓플레이스 배포

- 로컬 vsix는 `npm run package`(= `vsce package`)로 만든다.
- 마켓플레이스 게시 전체 절차는 [docs/marketplace-publish.md](docs/marketplace-publish.md)를 따른다.
- 게시 토큰은 macOS 키체인 `vsce-fujigraphics` 항목 또는 `VSCE_PAT` 환경변수를 쓴다(NAssistant와 동일).
- 마켓플레이스 itemName: `fujigraphics.pi-for-vscode`.

## 추가 가이드

- 구현 규율(짓기 전 코드베이스 살피기·기존 코드 재사용·올바른 배치·확장성 적정선): [docs/grounded-implementation.md](docs/grounded-implementation.md)
- 확장 작성 규율(커맨드·webview 메시지·RPC·CSP·빌드): [docs/vscode-extension.md](docs/vscode-extension.md)
- 마켓플레이스 배포 절차(수동 vsce 흐름): [docs/marketplace-publish.md](docs/marketplace-publish.md)
