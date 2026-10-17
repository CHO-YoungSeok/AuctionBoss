## 0. 착수 전 확인

- [x] 0.1 게이트(`npx tsc --noEmit`, `npm test`, `npm run build`, `npm run lint`, `cd backend && ./gradlew check`)를 돌려 시작 시점 통과 여부와 TS 테스트 개수를 기록한다 — 시작 시점 전부 통과: tsc 0, vitest 61파일/754개, lint 경고 1(기존 img), build·gradle check 통과

## 1. Antigravity 실행기 (D2, D3)

- [x] 1.1 `workers/lib/agy.ts`에 `buildAgyArgs(prompt, model)`, `parseAgyEnvelope(stdout, stderr)`, `runAgyHeadless`, `DEFAULT_AGY_MODEL`, `MAX_AGY_PROMPT_BYTES`를 구현한다
- [x] 1.2 `workers/__tests__/agy.test.ts`(단위): 인자에 `-p=<prompt>` 한 원소·`--sandbox`·`--output-format json`·`--model`이 있고 `--dangerously-skip-permissions`·`--print-timeout`이 없음, 개행·따옴표·한글 프롬프트가 한 원소로 유지됨. 봉투: 성공 → text·`agy:<model>`, `ERROR`+`error` → diagnostic이 error, `denied_actions` 있음 → 실패, 빈 response → 실패, JSON 아님 → 실패 — agy.test.ts 단위 11개(통합 12개와 합쳐 23개)
- [x] 1.3 가짜 `agy` 셸 스크립트(기존 `claude-cli-envelope.test.ts` 방식)로 통합 확인: 성공, 종료 1 + ERROR 봉투, 시간 초과 시 프로세스 종료·오류, 100 KiB 초과 프롬프트는 프로세스를 띄우지 않음(가짜가 호출 흔적 파일을 남기지 않음), 실행 파일 없음 → `cause.code=ENOENT`, 임시 디렉터리가 지워짐, cwd가 저장소가 아님. 변이 확인: `denied_actions` 검사를 지우면 해당 테스트가 실패해야 한다 — 가짜 agy 통합 12개. 변이 19건(denied 검사·--sandbox 제거, 권한 자동 승인/--print-timeout 추가, 크기 상한·임시 디렉터리 정리·타임아웃 제거 등) 전부 검출

## 2. 실행기 선택 (D1)

- [x] 2.1 `workers/lib/runner.ts`의 `resolveRunner(env)`를 구현하고 `analyzer.ts`의 기본 실행기를 이것으로 바꾼다. 기동 시 한 번 해석해 알 수 없는 값이면 회차 전에 종료
- [x] 2.2 테스트: `agy` + API 키 → agy 실행기, 없음 + API 키 → API, 없음 + 키 없음 → Claude CLI, `claude` → 기존 규칙, `gemini`(오타) → 오류·분석 요청 0건. 기존 `claude.test.ts`는 수정 없이 통과 — runner.test.ts 17개(선택 표, 설정, 저장 모델 agy:gemini-3.8-flash-medium, startAnalyzer 연결). 기존 claude.test.ts 수정 없음

## 3. 실패 분류 (D4)

- [x] 3.1 `classify-failure.ts`의 장애성 진단 패턴에 D4 문구를 추가한다
- [x] 3.2 `failure-classification.test.ts` 표에 행 추가: 실측 `invalid model selection ...` → systemic, `RESOURCE_EXHAUSTED` → systemic, `UNAUTHENTICATED` → systemic, `tool permission denied` → item, 빈 응답 → item. 기존 행은 그대로 통과 — failure-classification.test.ts 6행 추가. 도구 거부 진단 문구는 `tool request denied by headless mode`(기존 정규식 `permission denied`와 겹치면 systemic이 되므로 피함)

## 4. 문서·운영 (D5)

- [x] 4.1 `docs/REFERENCE.md` 분석 워커 절에 `AUCTIONBOSS_ANALYZER_RUNNER`, `AUCTIONBOSS_AGY_BIN`, 기본 모델, 호스트 systemd 실행법, 대화 기록이 남는다는 점을 적는다. `.env.example`에 주석으로 변수 추가
- [ ] 4.2 게이트 전부 통과, 테스트 수 증가 확인. `regression-verifier`로 회귀 검증
- [ ] 4.3 우분투 배포: `git pull`, `npm ci`, 서비스에 `AUCTIONBOSS_ANALYZER_RUNNER=agy` 추가 후 `systemctl enable --now auctionboss-analyzer`. 시드 없는 빈 DB라 수집 재개 후 첫 분석 저장을 확인한다(모델 값 `agy:gemini-3.8-flash-medium`)
