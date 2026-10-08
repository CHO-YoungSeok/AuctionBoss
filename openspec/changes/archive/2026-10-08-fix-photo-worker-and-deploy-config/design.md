## Context

- 동기와 범위는 proposal.md, 지켜야 할 동작은 이 change의 `specs/`를 따른다.
- **사진 워커(`workers/photos.ts`)**: 1회 실행 스크립트다. `src/lib/sources/courtauction/detail.ts`를 직접 import해 `RetrieveAuctnCsDetailInfo.ajax`(NOTES에 근거가 없는 엔드포인트)로 요청하고, User-Agent는 `"Mozilla/5.0"`(NOTES §6.1이 WAF에 걸린다고 기록한 짧은 UA와 같은 계열), 세션 부트스트랩과 차단 감지가 없다. 회차 기록이 없고, 요청 간격은 3초로 하드코딩되어 있다. 응답 메시지에 "HTTP"가 있으면 `collector_state.backoff_until`에 10분 백오프를 쓴다.
- **어댑터(`courtauction/adapter.ts`)**: NOTES §10.1에서 CONFIRMED된 상세 엔드포인트(`DETAIL_PATH = /pgj/pgj15B/selectAuctnCsSrchRslt.on`)와 3단 검사 파서(`parseDetailResponse`), 매직 바이트 판별(`detectImageExtension`)이 이미 있지만, 이를 호출하는 메서드가 없다. `AuctionSource`에는 `fetchActiveItems`만 있다.
- **수집 워커(`workers/collector.ts`)**: 차단 백오프가 클로저 변수 `blockedUntil`이라 재시작하면 사라지고, `collector_state`를 읽지도 쓰지도 않는다. 사진 워커가 쓴 `backoff_until`도 보지 않는다.
- **대기 물건 조회(`repository.ts` `selectPendingPhotoItems`)**: `failed`를 조건 없이 다시 고른다(미시도 물건 뒤에 정렬할 뿐). 시도 시각을 저장하는 컬럼이 없다.
- **표시(`src/app/_lib/photo-display.ts`)**: 상세 조회 키가 없으면 `failed`를 돌려 "사진 수집 실패 (재시도 대기)"로 보인다. 대기 물건 조회는 키가 없는 물건을 고르지 않으므로 실제로는 영원히 재시도되지 않는다.
- **상태 판정(`worker-runs.ts` `getWorkerStatus`)**: `collector`가 아니면 분석 주기(`config.analysis.intervalMs`)를 기대 주기로 쓴다. `WORKER_KINDS`에는 이미 `photos`가 있다.
- **배포**: compose·K8s analyzer는 `BASE_URL`을 넘기지만 `workers/analyzer.ts`는 `AUCTIONBOSS_API_BASE`만 읽고, 없으면 `http://localhost:3000`으로 요청한다. compose web 헬스체크는 `curl`을 쓰지만 `Dockerfile`(node:22-slim)에는 curl이 없다. 사진 워커 서비스·컨테이너가 없다.
- **Claude API 모드**: `workers/lib/claude.ts` `runClaudeViaApi`의 기본 모델이 `claude-3-5-sonnet-20241022`(은퇴)다. `ANTHROPIC_API_KEY`가 있으면 API, 없으면 CLI를 쓰며, CLI 모드는 `--model`을 넘기지 않으면 CLI 기본 모델을 쓴다.
- **Spring 백엔드**: `V1__baseline.sql`이 SQLite 8개 테이블을 1:1로 옮겼고, spring-backend 스펙이 "기존 SQLite 테이블과 같은 컬럼"을 SHALL로 요구한다. 쓰기 경로는 아직 없고 `ddl-auto=validate`다.

## Goals / Non-Goals

**Goals:**
- 사진 워커가 수집 워커와 같은 운영 수준(상주, 회차 기록, 백오프 공유, 설정화, 테스트)을 갖는다.
- 소스 접근이 전부 `AuctionSource` 뒤로 들어간다.
- `docker compose up`과 K8s 매니페스트로 띄운 analyzer·web·photos가 실제로 동작한다.

