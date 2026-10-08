## Context

- 동기와 범위는 proposal.md, 지켜야 할 동작은 `specs/spring-backend/spec.md`를 따른다.
- 1단계(`archive/2026-10-08-add-spring-mysql-backend/`)로 `backend/`에 엔티티 8개, 읽기 API 5개, 오류 응답(`{ error, details }`), 밀리초 3자리 `Z` 시각 직렬화, 주입된 `Clock`, `config/collector.json`을 읽는 설정(`AnalysisSettings`), 읽기 골든 90개와 `ContractTest`, SQL 문 수를 세는 `QueryCountTest`가 있다. 테스트는 TypeScript 791개, Java 215개다.
- 1-B(`fix-photo-worker-and-deploy-config`)로 `items.photo_attempted_at`(Flyway V2), 사진 워커 회차 형식 `PhotosRunDetail`, 워커 간 공유 백오프 키가 생겼다. 사진 워커는 회차를 저장소 함수로 직접 기록하며 HTTP를 쓰지 않는다.
- 옮길 Next 라우트와 동작
  | 라우트 | 저장소 동작 | 응답 |
  | --- | --- | --- |
  | `POST /api/analyses` | 물건 존재 확인 → INSERT(`analyzed_at`=지금) → 재조회 | 201 분석 / 400 / 404 |
  | `POST /api/worker-runs` | INSERT `running`(`started_at`=`created_at`=지금) → 워커별 보관 상한 정리 | 201 `{ id }` / 400 |
  | `PATCH /api/worker-runs/{id}` | UPDATE(`finished_at`=지금, `items_changed`=수집 형식의 `changed`) → 재조회 | 200 회차 / 400 / 404 |
  | `GET /api/worker-runs`, `/summary` | 최신순 목록, `GROUP BY outcome` 집계 | 200 / 400 |
  | `GET /api/bookmarks` | 건수 → id 페이지 → **물건마다 `getItemById`(N+1)** | 200 / 400 |
  | `POST /api/bookmarks` | 존재 확인 → `INSERT ... ON CONFLICT DO NOTHING` → 물건 조회 | 201 `{ item }` / 400 / 404 |
  | `DELETE /api/bookmarks/{itemId}` | 존재 확인 → DELETE | 200 `{ itemId, bookmarked: false }` / 404 |
  | `GET /api/feed` | 건수, 목록(`kind='change'`), 미확인 개수 | 200 / 400 |
  | `POST /api/feed/read` | `feed_reads` id=1 upsert(지금) → 미확인 개수 | 200 `{ lastReadAt, unreadCount }` |
  | `GET /api/photos/{itemId}/{seq}` | `parseInt` → 사진 기록 → 사진 디렉터리 안의 파일 | 200 바이트 / 400·404 텍스트 |
  | `POST /api/bookmarks/toggle`, `/api/feed/mark-read` | 폼 본문 → 위와 같은 저장소 함수 → `returnTo`로 303 | 화면 전용 |
- 본문 검증은 zod다. `z.object`는 모르는 키를 버리고, 타입을 바꿔 받지 않으며, 이슈 경로를 `field`로 쓰고 경로가 비면 `(root)`다. `request.json()`은 Content-Type을 보지 않는다.
- 분석 워커(`workers/analyzer.ts`)는 `GET /api/items?analyzed=false`, `GET /api/items?needsAnalysis=true&promptVersion=..`, `POST /api/worker-runs`, `POST /api/analyses`, `PATCH /api/worker-runs/{id}`만 부른다. 주소는 `AUCTIONBOSS_API_BASE`, Claude 호출은 `ANTHROPIC_API_KEY`가 있으면 SDK, 없으면 `AUCTIONBOSS_CLAUDE_BIN` CLI다. 회차 기록 실패는 로그만 남기고 분석을 계속한다.
- 운영 데이터는 SQLite에 있다. 운영 DB는 시드를 만든 뒤에도 바뀌었다(워커 회차 7→10행, 사진 0→16행). MySQL에는 시드만 있다.

## Goals / Non-Goals

