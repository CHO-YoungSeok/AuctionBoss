## 1. 시나리오 골든 생성 확장

- [x] 1.1 시작 기준을 확인한다. 게이트 5종(`npx tsc --noEmit`, `npm test`, `npm run build`, `npm run lint`, `cd backend && ./gradlew check`)이 통과하고 테스트 수(TS 791, Java 215)와 change 시작 커밋 해시를 이 파일 하단 메모에 남긴다(7.3의 `workers/` 무변경 확인 기준)
- [x] 1.2 `scripts/seed/seed-to-sqlite.ts`를 만든다. 커밋된 시드 SQL을 Next 스키마(`getDb`)로 만든 임시 SQLite에 적재한다(`sql.ts` 역변환: 백슬래시 이스케이프, `DATETIME(3)` → ISO `Z`, `JSON`). vitest 왕복 테스트(행 → SQL → 역적재 → 같은 행)로 고정하고, 적재 결과가 물건 809, 변경 이력 4,008, 분석 12, 회차 7건인지 확인한다. 변이 확인: 시각 역변환에서 `Z`를 빼면 왕복 테스트가 실패한다
- [x] 1.3 역적재 DB로 1단계 읽기 골든 중 10개(목록 기본, 정렬 2종, 필터 3종, 상세 2종, 이력 1종, 용도)를 임시로 다시 만들어 커밋된 골든과 같은지 확인한다(design.md D10 위험 항목). 결과만 메모에 남기고 파일은 커밋하지 않는다
- [x] 1.4 `scripts/seed/generate-scenarios.ts`를 만든다. 시나리오마다 역적재 DB 복사본, 단계별 고정 시각(`T0 + i초`, 인자 없는 `Date`와 `Date.now()`만 고정), `config` 덮어쓰기(`AUCTIONBOSS_CONFIG` 임시 파일), `capture` 변수 치환, 사진 픽스처 행·파일 준비를 지원하고 `backend/src/test/resources/contracts/scenarios/*.json`에 쓴다. 고정 시각 대체를 vitest로 확인한다(단계 안에서 `new Date()`가 같은 값, 인자 있는 `new Date(x)`는 원래 동작)
- [x] 1.5 design.md D10의 시나리오 7개(`worker-runs-lifecycle`, `worker-runs-errors`, `worker-runs-prune`, `bookmarks-feed`, `bookmarks-errors`, `analyses`, `photos`)를 정의하고 작은 PNG·JPEG 픽스처를 `contracts/photos/`에 둔다. 생성을 두 번 돌려 바이트 단위로 같은지(결정성), `"<iso-ms>"` 표식 수가 0인지, 원본이 500을 낸 단계가 없는지 확인한다

## 2. 공통 기반과 분석 저장 API

- [x] 2.1 `common/body`에 JSON 본문 검증기를 만든다: 해석 실패 메시지, 루트 비객체의 `(root)`, JS 정수 규칙(`1.0` 허용, `"1"` 거절), 모르는 키 무시, 필드 순서대로 이슈 수집. 단위 테스트로 각 규칙을 확인하고, 변이 확인으로 문자열 숫자 거절을 지우면 테스트가 실패하는지 본다
- [x] 2.2 밀리초로 자른 "지금"(요청당 한 번)과 JS 숫자 직렬화(정수 값의 실수는 정수로)를 만든다. `MutableClock`에 마이크로초가 있는 시각을 넣어 저장 값과 응답 값이 같은지, `1.0`이 `1`로 쓰이는지 테스트한다
- [x] 2.3 `POST /api/analyses`를 만든다(design.md D6: 존재 확인 → 저장 한 트랜잭션, FK 위반은 404). MockMvc + Testcontainers로 201(모델 있음·없음), 404 후 행 수 불변, 400(문자열 id, 빈 body, 해석 불가, 배열 본문의 `(root)`), Content-Type 없는 요청 성공을 확인한다. 변이 확인: 존재 확인을 빼면 404 테스트가 실패한다
- [x] 2.4 저장 직후 `GET /api/items/{id}`의 최신 분석과 `needsAnalysis=true` 목록이 새 분석을 반영하는지 고정 `Clock` 통합 테스트로 확인한다