**Non-Goals:**
- 사진·수집 워커의 Spring 이식(로드맵 4단계). 이 change는 기존 TypeScript 운영 경로만 고친다.
- 수집 워커와 사진 워커의 요청 시점 조율(같은 순간에 두 워커가 요청하지 않게 하는 잠금). Risks 참고.
- 실패 횟수 상한(N회 실패 후 영구 중단). D4 참고.
- Claude API 호출을 공식 SDK로 바꾸는 것, thinking·effort 조정. 기본 모델 값만 바꾼다(D8).
- 일괄매각 사건에서 물건별 사진을 구별하는 것(NOTES §15.3의 `dspslGdsSeq` 미확정 문제).

## Decisions

### D1. 어댑터에 `fetchItemPhotos(ref)` 추가, `detail.ts`는 삭제
- **계약** (`src/lib/sources/types.ts`):
  ```ts
  interface PhotoLookupRef { courtCode: string; internalCaseNo: string }
  interface SourcePhoto { seq: number; base64: string }
  interface FetchItemPhotosResult { photos: SourcePhoto[]; requestsMade: number }
  fetchItemPhotos(ref: PhotoLookupRef): Promise<FetchItemPhotosResult>
  ```
  입력은 정규화 모델에 이미 있는 소스 중립 필드(`courtCode`, `internalCaseNo`)다. 사진은 base64 문자열로 돌려준다 — 이미지 바이트의 표준 텍스트 표현이라 소스 고유 형식이 아니고, 기존 저장 함수(`saveBase64Photo`)를 그대로 쓸 수 있다. `requestsMade`는 `pagesRequested`와 같은 이유(실행 메타데이터, 실측 요청 수)로 둔다.
- **구현**: 어댑터가 `DETAIL_PATH`로 `{csNo, cortOfcCd, dspslGdsSeq: "", pgmId: "PGJ15BM01"}`를 보낸다(NOTES §10.1, 빈 `dspslGdsSeq` CONFIRMED). 응답은 기존 `parseDetailResponse`(3단 검사)로 검증하고, `csPicLst`에서 `cortAuctnPicSeq`와 `picFile`이 모두 있는 항목만 돌려준다. 요청 함수·UA·세션은 검색과 같은 `request()`·`USER_AGENT`·`bootstrapSession()`을 쓴다.
- **세션**: 사진 요청은 어댑터 인스턴스 안에서 첫 호출 때 한 번 세션을 만들고 재사용한다. 사진 워커는 회차마다 어댑터를 새로 만들어 세션 수명을 회차 하나로 묶는다. 회차당 요청 수는 `부트스트랩 1 + 물건 수`다. 세션 없이도 되는지는 확인된 적이 없으므로 확인된 검색 경로와 같은 방식을 택한다.
- **`detail.ts` 삭제**: 근거 없는 엔드포인트, 브라우저가 아닌 UA, 차단 감지 부재로 그대로 둘 이유가 없다. 테스트(`detail.test.ts`)는 어댑터 사진 조회 테스트로 옮긴다.
- **대안**: 기존 `detail.ts`를 어댑터 안에서 감싸기만 하는 안 — 엔드포인트와 차단 감지 결함이 그대로 남아 기각.