**Goals:**
- Spring이 쓰기·나머지 API 11개를 Next와 같은 계약으로 제공하고, 요청 순서가 있는 시나리오 골든으로 기계적으로 증명한다.
- 개발 환경에서 분석 워커가 코드 변경 0줄, 환경 변수만으로 Spring에 분석과 회차를 저장하는 것을 1회 실행으로 확인한다.
- 관심 목록·피드 조회의 SQL 문 수를 행 수와 무관하게 고정한다.

**Non-Goals:**
- 운영 전환, 이중 쓰기, 데이터 이전(5단계).
- 화면 전용 폼 엔드포인트(3단계).
- 인증·사용자 구분(7단계), 수집기·사진 수집 워커 이식(4단계 이후).
- Next 쪽 동작 변경. Next의 N+1(`listBookmarkedItems`)도 이번에는 고치지 않는다. Next 경로는 5단계 뒤 은퇴한다.

## Decisions

### D1. 범위: JSON API 11개는 만들고, 폼 엔드포인트 2개는 3단계로 미룬다
- **만드는 것**: `POST /api/analyses`, `GET·POST /api/worker-runs`, `PATCH /api/worker-runs/{id}`, `GET /api/worker-runs/summary`, `GET·POST /api/bookmarks`, `DELETE /api/bookmarks/{itemId}`, `GET /api/feed`, `POST /api/feed/read`, `GET /api/photos/{itemId}/{seq}`. 읽기 5개와 합치면 Next의 JSON API 전부다.
- **미루는 것**: `POST /api/bookmarks/toggle`, `POST /api/feed/mark-read`.
- **근거**: 두 라우트는 클라이언트 JS 없는 화면의 `<form method="post">`를 받아 `returnTo`로 303 리다이렉트하는 화면 계층이다. 리다이렉트 대상은 화면을 서빙하는 오리진이고, 오픈 리다이렉트 검증(`safe-redirect.ts`)도 그 오리진 기준이다. 3단계에서도 화면은 Next가 서빙하므로, 폼은 Next 라우트가 받아 Spring JSON API(`POST /api/bookmarks`, `DELETE /api/bookmarks/{id}`, `POST /api/feed/read`)를 부른 뒤 리다이렉트하는 BFF가 맡는 것이 맞다. 비즈니스 로직은 이번에 만드는 JSON API 하나뿐이라 두 벌이 되지 않는다.
- **대안**: Spring에 폼 엔드포인트를 같이 만드는 안. Spring이 Next 화면의 경로 체계(`returnTo`)와 오리진을 알아야 하고, 3단계 설계(BFF 여부)를 지금 고정한다. 기각.

### D2. DB 소유권과 운영 전환 시점: 이번에는 전환하지 않고 개발 환경에서만 연결을 증명한다
- **선택**: 운영 분석 워커·화면·수집 워커는 그대로 Next + SQLite를 쓴다. compose와 K8s의 `AUCTIONBOSS_API_BASE` 기본값(`http://web:3000`, `http://auctionboss-service:3000`)을 바꾸지 않는다. 대신 (a) 쓰기 API를 같은 계약으로 만들고 시나리오 골든으로 증명하고, (b) 시드 MySQL + Spring 개발 환경에서 분석 워커를 주소만 바꿔 1회 실행해 분석이 MySQL에 저장되는 것을 확인한다(D11). 운영 전환은 5단계 데이터 이전과 함께 분석 워커·화면·수집 워커를 한 번에 옮긴다.
- **근거**: MySQL에는 실명을 가린 시드만 있다. 지금 운영 분석 워커만 Spring으로 돌리면 분석은 MySQL에, 화면과 수집은 SQLite에 있는 "두 DB" 상태가 된다. 분석 워커는 MySQL의 물건(시드 시점, 가린 비고)을 분석하고, 화면은 그 분석을 보지 못하며, 재분석 판정은 MySQL에 없는 운영 변경 이력을 모른다.
- **버린 대안 1 — 지금 전환 + 이중 쓰기**: 분석 결과를 SQLite와 MySQL 양쪽에 쓴다. 분석 워커는 서버 하나만 알므로 이중 쓰기는 Next나 Spring 한쪽이 다른 쪽을 부르는 서버 간 결합이 되고, 한쪽 실패 시 보정·재시도 규칙이 필요하다. 물건 원본이 SQLite에만 있어 MySQL 쪽 분석은 어차피 참조할 물건이 어긋난다. 5단계에서 버릴 코드를 만드는 일이라 기각.
- **버린 대안 2 — 지금 전환 + SQLite 은퇴 앞당기기**: 2단계에서 데이터 이전까지 한다. 화면(3단계)과 수집기(4단계)가 아직 SQLite를 직접 열기 때문에 이전 직후 둘 다 멈춘다. 순서를 깨므로 기각.
- **ROADMAP 2단계 완료 기준 해석**: "분석 워커 코드 변경 0줄로 Spring에 분석 결과가 저장된다"를 "개발 환경(시드 MySQL + Spring)에서 분석 워커 코드 변경 0줄, 환경 변수만 바꾼 1회 실행으로 분석 결과와 회차 기록이 Spring(MySQL)에 저장된다"로 읽는다. 코드 무수정이라는 핵심 검증은 운영 데이터 여부와 무관하게 성립한다. ROADMAP 문구는 마지막 장에서 이 해석대로 고치고, 운영 전환은 5단계 할 일에 명시한다.

