## Context

- 실행기 경계는 `RunClaude = (options: {prompt, model?, timeoutMs?, bin?}) => Promise<{text, model}>`(`workers/lib/claude.ts`) 하나다. analyzer는 이것을 주입받는다. 선택은 `runClaude`(API 키 유무)에서 한다.
- 실패 분류(`classify-failure.ts`)는 `ClaudeInvocationError`의 `status`·`diagnostic`·`cause.code`만 본다. 메시지 문구는 보지 않는다.
- `agy` 1.3.5 실측(2026-10-18, 우분투):
  - 성공: `{"conversation_id","status":"SUCCESS","response":"PONG\n","duration_seconds","num_turns","usage":{...}}`, 종료 0
  - 잘못된 모델: `{"status":"ERROR","response":"","error":"invalid model selection ..."}`, 종료 1, stderr에도 `error: ...`
  - 도구 요청: `status:"SUCCESS"`, `response:""`, `denied_actions:[{"action":"command",...}]`, 종료 0, stderr에 `jetski: no output produced — ... auto-denied`
  - `--print-timeout` 초과: stderr `[agy] print timeout ...`, `SUCCESS` + 빈 응답, 종료 0
  - `-p` 뒤에 값을 띄어 쓰면 다음 플래그를 프롬프트로 먹는다 → `-p=<prompt>` 한 인자로 넘긴다. stdin 프롬프트는 받지 않는다
  - 응답 봉투에 모델 필드가 없다

## Goals / Non-Goals

**Goals:** `agy` 실행기 추가, 선택 변수, 격리·실패 판정, 기본 모델 flash, 장애성 분류.

**Non-Goals:** 프롬프트 변경, 사용량 저장, 컨테이너 이미지 변경, `agy` 설정 파일(`~/.gemini`) 자동 관리.

## Decisions

### D1. 선택은 `workers/lib/runner.ts`로 분리
`resolveRunner(env): RunClaude`가 `AUCTIONBOSS_ANALYZER_RUNNER`를 읽어 `agy` → `runAgyHeadless`, 없음/`claude` → 기존 `runClaude`(API 키 규칙), 그 밖 → `Error`를 던진다. `analyzer.ts`의 `main()`/`resolveAnalyzerSettings`가 기동 시 한 번 호출해 실패를 즉시 드러낸다(첫 회차 전에 종료). 기존 `runClaude`는 그대로 두어 기존 테스트가 깨지지 않게 한다. 타입 이름 `RunClaude`는 바꾸지 않는다(변경 범위 축소; 별칭 `RunAnalysis`만 추가 가능).

### D2. `runAgyHeadless`
- 인자: `["-p=" + prompt, "--output-format", "json", "--model", model, "--sandbox"]`. `--dangerously-skip-permissions`·`--print-timeout`은 넣지 않는다(테스트로 고정).
- 실행 파일: `AUCTIONBOSS_AGY_BIN ?? "agy"`. cwd는 `mkdtemp(tmpdir()/auctionboss-analyze-agy-)`, `finally`에서 삭제.
- `execFile`, `timeout: timeoutMs`, `killSignal: SIGKILL`, `maxBuffer: 16 MiB`. 시간 초과는 `ClaudeInvocationError`(status 없음 → 물건 단위 실패, 기존 Claude CLI와 같음).
- 프롬프트 바이트 길이(UTF-8)가 `MAX_AGY_PROMPT_BYTES = 100 * 1024`를 넘으면 실행 전에 `ClaudeInvocationError`(물건 단위). Linux 단일 인자 상한(128 KiB) 아래로 여유를 둔다.
- 봉투 zod 스키마(느슨하게, 알 수 없는 필드 허용): `status: string`, `response: string`, `error?: string`, `denied_actions?: array`.
- 판정 순서: stdout 파싱 실패 → 오류(diagnostic=stderr). `status !== "SUCCESS"` → 오류(diagnostic=`error ?? stderr`). `denied_actions` 길이 > 0 → 오류(diagnostic="tool request denied by headless mode: ..." — 기존 장애성 패턴 `permission denied`와 겹치지 않게). `response.trim() === ""` → 오류(diagnostic=stderr). 종료 코드 ≠ 0이어도 stdout 봉투가 있으면 봉투로 판정한다.
- 오류 타입은 기존 `ClaudeInvocationError`를 그대로 쓴다 — 분류기가 이미 인식한다. 메시지 접두어만 `agy CLI ...`로 구별.
- 반환: `{ text: response, model: "agy:" + model }`.

### D3. 기본 모델
`DEFAULT_AGY_MODEL = "gemini-3.8-flash-medium"`. 모델은 `settings.model ?? DEFAULT_AGY_MODEL`. Claude 경로의 기본값과 섞이지 않게 실행기 안에서 정한다.

### D4. 장애성 진단 패턴
`SYSTEMIC_DIAGNOSTIC` 정규식에 추가: `invalid model selection`, `not recognized as a known model`, `unauthenticated|UNAUTHENTICATED`, `RESOURCE_EXHAUSTED`, `PERMISSION_DENIED`, `please (re-)?login|sign in`, `oauth token`. 실측 문구는 잘못된 모델 하나뿐이므로 나머지는 Google API 표준 오류 코드 이름 기준이다. 거부된 도구 요청과 빈 응답은 물건 단위(프롬프트·모델 출력 문제).

### D5. 운영 (호스트 systemd)
컨테이너 analyzer는 그대로 두고 우분투에서는 compose override로 비활성, 호스트 `auctionboss-analyzer.service`에 `AUCTIONBOSS_ANALYZER_RUNNER=agy`, `PATH`에 `~/.local/bin`. 문서에 적는다.

## Risks / Trade-offs

- `agy`는 도구를 끄는 옵션이 없다 → 샌드박스 + 자동 승인 없음 + 헤드리스 자동 거부 + 빈 cwd로 막고, 거부가 있으면 결과를 버린다. `agy` 업데이트로 헤드리스 기본 동작이 바뀌면 위험 → 인자를 테스트로 고정하고, `denied_actions` 검사로 이상을 드러낸다.
- `agy`는 대화 기록을 `~/.gemini/antigravity-cli/conversations`에 남긴다(끄는 옵션 없음) → 물건 데이터는 공개 경매 정보라 허용하되 문서에 적는다.
- 프롬프트가 `ps`에 보인다 → 같은 장비 사용자만 볼 수 있고 공개 정보라 허용.
- 사용자의 `~/.gemini` 설정(MCP 등)을 물려받는다 → 지금 비어 있음. 문서에 "분석 전용 장비 계정 설정을 비워 둘 것"을 적는다.