### D2. 백오프 공유: `collector_state.backoff_until` 하나로 통일
- **키**: `COLLECTOR_STATE_KEYS.BACKOFF_UNTIL = "backoff_until"`. 다른 키(`collector.rotation.nextCourtCode`)와 이름 규칙이 다르지만, 기존 사진 워커가 이미 이 이름으로 쓴 행이 운영 DB에 있을 수 있어 그대로 읽히도록 맞춘다. 값은 UTC ISO 문자열이다.
- **함수** (`collector-state.ts`): `getBackoffUntil(): Date | null`(값이 없거나 파싱 불가면 null), `extendBackoffUntil(until: Date)` — 저장된 값보다 늦을 때만 쓴다(스펙: 짧아지지 않음). 읽기·비교·쓰기는 한 트랜잭션으로 묶는다(두 워커가 같은 DB 파일을 쓴다).
- **수집 워커**: `blockedUntil` 클로저 변수를 없앤다. `tick()`은 회차 시작 전 `getBackoffUntil()`을 읽어 미래면 `skipped(backoff)`를 기록하고 건너뛴다. 차단이면 `extendBackoffUntil(now + blockBackoffMs)`를 호출한다. 읽기가 실패하면(DB 오류) 로그를 남기고 백오프 없음으로 진행한다 — 로테이션 위치 조회와 같은 원칙이고, DB가 죽었다면 회차 기록도 실패하므로 백오프만 지켜 얻는 것이 없다.
- **사진 워커**: 회차 시작 전과 물건마다 요청 직전에 같은 값을 읽는다(수집기가 사진 회차 도중 차단을 기록할 수 있다). 소스 오류가 `SourceBlockedError`일 때만 `extendBackoffUntil`을 호출하고 회차를 `blocked`로 끝낸다. "HTTP" 문자열 규칙은 없앤다.
- **백오프 길이**: 기본값 `DEFAULT_BLOCK_BACKOFF_MS`(1시간, NOTES §6.1)를 `collector.ts`에서 공용 위치(`src/lib/domain`)로 옮겨 두 워커가 같은 값을 쓴다. 환경 변수는 기존 `AUCTIONBOSS_COLLECT_BACKOFF_MS`를 두 워커가 함께 읽는다 — 차단은 IP 단위라 워커마다 길이를 다르게 둘 이유가 없다.
- **대안**: 백오프 전용 테이블 — `collector_state`가 이미 "보관 상한에 걸리지 않는 운영 상태" 저장소라 새 테이블이 필요 없다.

### D3. 사진 워커: 수집 워커와 같은 상주·주기 구조, `--once` 지원
- **선택**: `startPhotoWorker(options)`가 `setInterval` + `running` 플래그 + `tick()`/`stop()` 핸들을 돌려준다(collector와 같은 모양). 엔트리포인트는 analyzer처럼 `--once`면 회차 하나만 돌리고 종료한다. 소스(`AuctionSource`), 저장 함수, 시계, sleep을 주입받아 테스트에서 가짜를 넣는다.
- **이유**: compose·K8s에서 1회 실행 스크립트를 주기 실행하려면 cron 사이드카나 CronJob이 필요한데, K8s CronJob은 별도 Pod라 SQLite RWO PVC를 web Pod와 같이 붙일 수 없다(D7). 상주 구조면 다른 워커와 같은 방식으로 배포·관측된다. 겹침 건너뜀도 lock 파일 없이 메모리 플래그로 해결된다(collector D4와 같은 근거).
- **설정** (`config/collector.json`의 `photos` 절, zod 검증, 환경 변수로 덮어쓰기):
  | 키 | 기본값 | 근거 |
  | --- | --- | --- |
  | `intervalMs` | 1,800,000 (30분) | 수집기가 10분마다 약 13요청을 쓴다. 차단 임계는 "5분에 15회 미만"에서도 걸린 적이 있다(NOTES §6.1). 사진은 같은 IP 예산을 나눠 쓰므로 수집보다 드물게 돈다 |
  | `maxItemsPerRun` | 5 | 회차당 요청 6회(부트스트랩 포함). 시간당 12회 추가. 물건 389건 기준 첫 적재 약 39시간 |
  | `requestDelayMs` | 30,000 | NOTES §10.6 "물건당 수십 초 간격". 기존 3초는 이 권고의 1/10 |
  | `retryAfterHours` | 24 | D4 |