### D3. 패키지와 계층
```
com.auctionboss
├── analysis/  AnalysisController(POST), AnalysisCommandService
├── worker/    WorkerRunController, WorkerRunService, WorkerRunQueryRepository(QueryDSL), WorkerRunPruner(네이티브), WorkerSettings
├── bookmark/  BookmarkController, FeedController, BookmarkService, FeedService, BookmarkWriteRepository(네이티브)
├── photo/     PhotoController, PhotoFileStore
└── common/    body/(JSON 본문 검증기), json/(JS 숫자 직렬화), time/(밀리초 now)
```
- 1단계의 기능별 패키지를 그대로 쓴다. 단순 조회·삽입은 Spring Data JPA, 동적 목록은 QueryDSL, MySQL 방언이 필요한 세 곳(D6)만 `JdbcTemplate` 네이티브 SQL이다.
- `WorkerSettings`는 `AnalysisSettings`처럼 `config/collector.json`의 `observability.maxRunsPerWorker`를 호출마다 읽는다. 테스트용 덮어쓰기 속성을 둔다.

### D4. 요청 검증: 원시 본문을 직접 해석하는 검증기
- **선택**: 컨트롤러는 본문을 `String`으로 받아 `JsonMapper.readTree`로 해석하고, 엔드포인트별 검증기가 zod 스키마와 같은 순서로 필드를 검사해 `{ field, message }` 목록을 만든다. 해석 실패는 `JSON 본문을 해석할 수 없습니다`, 루트가 객체가 아니면 `(root)`. 정수 검사는 JS 규칙(`1.0`은 정수, `"1"`은 거절)을 따른다. 모르는 키는 읽지 않는다.
- `consumes`를 지정하지 않아 Content-Type과 무관하게 받는다(`request.json()`과 같음). 빈 본문의 `POST /api/feed/read`는 본문을 읽지 않는다.
- 오류 문구(`잘못된 분석 결과 본문입니다`, `잘못된 회차 시작 본문입니다`, `잘못된 회차 종료 본문입니다`, `잘못된 관심 등록 본문입니다`, `잘못된 요청 파라미터입니다`)와 500 문구는 Next 라우트의 값을 그대로 쓴다.
- `PATCH` 본문의 `detail`은 zod 유니온처럼 수집 형식 → 분석 형식 순으로 맞춰 보고, 처음 맞는 형식의 필드만 남긴 객체를 만든다. 둘 다 안 맞으면 400(`field`는 zod 유니온 이슈와 같은 `detail`). 사진 형식(`PhotosRunDetail`)은 Next PATCH도 받지 않으므로 받지 않는다.
- 쿼리 파라미터는 `feed-query.ts`, `worker-run-query.ts`를 옮긴 Java 파서 두 개로 검증한다(1단계 `ItemQueryParser`와 같은 방식). 인식한 파라미터가 빈 값이면 이슈다.
- `summary`의 `since`: 원본은 JS `new Date()`로 검증하고 SQLite에서 문자열로 비교한다. Spring은 ISO-8601 날짜(`2026-10-01`)와 날짜·시각(`Z` 또는 오프셋)만 받아 `Instant`로 비교한다. 정규 형식(`...T..:..:..mmmZ`, 날짜만)에서는 두 결과가 같고 골든이 이것을 확인한다. JS만 받는 비 ISO 문자열(`Oct 1 2026` 등)은 Spring에서 400이고, 오프셋 문자열은 원본의 문자열 비교보다 Spring이 정확하다. 호출자는 상태 화면 하나이고 항상 `toISOString()`을 보낸다. 이 축소를 의도된 차이로 남긴다.
- **대안**: `@RequestBody` record + Bean Validation. Jackson의 타입 강제 변환(`"1"`→1), 415 응답, 필드 순서 보장 부재, `(root)` 표현 불가로 계약을 맞추려면 예외 처리기에서 다시 고쳐야 한다. 기각.

