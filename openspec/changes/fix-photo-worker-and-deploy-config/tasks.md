## 0. 착수 전 확인

- [ ] 0.1 게이트 4종(`npx tsc --noEmit`, `npm test`, `npm run build`, `npm run lint`)과 `cd backend && ./gradlew check`를 돌려 시작 시점의 통과 여부와 TS 테스트 개수를 기록한다

## 1. 어댑터 사진 조회 (D1)

- [ ] 1.1 `src/lib/sources/types.ts`에 `PhotoLookupRef`·`SourcePhoto`·`FetchItemPhotosResult`와 `AuctionSource.fetchItemPhotos`를 추가하고 `src/lib/sources/index.ts`에서 내보낸다. `npx tsc --noEmit`이 기존 가짜 소스(테스트의 `AuctionSource` 구현)에서 실패하는 곳을 모두 고쳐 통과시킨다
- [ ] 1.2 `CourtAuctionAdapter.fetchItemPhotos`를 구현한다(`DETAIL_PATH`, `dspslGdsSeq: ""`, 인스턴스 안 세션 재사용, `parseDetailResponse`, `cortAuctnPicSeq`·`picFile`이 모두 있는 항목만). `adapter.test.ts`에 가짜 fetch로 다음을 확인한다: 사진 2장 정상 반환, `csPicLst` 빈 배열이면 빈 결과, HTML 본문이면 `WafBlockedError`, `ipcheck: false`면 `RobotDetectedError`, 스키마 불일치면 `ResponseSchemaError`, 두 번 호출 시 부트스트랩 요청 1회·`requestsMade` 합계 3, 요청 본문에 `csNo`·`cortOfcCd`가 들어감. 변이 확인: `parseDetailResponse` 호출을 `JSON.parse`로 바꾸면 차단 테스트 2개가 실패해야 한다
- [ ] 1.3 `src/lib/sources/courtauction/detail.ts`와 `__tests__/detail.test.ts`를 삭제한다. `rg "courtauction/detail" src workers`가 0건이고, 삭제한 테스트가 검증하던 사례(사진 없는 항목 제외 등)가 1.2 테스트에 있는지 대조한다. 줄어든 테스트 개수와 옮긴 개수를 기록한다

## 2. 차단 백오프 공유 (D2)

- [ ] 2.1 `COLLECTOR_STATE_KEYS.BACKOFF_UNTIL = "backoff_until"`과 `getBackoffUntil()`·`extendBackoffUntil(until)`을 `collector-state.ts`에 추가하고, 기본 백오프 상수를 `src/lib/domain`으로 옮긴다. `collector-state.test.ts`에 확인한다: 값 없음 → null, 파싱 불가 값 → null, 더 늦은 값은 덮어씀, 더 이른 값은 무시(2시간 뒤 값 유지), 옛 사진 워커 형식(ISO 문자열) 행을 그대로 읽음. 변이 확인: 비교 조건을 지우면 "더 이른 값 무시" 테스트가 실패해야 한다
- [ ] 2.2 `workers/collector.ts`에서 `blockedUntil` 변수를 없애고 `tick()`이 `getBackoffUntil()`을 읽어 건너뛰게, 차단 시 `extendBackoffUntil`을 호출하게 바꾼다. 조회 실패는 로그 후 진행한다. `collector.test.ts`에 확인한다: 차단 후 다음 tick이 `skipped(backoff)`로 기록되고 소스를 호출하지 않음(기존 테스트 유지), **다른 워커가 미리 기록한 백오프**가 있으면 첫 tick부터 건너뜀, 새 `startCollector` 인스턴스(재시작)도 같은 DB의 백오프를 지킴, 백오프 시각이 지나면 다시 수집함, 조회가 throw해도 수집이 진행됨. 변이 확인: `tick()`의 백오프 확인을 지우면 "다른 워커 백오프" 테스트가 실패해야 한다

## 3. 사진 워커 회차 기록·재시도·상주화 (D3, D4, D5)