- **회차 결과**: 스펙(run-observability "사진 워커 회차 기록")대로 차단 > 전부 실패 > 성공 순으로 정한다. `detail`은 `PhotosRunDetail { attempted, collected, empty, failed, requestsMade }`이고 `WorkerRunDetail` 유니온에 더한다. `itemsChanged`는 null이다.
- **상태 판정 주기**: `getWorkerStatus`의 기대 주기를 워커별 매핑(`collector → intervalMs`, `analyzer → analysis.intervalMs`, `photos → photos.intervalMs`)으로 바꾼다. `--once` 운용에서는 기대 주기가 의미 없지만, 운영 경로는 상주이므로 상주 주기를 기준으로 둔다.
- **대안**: 1회 실행 유지 + compose에서 `sh -c "while true; do npm run photos; sleep 1800; done"` — 겹침 방지·종료 신호 처리·상태 판정 주기를 따로 맞춰야 하고, K8s에서는 위의 PVC 문제가 남아 기각.

### D4. 실패 재시도: `photo_attempted_at` 컬럼 하나
- **선택**: `items.photo_attempted_at`(SQLite `TEXT`, MySQL `DATETIME(3)`, nullable)을 추가한다. 사진 워커는 시도한 물건마다 결과(`collected`·`empty`·`failed`)와 함께 이 값을 기록한다. 대기 물건 조회 조건은 다음으로 바꾼다.
  ```sql
  WHERE internal_case_no IS NOT NULL AND court_code IS NOT NULL
    AND ( photo_status IS NULL OR photo_status = 'uncollected'
          OR (photo_status = 'failed'
              AND (photo_attempted_at IS NULL OR photo_attempted_at <= @retryBefore)) )
  ORDER BY 미시도 먼저, 그다음 photo_attempted_at 오래된 순, id DESC
  ```
  `retryBefore = now - retryAfterHours`. 기존에 `failed`로 남은 행은 `photo_attempted_at`이 NULL이라 곧바로 재시도 대상이 된다(한 번은 다시 시도해 시각을 남긴다).
- **차단으로 중단된 물건**: 차단 오류를 받은 물건은 `failed`로 기록하지 않는다 — 물건의 문제가 아니라 IP 문제이므로 백오프 뒤 미시도 상태로 다시 시도해야 한다.
- **시도 횟수 상한을 두지 않는 이유**: 간격만으로 스펙의 "매 회차 재시도되어 대기열을 점유하지 않는다"를 만족한다. 영구 실패 물건의 비용은 물건당 하루 1요청이고, 미시도 물건이 항상 먼저 오므로 대기열을 막지 않는다. 상한을 두면 중단 상태를 표시·해제하는 규칙과 컬럼이 더 필요하다. 실패가 쌓이는지는 회차 기록의 `failed` 수치로 관측한다.
- **API 노출**: 새 컬럼은 `AuctionItem`과 `/api/items` 응답에 넣지 않는다 — Spring 계약 테스트(골든 JSON)가 깨지지 않게 하고, 화면 표시에 필요하지 않다.

### D5. MySQL은 Flyway `V2__item_photo_attempt.sql`로 같이 맞춘다
- **선택**: `ALTER TABLE items ADD COLUMN photo_attempted_at DATETIME(3) NULL;` 한 줄짜리 V2를 추가한다. Spring 코드(엔티티·API)는 바꾸지 않는다.
- **근거**: spring-backend 스펙이 "기존 SQLite 테이블과 같은 컬럼"을 SHALL로 요구한다. 지금 맞추지 않으면 4단계(수집 이식)·5단계(데이터 이전)에서 어떤 컬럼이 빠졌는지 다시 대조해야 한다. 쓰기 경로가 없으니 위험은 컬럼 추가뿐이고, nullable 추가는 시드 적재와 `ddl-auto=validate`(엔티티에 없는 DB 컬럼은 검사하지 않음)에 영향이 없다. V1은 이미 적용된 파일이라 고치면 checksum 불일치로 기동이 거부되므로 V2로 더한다.
- **검증**: `SchemaMigrationTest`에 V2 적용 후 `items.photo_attempted_at` 존재를 확인하는 단언을 더하고, `./gradlew check`(계약 테스트 포함)가 그대로 통과하는지 본다.
- **대안**: Spring은 4단계에서 한꺼번에 — 스펙 위반 상태가 길어지고 대조 비용이 뒤로 밀려 기각.