### D5. 서버 시각과 JSON 숫자
- **시각**: 쓰기에 쓰는 "지금"은 주입된 `Clock`에서 한 요청당 한 번 읽고 밀리초로 자른다. `DATETIME(3)`이 마이크로초를 반올림·절삭하므로 자르지 않으면 응답 값과 저장 값이 달라진다. 회차 시작의 `started_at`과 `created_at`, 읽음 처리의 저장 값과 응답 `lastReadAt`은 같은 값이다(원본과 같음).
- **숫자**: 원본은 JS `JSON.stringify`라서 정수 값의 실수(`successRate` 1, `detail`의 `3.0`)를 `1`, `3`으로 쓴다. Spring은 `successRate`(Double)와 `detail` 값에 "정수 값이면 정수로 쓰는" 직렬화를 적용한다. `detail`은 검증기가 만든 정규화된 JSON 문자열로 저장해 MySQL `JSON` 컬럼의 숫자 표현(`3.0`)에 기대지 않는다. MySQL이 키 순서를 바꾸는 것은 계약 비교가 키 순서를 보지 않으므로 상관없다.

### D6. 트랜잭션 경계와 MySQL 방언
| 동작 | 트랜잭션 | SQL |
| --- | --- | --- |
| 분석 저장 | 쓰기 1개 | `SELECT id FROM items WHERE id=?` → JPA 저장 → 그 엔티티로 응답. FK 위반이 나면(확인과 삽입 사이에 물건이 지워진 경우) 404로 바꾼다 |
| 회차 시작 | 쓰기 1개 | INSERT → 보관 상한 정리(아래) |
| 회차 종료 | 쓰기 1개 | UPDATE → 영향 0행이면 404 → 재조회 |
| 관심 등록 | 쓰기 1개 | 존재 확인 → `INSERT INTO bookmarks (item_id, created_at) VALUES (?, ?) ON DUPLICATE KEY UPDATE item_id = item_id` → 응답용 물건 조회 |
| 관심 해제 | 쓰기 1개 | 존재 확인 → `DELETE FROM bookmarks WHERE item_id=?` |
| 읽음 처리 | 쓰기 1개 | `INSERT INTO feed_reads (id, last_read_at) VALUES (1, ?) AS new ON DUPLICATE KEY UPDATE last_read_at = new.last_read_at` → 미확인 개수 |
| 목록·피드·집계·사진 | `readOnly` | |
- **보관 상한 정리**: 원본 `DELETE ... WHERE id NOT IN (SELECT id ... ORDER BY ... LIMIT @max)`는 MySQL에서 두 가지로 막힌다. `IN` 서브쿼리의 `LIMIT`은 지원되지 않고(ER 1235), 삭제 대상 테이블을 서브쿼리에서 읽을 수 없다(ER 1093). 그래서 두 문장으로 바꾼다. ① 경계 행: `SELECT started_at, id FROM worker_runs WHERE worker=? ORDER BY started_at DESC, id DESC LIMIT 1 OFFSET ?(max)`. ② 있으면 `DELETE FROM worker_runs WHERE worker=? AND (started_at < ? OR (started_at = ? AND id <= ?))`. 원본과 같은 순서 기준(`started_at DESC, id DESC`)으로 같은 행을 지우고, `(worker, started_at DESC)` 인덱스를 탄다.
  - 버린 대안: 서브쿼리를 파생 테이블로 한 번 더 감싸 ER 1093을 피하는 안(매 회차 최대 1,000개 id를 물질화), 보존할 id 목록을 앱으로 읽어 `NOT IN`으로 바인딩하는 안(바인딩 1,000개).