- [ ] 3.1 `photo_attempted_at` 컬럼을 `schema.ts`(새 DB)와 `client.ts`의 `migrateItemPhotoColumns`(기존 DB)에 추가한다. `client.test.ts`에 컬럼 없는 옛 DB 파일을 열면 컬럼이 추가되고 기존 행이 보존되는지 확인한다
- [ ] 3.2 저장소의 사진 결과 기록 함수가 `photo_attempted_at`을 함께 쓰게 하고, `getPendingPhotoItems(limit, { now, retryAfterHours })`를 D4의 조건·정렬로 바꾼다. `repository.test.ts`에 확인한다: 미시도 물건이 먼저, 간격 안(1시간 전) 실패 물건 제외, 간격 지난(25시간 전) 실패 물건 포함·미시도 뒤, 시각 NULL인 옛 `failed` 포함, `collected`·`empty` 제외, 식별자 없는 물건 제외. 변이 확인: 시각 조건을 지우면 "간격 안 제외" 테스트가 실패해야 한다
- [ ] 3.3 `backend/src/main/resources/db/migration/V2__item_photo_attempt.sql`을 추가하고 `SchemaMigrationTest`에 `items.photo_attempted_at` 존재 단언을 더한다. `./gradlew check`(계약 테스트 포함)가 통과하는지 확인한다
- [ ] 3.4 `config/collector.json`에 `photos` 절(`intervalMs`, `maxItemsPerRun`, `requestDelayMs`, `retryAfterHours`)을 추가하고 `config.ts` zod 스키마로 검증한다. `PhotosRunDetail`을 `WorkerRunDetail`에 더한다. 설정 테스트에 누락·음수 값이 즉시 오류인지 확인한다
- [ ] 3.5 `getWorkerStatus`의 기대 주기를 워커별 매핑으로 바꾼다. `worker-runs.test.ts`에 사진 주기 30분·분석 주기 10분·마지막 성공 40분 전이면 사진 워커가 `stale`이 아닌지 확인한다. 변이 확인: 매핑을 예전 삼항식으로 되돌리면 이 테스트가 실패해야 한다
- [ ] 3.6 `workers/photos.ts`를 `startPhotoWorker(options)`(주입: 소스 팩토리, 저장, 시계, sleep, 로거) + `main()`(`--once` 지원, 종료 신호 처리)으로 다시 쓴다. 회차마다 어댑터를 새로 만들고, 회차 전·물건마다 백오프를 확인하며, 결과를 `startRun`/`finishRun`/`recordSkippedRun("photos", …)`로 기록한다. 기록 실패는 로그만 남긴다
- [ ] 3.7 `workers/__tests__/photos.test.ts`를 새로 만들어 확인한다: 성공 회차 수치(시도·저장·사진 없음·실패·요청 수), 일부 실패는 성공, 전부 실패는 `failed`, 차단 시 `blocked`·남은 물건 미요청·`backoff_until` 기록·차단 물건은 `failed`로 기록하지 않음, 일반 오류는 백오프를 쓰지 않음, 회차 중간에 다른 워커가 백오프를 쓰면 다음 물건부터 멈춤, 백오프 중 `skipped(backoff)`, 실행 중 tick은 `skipped(overlap)`, 대기 물건 0건이면 성공·0건, 물건 사이 `requestDelayMs`만큼 sleep 호출, 회차 상한만큼만 요청, 기록 저장이 throw해도 사진 저장은 진행. 변이 확인: (a) 차단 분기에서 `extendBackoffUntil`을 지우면, (b) 물건 루프의 백오프 확인을 지우면, (c) 결과 규칙을 "실패 1건이면 failed"로 바꾸면 각각 테스트가 실패해야 한다
- [ ] 3.8 `rg "\"HTTP\"|includes\(\"HTTP\"\)" workers`가 0건이고 사진 워커에 `courtauction` import가 없는지 확인한다

## 4. 표시 상태 (D6, run-observability 상태 화면)

- [ ] 4.1 `photo-display.ts`에 `unavailable` 상태와 "사진 정보 없음(조회 불가)" 메시지를 추가하고 판정 순서를 D6대로 바꾼다. `photo-display.test.ts`에 확인한다: 식별자 없음 + 상태 없음 → `unavailable`, 식별자 없음 + 옛 `failed` → `unavailable`, 식별자 없음 + `collected` → `collected`, 식별자 있음 + `failed` → `failed`. 변이 확인: 식별자 분기를 `failed`로 되돌리면 실패해야 한다. 상세 화면 렌더 테스트(`src/app/items/[id]/__tests__/`)는 다른 작업자가 다루므로 이 change에서 수정이 필요하면 착수 시점에 조율한다
- [ ] 4.2 상태 화면에서 사진 워커 회차의 시도·저장·사진 없음·실패 건수를 표시한다(`status-display.ts`). `status-display.test.ts`에 사진 회차 detail이 위 네 수치로 표시되고, 기록이 없으면 안내 문구가 나오는지 확인한다

## 5. 배포 설정 (D7)