### D6. 표시 상태 `unavailable`은 저장하지 않고 파생한다
- **선택**: `PhotoDisplayState`에 `"unavailable"`을 더하고 메시지는 "사진 정보 없음(조회 불가)"로 한다. 판정 순서는 `collected`·`empty`(저장된 결과 우선) → 식별자 없음이면 `unavailable` → `failed` → `uncollected`.
- **이유**: DB `photo_status`에 새 값을 넣으면 MySQL `ck_items_photo_status` CHECK 제약도 바꿔야 하고, 나중에 재수집으로 식별자가 채워지면 상태를 되돌리는 규칙이 필요하다. 식별자 유무로 파생하면 둘 다 필요 없다. 옛 워커가 키 없는 물건에 남긴 `failed`도 자동으로 `unavailable`로 보인다.
- `failed` 메시지는 그대로 "사진 수집 실패 (재시도 대기)"로 둔다 — D4로 실제로 재시도되므로 문구가 사실이 된다.

### D7. 배포 설정
- **compose analyzer**: `AUCTIONBOSS_API_BASE=http://web:3000`, `ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}`, `AUCTIONBOSS_ANALYZE_MODEL=${AUCTIONBOSS_ANALYZE_MODEL:-}`. `${VAR:-}`는 mysql 서비스와 같은 이유(값이 없어도 compose 파일 전체 해석이 실패하지 않음)다. 빈 문자열 키는 `runClaude`의 `if (apiKey)`에서 거짓이라 CLI 모드로 간다. 이미지에 Claude CLI가 없으므로 컨테이너 analyzer는 사실상 API 키가 필요하다 — README에 적는다.
- **web 헬스체크**: `["CMD", "node", "-e", "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]`. Node 22에는 전역 `fetch`가 있다. 이미지에 curl을 설치하는 안보다 낫다고 본 이유: 이미지 레이어·패키지·취약점 표면이 늘지 않고, 헬스체크가 앱 런타임과 같은 실행 파일에만 의존한다. `start_period`를 더해 첫 빌드·기동 중 실패를 세지 않는다. collector·photos의 `depends_on`은 `condition: service_healthy`로 바꿔 web이 스키마를 만든 뒤 뜨게 한다.
- **compose photos**: `command: npm run photos`, `auctionboss-data` 볼륨, `AUCTIONBOSS_DB`. collector와 같은 모양이다.
- **K8s analyzer**: `BASE_URL` → `AUCTIONBOSS_API_BASE`. API 키는 이미 `secretRef`(`auctionboss-secret`)로 들어가므로 Secret 예시 주석에 `ANTHROPIC_API_KEY`를 적는다.
- **K8s photos**: `auctionboss-web-collector` Pod에 `photos` 컨테이너를 더한다. SQLite 파일과 사진 디렉터리(`/app/data/photos`)가 RWO PVC에 있어 같은 노드·같은 Pod에서만 안전하게 공유된다. 별도 Deployment는 PVC를 붙일 수 없거나(다른 노드) 잠금 위험이 있다. Deployment 이름은 바꾸지 않는다(롤아웃 시 PVC 재연결 혼란을 피함).
- **검증 방식**: compose와 K8s YAML을 파싱해 서비스·컨테이너별 환경 변수 이름과 헬스체크 명령을 단언하는 vitest 테스트를 둔다. 이름 불일치는 이 테스트로만 회귀를 막을 수 있다(런타임 오류가 아니라 조용히 localhost로 요청). `js-yaml`은 지금 eslint의 간접 의존성으로만 있으므로 직접 쓰려면 devDependency로 명시한다(간접 의존성에 기대면 eslint 업데이트로 조용히 사라질 수 있다). 실제 기동은 `docker compose config`와 수동 `docker compose up`으로 한 번 확인한다.