- **관심 등록 방언**: `ON DUPLICATE KEY UPDATE item_id = item_id`는 원본 `ON CONFLICT DO NOTHING`처럼 처음 담은 시각을 보존한다. `INSERT IGNORE`는 FK·CHECK 위반까지 경고로 삼키므로 버린다. JPA `existsById` + `save`는 동시 요청에서 중복 키 예외가 나므로 버린다.
- **읽음 처리 방언**: 행 별칭 문법(MySQL 8.0.19+)을 쓴다. `VALUES()` 함수는 8.0.20부터 폐기 예정이다. `CHECK (id = 1)`이 단일 행을 이중으로 강제한다.
- **동시성**: 격리 수준은 InnoDB 기본(REPEATABLE READ)이다. 같은 워커의 회차 시작이 겹치면 두 정리가 같은 경계 이하만 지우므로 결과가 같다. 범위 삭제의 next-key 잠금으로 교착이 나면 그 요청은 500이 되고, 분석 워커는 기록 실패를 로그로 남기고 분석을 계속한다(기존 동작, run-observability "회차 기록이 워커 동작을 방해하지 않음"). 분석 워커는 회차가 겹치지 않게 돌고, 이 단계에서 MySQL에 쓰는 다른 워커는 없다.

### D7. 조회 SQL 수와 N+1
- **관심 목록**: 건수 1 + 목록 1. `bookmarks`와 `items`를 조인하고 1단계 목록 행 식(`lastChangedAt`·`bookmarked` 스칼라 서브쿼리)을 재사용해 `ORDER BY b.created_at DESC, b.item_id DESC`로 한 번에 읽는다. 응답 `item`은 상세 API의 `item`과 같은 DTO다. 원본의 물건별 조회(N+1)는 따라 하지 않는다.
- **피드**: 건수 1 + 목록 1 + 미확인 개수 1. 미확인 개수는 `last_read_at`을 스칼라 서브쿼리로 넣어 한 문장이다.
- **회차 목록** 2(건수 + 목록), **집계** 1(`GROUP BY outcome`).
- `QueryCountTest`에 관심 목록과 피드를 더해 행 4건과 30건에서 같은 수인지 확인한다. 시드 기준 `EXPLAIN`을 기록한다. 피드는 `item_changes (item_id, changed_at DESC)` 인덱스와 `bookmarks` PK로 조인하며, 이 규모에서 인덱스를 새로 만들지 않는다. 느리면 측정 후 V3 마이그레이션으로 더한다.

### D8. 사진 파일
- 사진 디렉터리는 `auctionboss.photos.dir` 설정이다. 기록된 `file_path`(상대 또는 절대)를 정규화한 뒤 `Path.startsWith(root)`로 확인한다. 원본의 문자열 `startsWith`는 `/data/photos2/...`도 통과시키지만 Spring은 경로 구성요소로 비교해 더 엄격하다. 공격 경로에서만 갈리는 의도된 차이다.
- `itemId`·`seq`는 JS `parseInt`처럼 앞쪽 정수만 읽는다(`12abc`→12, `abc`→400). 오류 본문은 `text/plain` 문자열 `Invalid ID`, `Not Found`, `File Not Found`이다.
- 개발 compose의 MySQL에는 사진 기록이 없어 항상 404다. 운영 사진 볼륨 연결은 5단계에서 한다.