## 3. 워커 회차 API

- [x] 3.1 `WorkerSettings`가 `config/collector.json`의 `observability.maxRunsPerWorker`를 읽게 하고 덮어쓰기 속성을 둔다. 파일 값·덮어쓰기·잘못된 값 테스트를 `AnalysisSettingsTest`와 같은 방식으로 작성한다
- [x] 3.2 `worker-run-query.ts`의 목록·집계 파라미터 검증을 Java 파서로 옮긴다. 원본 라우트 테스트(`src/app/api/worker-runs/__tests__/route.test.ts`)의 거절·허용 사례와 `since`(날짜만, `Z`, 오프셋, `abc`)를 Java 테스트로 옮겨 같은 `field`가 나오는지 확인한다
- [x] 3.3 `POST /api/worker-runs`와 보관 상한 정리를 만든다(design.md D6의 경계 행 조회 + 범위 삭제, 한 트랜잭션). 상한 3에서 4번째 시작 시 가장 오래된 1건만 지워지는지, 같은 `started_at`이면 id가 작은 것이 지워지는지, 다른 워커 회차가 남는지 테스트한다. 변이 확인: 범위 조건의 `id <=`를 `id <`로 바꾸면 테스트가 실패한다
- [x] 3.4 `PATCH /api/worker-runs/{id}`를 만든다. 수집·분석 형식 `detail`의 필드만 남겨 정규화 JSON으로 저장하고 `items_changed`를 수집 형식의 `changed`에서만 정한다. 404(없는 id, `abc`), 400(`outcome`, `detail` 형식 불일치, 사진 형식, 빈 `errorKind`), 모르는 키 제거, `detail` 숫자 `3.0`이 `3`으로 나오는지 테스트한다
- [x] 3.5 `GET /api/worker-runs`(QueryDSL, `started_at DESC, id DESC`)와 `GET /api/worker-runs/summary`(`GROUP BY outcome` 1문장, 완료 0건이면 `successRate: null`)를 만들고 필터·페이지·집계 값을 테스트한다. 정적 경로 `summary`가 `{id}`에 잡히지 않는지도 확인한다

## 4. 관심 물건·변동 피드 API

- [x] 4.1 `feed-query.ts`의 페이지·`sinceBookmarkedAt` 검증을 Java 파서로 옮긴다. 원본에 파서 단위 테스트가 없으므로 원본 스키마의 규칙(정수 형식, 1 이상, 200 이하, `true`/`false`, 빈 값)마다 사례를 만들어 같은 `field`를 확인한다
- [x] 4.2 `POST /api/bookmarks`를 만든다(존재 확인 → `ON DUPLICATE KEY UPDATE item_id = item_id` → 물건 조회, 한 트랜잭션). 201 `{ item }`의 `bookmarked: true`, 중복 등록 시 행 1개 유지와 처음 `created_at` 보존, 없는 물건 404 후 무변경을 테스트한다. 변이 확인: 갱신 절을 `created_at = VALUES(created_at)`로 바꾸면 보존 테스트가 실패한다
- [x] 4.3 `DELETE /api/bookmarks/{itemId}`를 만들고 200 `{ itemId, bookmarked: false }`, 담기지 않은 물건 해제 성공, 없는 물건·`abc` 404를 테스트한다
- [x] 4.4 `GET /api/bookmarks`를 조인 1문장 + 건수 1문장으로 만든다(design.md D7). 응답 `item`이 상세 API의 `item`과 같은 JSON인지, 순서가 `created_at DESC, item_id DESC`인지 테스트한다
- [x] 4.5 `GET /api/feed`와 `POST /api/feed/read`를 만든다(읽음은 행 별칭 upsert + 미확인 개수 한 트랜잭션). 기준점 제외, `sinceBookmarkedAt`, 해제한 물건 제외, 읽지 않은 상태의 전체 미확인, 읽음 후 0, 조회만으로 불변, `feed_reads` 행이 항상 1개인지 테스트한다. 변이 확인: `kind = 'change'` 조건을 빼면 기준점 테스트가 실패한다

## 5. 사진 파일 API