### D8. Claude API 기본 모델: `claude-opus-5-5`
- **선택**: `runClaudeViaApi`의 기본값을 상수 `DEFAULT_API_MODEL = "claude-opus-5-5"`로 둔다. `AUCTIONBOSS_ANALYZE_MODEL`이 있으면 그 값이 우선한다(현재 구조 유지). CLI 모드는 그대로 `--model`을 생략한다.
- **비용 비교** (2026-09 기준 1M 토큰당 입력/출력): Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Haiku 4.5 $1/$5. 회차당 신규 5건 + 재분석 2건, 10분 주기가 상한이다. 실제 분석량은 새 물건과 변경 건수에 비례하므로 상한보다 작다.
- **근거**: 분석 결과는 권리 리스크·입찰 판단처럼 틀리면 비용이 큰 판단이고, 소스에 권리관계 데이터가 없어(NOTES §10.3) 모델이 비고·서술에서 추론해야 하는 몫이 크다. 분석량이 적어 모델 단가 차이(Sonnet 5.5 대비 2배)가 절대 비용으로는 작다. 비용을 낮추려면 운영자가 `AUCTIONBOSS_ANALYZE_MODEL=claude-sonnet-5-5`로 바꾸면 되므로, 기본값은 품질 쪽에 두고 비용 선택은 설정으로 연다. README에 이 선택지를 적는다.
- **대안**: Sonnet 5.5 기본 — 비용은 절반이지만 위 판단 품질을 줄이는 결정을 코드 기본값으로 박는 셈이라 운영자 설정에 맡긴다. Haiku 4.5 — 긴 비고 추론에 부족하다고 본다. 모델 필수화(미설정 시 오류) — API 키만 넣으면 동작하던 현재 사용성이 깨진다.
- **호출 방식: 공식 SDK로 바꾼다.** 지금 `runClaudeViaApi`는 `fetch`로 Messages API를 직접 부른다. TypeScript 프로젝트에서는 공식 SDK(`@anthropic-ai/sdk`)를 쓰는 것이 Anthropic의 권장이다. SDK는 타입, 재시도(429·5xx·연결 오류), 타입이 있는 오류 클래스를 제공한다. 테스트 주입 지점은 `fetchFn` 대신 SDK 클라이언트(또는 그 `messages.create`)로 바꾼다.
- **thinking과 effort**: Opus 5.5는 thinking을 끌 수 없고(`{type: "disabled"}`는 400), 깊이는 `output_config.effort`로만 조절한다. 이 모델의 effort 기본값은 `medium`이므로 명시적으로 `medium`을 보낸다. 물건 1건 요약은 긴 추론이 필요한 작업이 아니어서 `medium`이면 충분하다고 보고, 필요하면 설정으로 올린다.
- **max_tokens와 stop_reason**: thinking 토큰도 `max_tokens` 안에 들어가므로 8,192에서 16,000(비스트리밍 권장값)으로 올린다. `stop_reason`이 `max_tokens`면 잘린 결과이므로 `ClaudeInvocationError`로 실패 처리한다. `refusal`(안전 분류기의 거절)도 실패로 처리하고 `stop_details.category`를 오류 메시지에 남긴다. 어느 경우든 잘못된 분석이 저장되지 않는다.
- **거절 시 대체 모델**: Opus 5.5 코드에는 서버 측 대체(`fallbacks: "default"`, 베타 `server-side-fallback-2026-07-01`)를 기본으로 켠다. 분류기가 거절하면 같은 호출 안에서 거절 범주에 맞는 다른 모델이 이어받는다. 경매 비고 요약은 거절될 일이 드물지만, 켜 두면 거절이 곧 분석 실패로 이어지지 않는다. 실제로 어느 모델이 답했는지는 응답의 `model`로 저장한다(기존 `analyses.model` 컬럼).

