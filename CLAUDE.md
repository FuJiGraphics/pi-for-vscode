# CLAUDE.md — pi-for-vscode

이 프로젝트의 에이전트 공용 지침은 [AGENTS.md](AGENTS.md)에 정리되어 있습니다.
특정 AI에 종속되지 않는 **단일 원본**이며, 아래 import로 매 Claude 세션에 자동 로드합니다.
(별도 사본을 만들지 않는 이유: 규칙이 한 곳에만 있어야 두 파일이 어긋날 일이 없습니다.)

@AGENTS.md

## 세부 문서 (필요할 때 읽기)

AGENTS.md가 가리키는 문서는 작업이 거기에 닿을 때 직접 열어 봅니다. 매 세션 통째로
올리지 않는 이유는, 배포 절차 같은 세부는 대부분의 작업과 무관해서 컨텍스트만 차지하기 때문입니다.

- 확장 작성 규율(커맨드·webview 메시지·RPC·CSP·빌드): [docs/vscode-extension.md](docs/vscode-extension.md)
- 마켓플레이스 배포 절차(수동 vsce 흐름): [docs/marketplace-publish.md](docs/marketplace-publish.md)

## Claude 세션에서 특히 주의할 점

위 AGENTS.md 규칙은 이 repo에서 최우선입니다. Claude 기본 동작과 부딪히는 두 지점만 짚어둡니다.

- **커밋 작성자 / 푸터**: 커밋 메시지에 AI·에이전트를 작성 주체로 넣지 않습니다 —
  `Co-Authored-By`, "Generated with …" 류의 푸터를 **붙이지 않습니다**(하니스/툴 기본 푸터가
  있어도 이 프로젝트에서는 무시). 커밋 작성자는 항상
  `fujigraphics <fujigraphics@users.noreply.github.com>`를 씁니다(영구 git config로 박지 않음).
  근거는 AGENTS.md "커밋 규칙" 절.
- **언어 적용 대상**: 대화·설명은 한국어(전역 지침), 외부 노출 문서(`README.md`, `CHANGELOG.md`,
  `package.json`의 description/displayName/keywords, 확장 UI 문자열)는 영어(AGENTS.md "문서 언어
  규칙"). 둘은 충돌이 아니라 적용 대상이 다른 것뿐입니다. 내부 문서(`AGENTS.md`, `docs/*.md`,
  코드 주석 메모)는 한국어 톤을 유지해도 됩니다.