- [x] 5.1 `auctionboss.photos.dir` 설정과 `PhotoFileStore`를 만든다. 상대·절대 경로 정규화, `Path.startsWith` 경계(`../`, 형제 디렉터리 `photos2`), 파일 없음을 단위 테스트로 확인한다. 변이 확인: 경계 검사를 문자열 `startsWith`로 바꾸면 형제 디렉터리 테스트가 실패한다
- [x] 5.2 `GET /api/photos/{itemId}/{seq}`를 만든다(`parseInt` 규칙, 텍스트 오류 본문, `Content-Type`, `Cache-Control`). MockMvc로 200 바이트 일치, 400 `Invalid ID`, 404 `Not Found`·`File Not Found`, `12abc`가 12로 해석되는지 테스트한다

## 6. 계약 비교

- [x] 6.1 `ScenarioContractTest`를 만든다. 시나리오마다 쓰기 대상 테이블을 비우고 시드를 다시 적재한 뒤 `AUTO_INCREMENT`를 재설정하고, `MutableClock`과 `config` 덮어쓰기를 맞춰 단계를 재생한다. 비교 규칙은 design.md D10(2xx 엄격, 400 `error`·`details[].field`, 404 `error`, 사진 SHA-256·헤더, 텍스트)이며 1단계 `ContractTest.diff`를 공유한다. 실패 메시지에 시나리오·단계·첫 차이 경로가 나오는지 일부러 골든 하나를 바꿔 확인한다
- [x] 6.2 모든 시나리오가 일치할 때까지 차이를 고친다. 불일치 건수와 원인을 메모에 남긴다. 기존 읽기 골든 90개(`ContractTest`)도 계속 일치하는지 확인한다
- [x] 6.3 변이 확인: Spring 쪽에서 (a) 관심 목록 정렬 방향, (b) 읽음 응답의 `lastReadAt` 출처(Clock 대신 다른 시각), (c) 분석 저장의 상태 코드(201→200)를 하나씩 바꿔 각각 시나리오 테스트가 실패하는지 확인하고 되돌린다

## 7. 분석 워커 무수정 연결 검증(개발 환경)

- [x] 7.1 `scripts/dev/fake-claude`를 만든다(고정 JSON, 모델 `fake-claude`, 본문에 개발 검증용 표시). 그 출력이 분석 워커의 CLI 결과 파서(`parseClaudeEnvelope`)를 통과하는지 vitest로 확인한다
- [x] 7.2 `scripts/dev/verify-analyzer-on-spring.sh`를 만든다(design.md D11 절차, `ANTHROPIC_API_KEY` 비우기와 그 사실 출력, 값 출력 금지, 실행 전후 건수 출력)
- [x] 7.3 개발 환경에서 스크립트를 1회 실행한다. MySQL의 새 분석 행(모델 `fake-claude`), `analyzer` 성공 회차와 `detail`, `GET /api/items/{id}`의 최신 분석을 확인하고, `git diff --stat <1.1의 시작 커밋> -- workers/`가 비어 있음을 확인한다. 외부 요청이 없었음을 Spring·분석 워커 로그로 확인한다
- [x] 7.4 compose·K8s의 분석 워커 `AUCTIONBOSS_API_BASE` 기본값이 Next 주소 그대로인지 확인한다(운영 경로 유지, spec "운영 경로 유지"). 기존 `src/__tests__/deploy-config.test.ts`가 이 값을 고정하는지 보고, 없으면 그 검사를 더한다

## 8. 마무리