### D9. `align-specs-with-code`와의 관계: 겹치는 요구사항 없음
- align이 MODIFIED하는 요구사항: run-observability "실행 회차 기록"·"실행 상태 판정", auction-collection "수집 범위 설정", deployment-and-health "헬스체크 엔드포인트", auction-analysis "Claude 분석 실행" 등.
- 이 change가 건드리는 요구사항: run-observability "상태 화면"(MODIFIED)·"사진 워커 회차 기록"(ADDED), auction-collection "소스 어댑터 계약"·"수집 실패 처리"(MODIFIED), deployment-and-health "쿠버네티스 워크로드 구성"(MODIFIED)·"Docker Compose 구성"(ADDED), item-photos 전부(align이 건드리지 않음).
- 사진 워커 회차 기록은 align의 "실행 회차 기록" 문구("사진 워커도 ... 같은 기록 형식으로")를 바꾸지 않고 별도 ADDED 요구사항으로 세부(수치·결과 규칙·판정 주기)를 더했다. 기본 모델은 스펙이 아니라 구현 기본값이라 auction-analysis delta를 두지 않는다.
- 따라서 아카이브 순서에 의존하지 않는다. 다만 내용상 align이 먼저 아카이브되는 것을 권장한다(사진 워커가 회차를 기록한다는 일반 규칙이 메인 스펙에 먼저 들어가는 편이 읽기 쉽다). 둘 중 하나가 위 요구사항 목록을 바꾸면 이 절을 다시 확인한다.

## Risks / Trade-offs

- [두 워커의 요청이 같은 시간대에 몰려 IP 임계를 넘을 수 있다] → 사진 워커의 요청 밀도를 낮게(30분, 5건, 30초 간격) 잡고, 차단이 나면 공유 백오프로 둘 다 멈춘다. 회차 기록에 `requestsMade`를 남겨 실측으로 조정한다. 요청 시점 조율은 필요해지면 후속 change에서 한다.
- [사진 상세 엔드포인트가 세션 없이 거부하거나, 검색과 다른 차단 정책을 가질 수 있다] → 검색과 같은 세션·UA·3단 검사를 쓰고, 첫 운영 회차를 `--once`로 수동 실행해 결과를 NOTES에 기록한다(tasks 7장).
- [옛 사진 워커가 남긴 10분짜리 `backoff_until` 값] → 형식이 같아 그대로 읽히고, 이미 지난 시각이면 무시된다. 별도 정리가 필요 없다.
- [`collector_state` 읽기·쓰기가 두 프로세스에서 동시에 일어남] → SQLite WAL + 트랜잭션 안에서 비교 후 쓰기로 "짧아지지 않음"을 지킨다. 같은 Pod·같은 볼륨이라는 배포 전제는 D7이 유지한다.
- [Opus 5.5 기본값으로 API 비용이 Sonnet 대비 2배] → 분석량이 작고 설정으로 바꿀 수 있다. README에 비용 선택지를 적는다.
- [첫 적재가 하루 반 이상 걸린다] → 의도된 저속 수집이다. 화면은 '수집 대기 중'으로 정확히 표시된다.

## Migration Plan

1. 코드 배포 시 SQLite는 `client.ts` 보정이 `photo_attempted_at`을 추가한다(기존 행 NULL). MySQL은 다음 기동에서 Flyway V2가 적용된다.
2. 기존 `failed` 행은 `photo_attempted_at`이 NULL이라 다음 사진 회차에서 한 번 재시도된다.
3. compose는 `docker compose up -d --build`로 web·collector·photos·analyzer를 다시 만든다. K8s는 두 Deployment를 다시 적용한다.
4. 롤백: 이전 이미지로 되돌리면 새 컬럼은 무시되고(옛 코드는 읽지 않음), `backoff_until` 키는 옛 사진 워커가 그대로 읽는다. 컬럼은 지우지 않는다.

## Open Questions

- 사진 상세 엔드포인트의 세션 필요 여부와 실제 차단 임계. 첫 운영 회차 관측으로 답하고 NOTES에 기록한다. 결과와 무관하게 설계(세션 재사용, 공유 백오프)는 그대로다.