### D9. 인증과 노출
- 이번에도 인증을 넣지 않는다(7단계). bookmarks 스펙 "단일 사용자 전제"와 같은 상태이며, Next 쓰기 API도 인증이 없다.
- 결과적으로 Spring의 쓰기 API 6개(분석 저장, 회차 시작·종료, 관심 등록·해제, 읽음 처리)는 누구나 호출할 수 있다. 현재 compose는 Spring 포트를 `127.0.0.1:8080`에만 열어 같은 머신 밖에서는 닿지 않는다. 이 포트를 외부에 열거나 K8s 서비스로 노출하는 변경은 7단계 전에는 하지 않는다. README·REFERENCE에 이 사실을 적는다.
- CORS 설정을 두지 않아 브라우저의 교차 출처 호출은 기본 차단된다. 쿠키 세션이 없어 CSRF 대상도 없다.

### D10. 시나리오 골든
- **기반 데이터**: 새 스크립트 `scripts/seed/seed-to-sqlite.ts`가 커밋된 시드 SQL(`backend/src/main/resources/db/seed/*.sql`)을 임시 SQLite에 적재한다. 스키마는 Next 자신의 스키마 생성 코드(`getDb`)로 만든다. MySQL 리터럴(백슬래시 이스케이프, `'YYYY-MM-DD HH:MM:SS.mmm'`)은 `sql.ts`의 역변환으로 되돌린다. 운영 DB를 읽지 않으므로 운영 DB가 시드 이후 바뀐 것(회차 10행, 사진 16행)에 흔들리지 않고, 실명 처리 경로도 없다. 역변환은 "원본 행 → SQL → 역적재 → 같은 행" 왕복 테스트로 고정한다.
- **생성**: `scripts/seed/generate-scenarios.ts`가 시나리오마다 기반 SQLite의 새 복사본을 만들고, 기존 Next 라우트 핸들러를 단계 순서대로 직접 호출해 `backend/src/test/resources/contracts/scenarios/{이름}.json`에 저장한다. 형식은 `{ clock: { start, stepMs }, config, steps: [{ request: { method, path, query, body }, status, body | text | photo, capture }] }`이다. `capture`는 응답 값(예: `$.id`)을 변수로 받아 뒤 단계 경로(`/api/worker-runs/{run1}`)에 넣는다. 기존 읽기 골든 90개와 `generate-contracts.ts`는 건드리지 않는다.
- **시각 규칙(고정 시계)**: 단계 i의 서버 시각은 `T0 + i × 1초`, `T0 = 2026-10-08T00:00:00.000Z`(시드의 모든 시각보다 뒤)다. 생성기는 핸들러를 부르는 동안 전역 `Date`를 그 시각에 고정한 대체로 바꾼다(`new Date()`와 `Date.now()`만 고정, 인자 있는 생성은 원래대로). Spring 시나리오 테스트는 테스트용 `MutableClock`을 같은 값으로 맞춘 뒤 요청한다. 그래서 `analyzedAt`, `startedAt`, `finishedAt`, `bookmarkedAt`, `lastReadAt`까지 엄격 비교하고, 1초 간격이라 관심 목록 순서도 결정적이다. 재분석 간격도 같은 시각 기준이 되어 1단계에서 뺐던 `needsAnalysis=true`를 분석 시나리오에서 비교한다. 재분석 간격과 보관 상한은 두 쪽 모두 `config/collector.json`에서 읽는다. 시나리오가 다른 값이 필요하면 골든의 `config`(예: `{ "maxRunsPerWorker": 3 }`)에 적고, 생성기는 그 값을 반영한 임시 설정 파일을 `AUCTIONBOSS_CONFIG`로, Spring 테스트는 같은 값을 설정 덮어쓰기 속성으로 준다.
- **결정성 검사와 형식 비교 예외**: 생성기는 전체를 두 번 만들어 바이트 단위로 같은지 확인한다. 고정 시계로 잡히지 않는 시각 값이 있으면 그 값을 `"<iso-ms>"` 표식으로 바꾸고, Spring 쪽은 그 위치를 `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$` 형식으로만 비교한다. 생성기는 표식 수를 출력하며 목표는 0이다.
- **id 결정성**: 생성되는 id(분석, 회차)는 시드 최대 id 다음 값이어야 같다. SQLite는 명시 id 적재로 `sqlite_sequence`가 최대값이 된다. Spring은 시나리오마다 쓰기 대상 테이블을 비우고 시드를 다시 적재한 뒤 `ALTER TABLE ... AUTO_INCREMENT = 1`(InnoDB가 최대값+1로 올림)을 실행한다. 삭제만으로는 MySQL 8의 영속 카운터가 되돌아가지 않기 때문이다.
- **비교 규칙**: 2xx는 1단계 `ContractTest.diff`(키 순서 무시, 배열 순서·숫자 종류 비교)로 엄격 비교, 400은 `error`와 `details[].field`(순서 포함), 404는 `error`. 사진 200은 상태, `Content-Type`, `Cache-Control`, 본문 SHA-256. 텍스트 오류는 상태와 본문 문자열.
- **사진 픽스처**: 작은 PNG·JPEG 파일을 `backend/src/test/resources/contracts/photos/`에 두고, 생성기와 Spring 테스트가 같은 `item_photos` 행(정상 2건, 파일 없음 1건, 디렉터리 밖 경로 1건)을 넣는다.
- **시나리오 목록**
  | 이름 | 단계 |
  | --- | --- |
  | `worker-runs-lifecycle` | 분석 회차 시작 → 분석 수치로 종료 → 수집 회차 시작 → `changed` 포함 종료 → 목록(전체, `worker`·`outcome` 필터, 페이지) → 집계(전체, `worker`, `since` 날짜·시각) |
  | `worker-runs-errors` | 잘못된 `worker` → 없는 id·숫자 아닌 id 종료 → 잘못된 `outcome`·`detail`·빈 `errorKind` → 모르는 키가 섞인 `detail` 종료 후 응답 → 잘못된 목록·집계 파라미터 |
  | `worker-runs-prune` | `config.maxRunsPerWorker`를 시드의 해당 워커 회차 수보다 작게 두고 같은 워커 회차를 2번 시작 → 목록에서 오래된 것부터 빠졌는지와 다른 워커 회차 유지 |
  | `bookmarks-feed` | 빈 관심 목록 → 변경 이력 있는 물건 2개 등록 → 중복 등록 → 관심 목록 → 물건 목록 `bookmarked=true` → 피드(전체, `sinceBookmarkedAt=true`) → 읽음 → 피드 → 해제 → 관심 목록·피드 |
  | `bookmarks-errors` | 없는 물건 등록·해제 → 숫자 아닌 id 해제 → 잘못된 본문(문자열 id, 0, 해석 불가) → 잘못된 페이지 파라미터 → 관심 목록 불변 확인 |
  | `analyses` | 분석 저장(모델 있음·없음) → 상세의 최신 분석 → `analyzed=true` 목록 → `needsAnalysis=true` 목록 → 없는 물건 404 → 잘못된 본문들 → `analyzed=true` 건수 불변 |
  | `photos` | 정상 사진 2건 → 기록 없는 순번 → 파일 없음 → 디렉터리 밖 경로 → `abc` id → `12abc` id |
