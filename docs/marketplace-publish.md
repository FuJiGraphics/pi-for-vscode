# pi-for-vscode 마켓플레이스 배포 (수동 vsce 흐름)

이 문서는 pi-for-vscode를 VS Code Marketplace에 게시하는 절차다. 어떤 에이전트가 읽어도 따를 수
있게 쓴다. 프로젝트 규칙(커밋 작성자·문서 언어)은 [../AGENTS.md](../AGENTS.md)를 따른다.

> NAssistant에는 게시 전 과정을 자동화하는 `scripts/release.mjs`(`npm run release`) 엔진이 있지만,
> **pi-for-vscode에는 그 엔진이 없다**. 여기서는 `@vscode/vsce`를 직접 쓰는 수동 흐름을 따르며,
> "게시 성공 후에만 commit/tag/push"라는 안전 순서를 사람이 직접 지킨다.

## 0. 컨텍스트 확인

- [../package.json](../package.json)의 `publisher` = `fujigraphics`, `name` = `pi-for-vscode` 인지 확인.
- 다른 repo면 중단한다.

## 1. 사전 점검 (셋 다 충족해야 진행, 아니면 멈추고 먼저 해결)

- **워킹트리**: `git status --porcelain`
  - OK: `package.json`/`CHANGELOG.md`만 변경된 상태(게시 과정에서 손대는 파일).
  - Not OK: 그 외 파일이 변경/추가됨 → 목록을 보여주고 사용자에게 확인(먼저 커밋 권유). 의도치 않은
    작업을 함께 게시하지 않는다.
- **브랜치**: `git rev-parse --abbrev-ref HEAD`로 `main` 확인. 아니면 이 브랜치에서 배포할지 사용자에게 질문.
- **게시 토큰** (게시 시도 없이 도달 가능 여부만 미리 확인):
  ```
  security find-generic-password -s vsce-fujigraphics -a fujigraphics -w
  ```
  - 토큰 출력 → OK.
  - 실패 → `VSCE_PAT` 환경변수 확인.
  - 둘 다 없으면 아래 "토큰 최초 셋업"을 안내하고 **멈춰서 대기**(재시도 반복 금지).

## 2. 버전 결정 (커밋 읽고 제안 후 확인)

- 마지막 릴리스 이후 커밋 수집:
  - 최신 태그: `git describe --tags --abbrev=0` → 있으면 `git log <tag>..HEAD --oneline`.
  - 첫 릴리스(태그 없음)면 `git log --oneline`으로 최근 커밋을 보여주고 기대 버전을 **사용자에게 질문**.
- Conventional Commit 접두사로 분류:
  - `feat` 있음 → **minor**
  - `fix`/`refactor`/`chore`/`docs`/`perf`만 → **patch**
  - `feat!:` 또는 `BREAKING CHANGE` → **major**
  - 신호가 섞이면 **가장 높은 단계**를 택한다.
- 제안하고 확인받는다. 예: "현재 `0.0.1` → `feat` 2건이 있어 **minor (`0.1.0`)** 을 제안합니다. 맞나요?"
  - 애매하거나 breaking 가능성이 있으면 **추측하지 말고 질문**한다.

## 3. CHANGELOG 초안

- 외부 노출 문서이므로 **영어**로 쓴다([../AGENTS.md](../AGENTS.md) 문서 언어 규칙).
- 마지막 릴리스 이후 커밋을 **사용자 관점**으로 요약한다(원시 커밋 제목 나열 X). 사용자에게 보이지
  않는 순수 내부 리팩터링은 생략.
- `# Changelog` 헤더 바로 아래에 새 블록 삽입: `## <version> - <YYYY-MM-DD>` (오늘 날짜).
- 초안을 사용자에게 보여주고 피드백 반영.

## 4. dry-run 미리보기

- 마켓플레이스/깃을 건드리지 않고 패키징 결과만 확인:
  ```
  npm run package
  ```
  (= `vsce package`) → 생성된 `.vsix`의 포함 파일·버전을 확인한다. `.vscodeignore` 때문에 `src/`·
  `node_modules/` 등이 빠지는지 점검.

## 5. 실제 게시 (수동 — 순서 엄수)

**게시가 성공한 뒤에만** commit/tag/push 한다. 순서를 지키는 것이 이 흐름의 핵심 안전장치다.

1. `package.json`의 `version`을 결정한 값으로 올린다.
2. `CHANGELOG.md`의 해당 버전 블록을 확정한다.
3. 게시:
   ```
   npx vsce publish
   ```
   (키체인 `vsce-fujigraphics` 또는 `VSCE_PAT`를 사용. 명시적으로 버전을 올리며 게시하려면
   `npx vsce publish <minor|patch|major>`도 가능하지만, 위에서 이미 `package.json`을 올렸다면 그냥
   `vsce publish`.)
4. 게시 성공 시 커밋(작성자 = `fujigraphics <fujigraphics@users.noreply.github.com>`):
   ```
   git commit -am "chore: release vX.Y.Z"
   ```
5. 태그:
   ```
   git tag vX.Y.Z
   ```
6. 푸시:
   ```
   git push && git push --tags
   ```

- **게시 실패 시**: `package.json` version 변경을 되돌리고(커밋 전이므로 작업트리에서 원복) 원인
  해결 후 재시도. 아직 commit/tag/push 하지 않았으므로 깃 히스토리는 깨끗하다.
- 최종 마켓플레이스 URL:
  `https://marketplace.visualstudio.com/items?itemName=fujigraphics.pi-for-vscode`

## 6. 문제 해결

- **게시 401/403**: PAT 만료 또는 권한 부족. Marketplace > Manage에서 PAT 재발급 후 키체인 갱신,
  재시도.
- **게시는 성공했는데 push 실패**: 확장은 이미 게시된 상태다. 수동으로 `git push && git push --tags`만
  마저 한다(게시를 다시 하지 않는다).

## 7. 토큰 최초 셋업 (한 번만)

- Azure DevOps PAT 발급:
  - Organization: **All accessible organizations**
  - 권한: **Marketplace > Manage**
  - 위치: https://dev.azure.com → User settings → Personal access tokens
- macOS 키체인에 저장:
  ```
  security add-generic-password -s vsce-fujigraphics -a fujigraphics -w <PAT>
  ```
  (또는 `VSCE_PAT` 환경변수.) PAT 만료는 최대 1년 — 같은 명령으로 갱신.

## 하지 말 것

- dirty 워킹트리(릴리스 무관 파일 변경)로 게시하지 않는다.
- 버전 신호가 충돌할 때 추측하지 않는다 — 사용자에게 묻는다.
- **게시 성공 전에 tag/push 하지 않는다.** (엔진이 없으니 publish-before-tag 순서를 사람이 지킨다.)
- 추후 NAssistant식 `release.mjs` 엔진 이식으로 이 안전 순서를 자동화하고 싶다면 별도 작업으로 진행.