- [ ] 5.1 `docker-compose.yml`을 고친다: analyzer `AUCTIONBOSS_API_BASE`·`ANTHROPIC_API_KEY`·`AUCTIONBOSS_ANALYZE_MODEL`(`${VAR:-}`), web 헬스체크를 `node -e fetch(...)`로 바꾸고 `start_period` 추가, `photos` 서비스 추가, collector·photos `depends_on: web: condition: service_healthy`. `docker compose config`가 `.env` 없이도 성공하는지 확인한다
- [ ] 5.2 `k8s/deployment-analyzer.yaml`의 `BASE_URL`을 `AUCTIONBOSS_API_BASE`로 바꾸고, `k8s/deployment.yaml` Pod에 `photos` 컨테이너(같은 PVC, `npm run photos`)를 더하고, `k8s/secret.yaml` 주석에 `ANTHROPIC_API_KEY`를 적는다. `kubectl kustomize k8s`(또는 `kubectl apply --dry-run=client -k k8s`)가 성공하는지 확인한다
- [ ] 5.3 `js-yaml`을 devDependency로 명시하고 배포 설정 테스트(`src/__tests__/deploy-config.test.ts` 등)를 만든다: compose analyzer와 K8s analyzer에 `AUCTIONBOSS_API_BASE`가 있고 `BASE_URL`이 없음, 그 값이 `workers/lib/api.ts`의 기본값(localhost)이 아님, compose web 헬스체크 명령에 `curl`이 없고 `node`로 시작함, compose `photos` 서비스와 K8s `photos` 컨테이너가 web과 같은 데이터 볼륨을 마운트함, analyzer 코드가 읽는 환경 변수 이름(`AUCTIONBOSS_API_BASE`)을 소스에서 찾아 설정과 대조. 변이 확인: compose의 이름을 `BASE_URL`로 되돌리면 실패해야 한다
- [ ] 5.4 `docker compose up -d --build web collector photos analyzer`로 한 번 띄워 web이 `healthy`가 되는지, analyzer 로그가 `http://web:3000`으로 요청하는지 확인하고 결과를 tasks 하단 메모에 남긴다(외부 소스에 요청하지 않도록 이 확인에서는 collector·photos를 띄우지 않거나, `collector_state.backoff_until`을 미래 시각으로 기록한 볼륨으로 띄운다)

## 6. Claude API 기본 모델 (D8)

- [ ] 6.1 `@anthropic-ai/sdk`를 의존성에 추가하고 `runClaudeViaApi`를 SDK 호출로 바꾼다: 모델 기본값 `DEFAULT_API_MODEL = "claude-opus-5-5"`(`AUCTIONBOSS_ANALYZE_MODEL` 우선), `max_tokens: 16000`, `output_config.effort: "medium"`, 서버 측 대체(`fallbacks: "default"`, 베타 `server-side-fallback-2026-07-01`). `stop_reason`이 `max_tokens`나 `refusal`이면 `ClaudeInvocationError`(refusal은 `stop_details.category` 포함). 응답의 `model`을 결과에 담는다. 테스트는 **새 파일** `workers/__tests__/claude-api-default.test.ts`에 SDK 클라이언트를 주입해 둔다: 모델 미지정 시 `claude-opus-5-5`, 지정 시 그 값, effort와 fallbacks가 요청에 들어감, `max_tokens`·`refusal` 종료는 오류, 정상 응답은 텍스트와 실제 모델을 돌려줌. 기존 `runClaude` 경로 선택 테스트(`claude.test.ts`)가 계속 통과하도록 주입 방식을 맞춘다. 변이 확인: 기본값을 옛 ID로, stop_reason 검사를 지우면 각각 실패해야 한다. `rg "claude-3-5-sonnet|api.anthropic.com/v1/messages" workers src`가 0건인지 확인한다
- [ ] 6.2 README의 분석 워커 설정 절에 API 모드 기본 모델, `AUCTIONBOSS_ANALYZE_MODEL=claude-sonnet-5-5`로 비용을 낮추는 선택지, 컨테이너 analyzer에는 API 키가 필요하다는 점을 적는다

## 7. 마무리

- [ ] 7.1 사진 워커를 `npm run photos -- --once`로 실제 소스에 1회(회차 상한 1건) 실행해 결과(요청 수, 세션 필요 여부, 사진 장수·형식, 차단 여부)를 `src/lib/sources/courtauction/NOTES.md`에 기록한다. 원본 응답에 개인 이름이 있으면 기록에 옮기지 않는다
- [ ] 7.2 `npm run collector`와 `npm run photos`를 함께 띄운 상태에서 `backoff_until`을 미래로 직접 기록해 두 워커 모두 `skipped(backoff)`를 남기는지 `/status` 화면과 `worker_runs`로 확인한다
- [ ] 7.3 README 실행 방법(사진 워커 상주·`--once`, `photos` 설정), `docs/REFERENCE.md`(백오프 공유 키, 사진 워커 구조), `docs/DEVELOPMENT_NOTES.md`(이번 결함과 고친 방식)를 갱신한다
- [ ] 7.4 게이트 5종(`npx tsc --noEmit`, `npm test`, `npm run build`, `npm run lint`, `./gradlew check`)이 모두 통과하는지 확인한다. TS 테스트 개수가 0.1 대비 늘었는지 확인하고, 1.3에서 삭제한 테스트 수와 옮긴 수를 함께 보고한다
- [ ] 7.5 `regression-verifier` 서브에이전트로 회귀 검증을 받는다. 특히 백오프 공유(양방향), 재시도 간격, 차단 감지, 배포 환경 변수 이름이 테스트로 막혀 있는지 판정받는다
- [ ] 7.6 커밋하고 푸시한다
- [ ] 7.7 `openspec validate fix-photo-worker-and-deploy-config --strict`를 통과시킨 뒤 아카이브한다. `align-specs-with-code`가 아직 아카이브되지 않았다면 design.md D9의 요구사항 목록이 그대로인지 다시 확인한다