- **Spring 테스트**: `ScenarioContractTest`가 시나리오 파일마다 `DynamicTest` 하나를 만들고 단계를 순서대로 재생한다. 실패 메시지에 시나리오·단계 번호·첫 차이 경로를 남긴다.
- **대안**: 요청 단위 골든에 상태 준비 SQL을 붙이는 안. 상태 준비가 Next 동작과 따로 놀아 "같은 순서의 요청이 같은 상태를 만든다"를 증명하지 못한다. 시각 필드만 형식 비교하는 안은 `bookmarkedAt` 순서나 재분석 간격처럼 시각이 결과를 바꾸는 경우를 못 잡는다. 둘 다 기각.

### D11. 분석 워커 무수정 연결 검증(개발 환경)
- **가짜 CLI**: `scripts/dev/fake-claude`가 `claude -p --output-format json`과 같은 형식의 고정 JSON(본문에 "개발 검증용 가짜 분석" 표시, 모델 `fake-claude`)을 출력한다. 분석 워커는 `ANTHROPIC_API_KEY`가 없을 때 `AUCTIONBOSS_CLAUDE_BIN`의 실행 파일을 쓰므로 워커 코드를 고치지 않고 대체된다. 출력이 분석 워커의 파서를 통과하는지 vitest로 고정한다.
- **절차**(`scripts/dev/verify-analyzer-on-spring.sh`로 남김): ① `docker compose up -d mysql backend`(`local,seed`) ② 실행 전 `analyses`·`worker_runs` 건수 기록 ③ `env -u ANTHROPIC_API_KEY AUCTIONBOSS_API_BASE=http://localhost:8080 AUCTIONBOSS_CLAUDE_BIN=scripts/dev/fake-claude AUCTIONBOSS_ANALYZE_MAX=2 AUCTIONBOSS_ANALYZE_REANALYZE_MAX=1 npm run analyzer -- --once` ④ MySQL에서 새 분석 행(모델 `fake-claude`)과 `analyzer` 성공 회차·`detail` 확인, `GET /api/items/{id}`에서 최신 분석 확인 ⑤ `git diff --stat <change 시작 커밋> -- workers/`가 비어 있음을 확인.
- `ANTHROPIC_API_KEY`를 반드시 비운다. 남아 있으면 SDK 경로로 실제 API를 호출한다. 스크립트는 키가 설정돼 있으면 비우고 시작한다는 사실을 출력한다(값은 출력하지 않는다).
- 실행 결과(건수 변화, 회차 수치, 소요 시간)를 `docs/DEVELOPMENT_NOTES.md`에 남긴다. CI에는 넣지 않는다. Docker·Node·JDK를 한 잡에 묶어야 하고, 같은 계약은 시나리오 골든이 매 CI에서 지킨다.

