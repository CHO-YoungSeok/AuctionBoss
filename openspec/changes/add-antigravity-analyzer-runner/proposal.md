## Why

우분투 운영 장비에는 Antigravity CLI(`agy` 1.3.5)가 설치·로그인되어 있고, 헤드리스 실행(`agy -p=... --output-format json`)으로 Gemini·Claude 모델을 쓸 수 있다. 지금 분석 워커는 Claude Code CLI(`claude -p`)와 Anthropic Messages API만 지원해서, 이 장비에서 분석을 돌리려면 Claude 로그인이나 API 키를 따로 마련해야 한다. 이미 있는 `agy` 로그인을 분석 실행기로 쓸 수 있게 한다. 기본 모델은 비용·속도를 고려해 Gemini Flash로 한다.

## What Changes

- **실행기 선택 변수 추가**: `AUCTIONBOSS_ANALYZER_RUNNER`(`claude` | `agy`). 값이 없으면 지금 규칙 그대로(`ANTHROPIC_API_KEY` 있으면 API, 없으면 Claude CLI). `agy`면 API 키 유무와 무관하게 Antigravity CLI를 쓴다. 알 수 없는 값이면 워커가 기동 시 즉시 실패한다.
- **Antigravity 실행기**(`workers/lib/agy.ts`): `agy -p=<prompt> --output-format json --model <id> --sandbox`를 빈 임시 디렉터리에서 `execFile`로 실행한다. 권한 자동 승인(`--dangerously-skip-permissions`)은 쓰지 않는다 — 헤드리스 모드는 도구 권한을 자동 거부한다(2026-10-18 실측: 명령 실행 요청 → `denied_actions`, 파일 생성 없음). 응답 봉투(`status`, `response`, `error`, `denied_actions`)를 zod로 검증한다.
  - `status`가 `SUCCESS`가 아니거나, `response`가 비었거나, `denied_actions`가 있으면 실패로 본다.
  - 타임아웃은 워커의 기존 타임아웃(`AUCTIONBOSS_ANALYZE_TIMEOUT_MS`)으로 프로세스를 죽인다. `agy --print-timeout`은 쓰지 않는다(시간 초과 시 `SUCCESS` + 빈 응답을 돌려주기 때문).
  - 프롬프트는 argv로 넘기므로 크기 상한(100 KiB)을 넘으면 실행하지 않고 그 물건만 실패시킨다.
- **기본 모델**: `agy` 실행기의 기본 모델은 `gemini-3.8-flash-medium`. `AUCTIONBOSS_ANALYZE_MODEL`이 있으면 그 값을 쓴다. 저장되는 분석의 `model`은 `agy:<모델 id>`(예: `agy:gemini-3.8-flash-medium`) — 같은 Claude 모델이라도 경로를 구별한다. 백엔드 스키마는 바꾸지 않는다(`model` VARCHAR(255), 형식 제약 없음).
- **실패 분류 확장**: `agy`의 로그인 만료·할당량·권한·잘못된 모델 선택 오류 문구를 장애성(systemic, 회차 중단) 진단으로 분류한다. 실행 파일 없음(ENOENT)은 지금처럼 장애성이다.
- **운영 문서**: 호스트 systemd로 analyzer를 `agy` 모드로 돌리는 방법을 `docs/REFERENCE.md`에 적는다(컨테이너 이미지에는 `agy`가 없다).

이 change에서 하지 않는 것:
- 분석 프롬프트·프롬프트 버전 변경(실행기만 바뀌고 입력은 같다)
- 토큰 사용량 저장(지금도 저장하지 않는다)
- analyzer 컨테이너 이미지에 `agy` 설치

## Capabilities

### New Capabilities
<!-- 없음 -->

### Modified Capabilities
- `auction-analysis`: "Claude 분석 실행" 요구사항의 실행 방식 규칙을 "실행기 선택 변수 + 기존 API 키 규칙"으로 바꾸고, Antigravity 실행기의 격리·실패 판정·기본 모델 시나리오를 추가한다.

## Impact

- **코드**: `workers/lib/agy.ts`(신규), `workers/lib/claude.ts`(선택 함수가 실행기 변수를 읽도록 — 또는 선택을 `workers/lib/runner.ts`로 분리), `workers/lib/classify-failure.ts`(진단 패턴), `workers/analyzer.ts`(설정 해석·기동 시 검증)
- **테스트**: `workers/__tests__/agy.test.ts`(가짜 `agy` 셸 스크립트로 봉투·실패·타임아웃·인자), 실행기 선택 테스트, `failure-classification.test.ts`에 `agy` 진단 행 추가. 테스트 수는 늘기만 한다
- **스펙과 다른 경로를 쓰는 기존 코드 없음**: 백엔드·웹 변경 없음
- **운영**: 우분투 `auctionboss-analyzer.service`에 `AUCTIONBOSS_ANALYZER_RUNNER=agy`