- [x] 8.1 `QueryCountTest`에 관심 목록(목표 2문장)과 피드(목표 3문장), 회차 목록(2), 집계(1)를 더하고 행 4건과 30건에서 같은 수인지 확인한다. 변이 확인: 관심 목록을 물건별 조회로 바꾸면 테스트가 실패한다
- [ ] 8.2 수치를 `docs/DEVELOPMENT_NOTES.md`에 기록한다: 시나리오·단계 수, 불일치 건수와 원인, 관심 목록·피드 `EXPLAIN`, 시드 기준 쓰기 API 응답 시간, 7.3 실행 결과(건수 변화, 회차 수치, 소요 시간), 테스트 수 변화
- [ ] 8.3 `docs/REFERENCE.md`와 README에 Spring API 목록, 인증 없음과 루프백 포트 유지 원칙(design.md D9), 폼 엔드포인트는 3단계 몫이라는 점을 반영한다
- [ ] 8.4 `docs/ROADMAP.md` 2단계를 갱신한다: 완료 기준을 "개발 환경(시드 MySQL + Spring)에서 분석 워커 코드 변경 0줄, 환경 변수만 바꾼 실행으로 분석 결과가 Spring에 저장된다"로 고치고, 운영 전환은 5단계에서 데이터 이전과 함께 한다고 5단계 할 일에 적는다. 상태와 수치, 기록 위치를 채운다
- [ ] 8.5 게이트 5종을 모두 통과시킨다. TS·Java 테스트 수가 1.1보다 줄지 않았는지 확인하고, 줄었으면 이유를 보고한다
- [ ] 8.6 `regression-verifier` 서브에이전트로 회귀 검증을 받고 지적 사항을 반영한다
- [ ] 8.7 커밋하고 푸시한 뒤 GitHub Actions의 TS 잡과 Java 잡이 통과하는지 확인한다
- [ ] 8.8 `openspec validate add-spring-write-api --strict`를 통과시킨 뒤 change를 아카이브하고, 메인 스펙 `spring-backend`에 요구사항이 반영됐는지 확인한다

---

### 메모
<!-- 1.1 시작 커밋·테스트 수, 1.3 읽기 골든 재생성 비교 결과, 6.2 불일치 원인을 여기에 남긴다 -->

---

### 메모: 7장 분석 워커 무수정 연결 (2026-10-09)
- `scripts/dev/verify-analyzer-on-spring.sh` 1회 실행. 개발용 MySQL(시드 809건) + Spring(local,seed) + 분석 워커(`AUCTIONBOSS_API_BASE=http://localhost:8080`, 가짜 CLI, `ANTHROPIC_API_KEY` 비움).
- analyses 12 → 15건(신규 2, 재분석 1, 모델 `fake-claude`, prompt_version v3). analyzer 회차 success, detail `{"newCount":2,"reanalysisCount":1,"succeeded":3,"failed":0}`. `GET /api/items/123`의 최신 분석이 새 행. 약 3초.
- `git diff --stat adda943 -- workers/` 0줄: 분석 워커 코드 변경 없음.
- 외부 Claude 호출 0건. 개발 DB에 가짜 분석 3건과 회차 1건이 남아 있다(시드 재적재로 제거 가능).
- 7.4: compose `http://web:3000`, K8s `http://auctionboss-service:3000` 그대로(운영 경로 유지). K8s 값을 정확히 고정하는 단언 추가.

### 메모: 6장 계약 비교 (2026-10-09)
- 시나리오 7개, 115단계. 114단계는 처음부터 일치했다. 이식 실수로 생긴 불일치는 0건.
- 불일치 1건(`worker-runs-lifecycle` 19단계 `summary?since=...+09:00`)은 Next 버그였다: `since`를 SQLite에서 문자열로 비교해 시간대 오프셋을 UTC로 바꾸지 않아, 같은 순간의 `...Z`와 결과가 달랐다(Next 0건, Spring 4건). Next가 `since`를 UTC ISO로 정규화하도록 고치고 정답을 다시 생성해 115단계 모두 정확히 일치시켰다. 계약 테스트가 기존 구현의 버그를 찾은 사례다.
- MySQL 컬럼 길이로 Next가 받는 입력을 Spring이 500으로 거부하던 것(prompt_version 20자, model 100자, body 약 65KB)은 Flyway V3로 넓혔다(VARCHAR(255), VARCHAR(255), MEDIUMTEXT).
- 의도된 차이로 남긴 것: 회차 종료 `detail.changed`의 소수·INT 초과 값(호출자는 항상 0 이상 정수). design.md D4에 근거.
- 6.3 변이 3종(관심 정렬, 읽음 시각 출처, 분석 저장 상태 코드)을 모두 시나리오 테스트가 잡았다.