## Risks / Trade-offs

- [Next와 Spring의 미세한 계약 차이(숫자 표현, 시각 자릿수, 필드 순서)가 분석 워커 zod 검증을 깨뜨림] → 시나리오 골든 엄격 비교와 D11 실제 실행이 둘 다 잡는다. 분석 워커가 받는 응답(`{ id }`, 목록)은 1단계 골든과 이번 골든에 모두 있다.
- [고정 시계 대체가 Next 내부의 다른 `Date` 사용까지 바꿔 골든이 실제 동작과 달라짐] → 인자 없는 생성과 `Date.now()`만 고정하고, 결정성 검사(두 번 생성)와 표식 수 출력으로 확인한다.
- [시드 SQL 역적재가 원본 SQLite와 미세하게 다름] → 왕복 테스트로 고정하고, 역적재 DB로 1단계 읽기 골든 중 일부를 다시 만들어 기존 골든과 같은지 확인한다.
- [보관 상한 정리의 범위 삭제가 동시 시작과 교착] → 분석 워커는 회차를 겹쳐 돌지 않고, 실패해도 분석은 계속된다(D6). 교착 재시도는 넣지 않는다.
- [쓰기 API가 인증 없이 열림] → 루프백 포트 유지, 외부 노출 금지를 문서화(D9). 7단계에서 인증.
- [두 백엔드의 쓰기 경로가 공존] → 운영 쓰기는 SQLite 하나뿐이고, MySQL 쓰기는 개발·테스트에서만 일어난다. 5단계 전까지 MySQL 데이터는 버려도 되는 데이터다.
- [`since`의 허용 형식 축소] → 호출자가 상태 화면 하나이고 ISO만 보낸다. 의도된 차이로 기록(D4).

## Migration Plan

1. 이 change는 Spring에 엔드포인트를 더하기만 한다. Next 앱, 워커, SQLite, compose·K8s의 운영 주소는 그대로다. Flyway 마이그레이션도 추가하지 않는다(필요한 테이블은 V1에 있다).
2. 머지 → CI(TS 잡, Java 잡) 통과 → 개발 환경에서 D11 절차 1회 실행과 기록.
3. 롤백: `backend/`의 새 패키지·테스트·골든과 `scripts/seed/generate-scenarios.ts`, `seed-to-sqlite.ts`, `scripts/dev/`를 되돌리면 끝난다. 운영 데이터에 영향이 없다.
4. 운영 전환은 5단계에서 데이터 이전과 함께 분석 워커(`AUCTIONBOSS_API_BASE`), 화면(3단계 결과), 수집 워커를 한 번에 옮긴다.
