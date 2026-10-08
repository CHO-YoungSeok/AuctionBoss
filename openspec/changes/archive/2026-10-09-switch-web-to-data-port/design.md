## Context

- 동기와 범위는 proposal.md, 지켜야 할 동작은 `specs/web-data-port/spec.md`와 `specs/spring-backend/spec.md`를 따른다.
- 1단계(`archive/2026-10-08-add-spring-mysql-backend/`)와 2단계(`add-spring-write-api/`, 마무리 중)로 Spring에 JSON API 16개, 읽기 골든 90개(`ContractTest`), 시나리오 골든 7개·115단계(`ScenarioContractTest`), 시드 SQL을 임시 SQLite에 적재하는 `scripts/seed/seed-to-sqlite.ts`, 고정 시계 `scripts/seed/fixed-clock.ts`, Spring 테스트용 `MutableClock`이 있다.
- 화면 코드의 데이터 접근(코드로 확인한 전부)

  | 위치 | `@/lib/db` 호출(인자) | 반환 | Spring에 있는가 |
  | --- | --- | --- | --- |
  | `/` (`src/app/page.tsx`) | `getRepository().listUsageTypes()` | `string[]` | 있음 `GET /api/items/usage-types` |
  | | `.listSidoValues()`, `.listSigunguValues()`, `.listCourtValues()` | `string[]` ×3 | **없음** |
  | | `.listItems(query)` (화면 조건) | `{ items, total, page, pageSize }` | 있음 `GET /api/items` |
  | | `.listItems({ pageSize: 1 })`, `.listItems({ analyzed: true, pageSize: 1 })` | `total`만 사용 | 있음 |
  | | `getUnreadCount()` | `number` | 있음 `GET /api/feed`의 `unreadCount` |
  | | `getWorkerStatus("collector", { now })` | `{ state, lastSuccessAt, lastRun }` | **없음** |
  | `/items/{id}` | `.getItemById(id)` | `AuctionItem \| null` | 있음 `GET /api/items/{id}`의 `item` |
  | | `.countAnalyses(id)`, `.listAnalyses(id, { limit: 11 })` | `number`, `Analysis[]` | **없음**(상세는 최신 1건만) |
  | | `.listItemChanges(id)` | `ItemChange[]` | 있음 `GET /api/items/{id}/changes` |
  | | `.getItemPhotos(id)` (사진 상태가 `collected`일 때만) | `ItemPhoto[]` | **없음**(파일 API만 있음) |
  | | `getUnreadCount()` | `number` | 있음 |
  | `/bookmarks` | `listBookmarkedItems({ page })`, `getUnreadCount()` | `{ items, total, page, pageSize }`, `number` | 있음 `GET /api/bookmarks` |
  | `/feed` | `listFeed({ page })`, `getUnreadCount()` | `{ entries, total, page, pageSize }`, `number` | 있음 `GET /api/feed` |
  | `/status` | 워커 3개마다 `getWorkerStatus(w, { now })`, `summarizeRuns({ worker, since })`, `listWorkerRuns({ worker, pageSize: 20 })` | 상태, 집계, 회차 목록 | 상태 **없음**, 나머지 있음 |
  | | `getCollectorState(ROTATION_NEXT_COURT_CODE)` | `string \| null` | **없음** |
  | | `getUnreadCount()` | `number` | 있음 |
  | `POST /api/bookmarks/toggle` | `addBookmark(id)`, `removeBookmark(id)`, `ItemNotFoundError` | — | 있음 `POST /api/bookmarks`, `DELETE /api/bookmarks/{id}` |
  | `POST /api/feed/mark-read` | `markFeedRead(new Date().toISOString())` | — | 있음 `POST /api/feed/read` |
  | `GET /api/photos/{itemId}/{seq}` | `getItemPhotos(id)`(`@/lib/db/repository`), `readPhotoFile`(`@/lib/storage/photos`) | 바이트 | 있음 `GET /api/photos/{itemId}/{seq}` |

  `/status`는 `loadCollectorConfig()`로 `config/collector.json`도 읽는다. 데이터베이스가 아니라 설정 파일이라 포트 대상이 아니다. `layout.tsx`, `_components`, `_lib`는 데이터베이스를 쓰지 않는다(테스트 `analysis-freshness.integration.test.ts`만 쓴다).
- 사진 `<img src>`는 Next의 `/api/photos/...`를 가리킨다. 브라우저는 루프백 Spring에 닿지 않으므로 이 라우트도 화면 경로다.
- 페이지 4개는 `async`이고 `/status`만 동기다. `/status`는 하위 컴포넌트(`WorkerStatusCard`, `RotationInfo`)가 안에서 저장소를 부른다. 렌더 테스트는 임시 SQLite에 저장소 함수로 데이터를 넣고 `renderToStaticMarkup`으로 HTML을 본다(목록 4개, 상세 8개, 상태 2개).
- 운영 데이터는 SQLite에 있고 수집 워커가 계속 쓴다. MySQL에는 1단계 시드만 있다. 시드에는 관심·읽음·사진 행이 없다.

## Goals / Non-Goals

**Goals:**
- 화면 코드에서 SQLite 접근을 데이터 포트의 SQLite 구현체 한 곳으로 모으고 린트로 지킨다.
- Spring 구현체로 같은 화면이 나오는 것을 포트 계약 테스트, 두 구현체 렌더 테스트, 개발 환경 비교 캡처로 증명한다.
- 화면 하나가 Spring에 보내는 요청 수를 상수로 고정한다.

**Non-Goals:**
- 운영 전환, 기존 Next JSON API 은퇴(5단계).
- 화면 HTML·문구·디자인 변경, 클라이언트 JS 도입.
- 화면 응답 캐시. 화면은 `force-dynamic` 그대로이고 요청마다 원천을 읽는다.
- `/api/health`의 원천 전환. 헬스체크는 웹 앱 자신의 SQLite를 계속 본다(5단계에서 다시 정한다).

## Decisions

### D1. 데이터 포트: 화면 단위가 아니라 데이터 단위 인터페이스 하나, 구현체 두 개
- **선택**: `src/lib/data-port/`에 `DataPort` 인터페이스 하나를 둔다. 모든 메서드는 `Promise`를 돌려준다(SQLite 구현체도 감싸서 돌려준다). 반환 타입은 지금 화면이 받는 `@/lib/domain` 타입 그대로다.
  ```
  src/lib/data-port/
  ├── port.ts            DataPort, PhotoFile, DataSourceError, ItemNotFoundError 재수출
  ├── index.ts           getDataPort() — 원천 선택(D2), 테스트용 setDataPortForTesting()
  ├── sqlite.ts          createSqlitePort(db?) — 기존 저장소 함수를 감쌈 (SQLite 접근 유일 지점)
  └── spring/
      ├── client.ts      fetch 래퍼(기본 주소, 시간 제한, 오류 변환, 요청 기록 훅)
      ├── schemas.ts     응답 zod 스키마 (도메인 타입과 컴파일 타임 일치 검사)
      └── port.ts        createSpringPort({ baseUrl, fetch? })
  ```
- **메서드(읽기 13, 쓰기 3, 파일 1)**

  | 메서드 | SQLite 구현 | Spring 구현 |
  | --- | --- | --- |
  | `listItems(query)` | `listItems(query)` | `GET /api/items?…` |
  | `getItemById(id)` | `getItemById` | `GET /api/items/{id}` → `item`, 404 → `null` |
  | `listFilterOptions()` | 용도·시도·시군구·법원 4개 | `GET /api/items/filter-options` (신규) |
  | `getAnalysisHistory(id, { limit })` | `listAnalyses` + `countAnalyses` | `GET /api/items/{id}/analyses?limit=` (신규) |
  | `listItemChanges(id)` | `listItemChanges` | `GET /api/items/{id}/changes` |
  | `listItemPhotos(id)` | `getItemPhotos`에서 `filePath` 제거 | `GET /api/items/{id}/photos` (신규) |
  | `getUnreadCount()` | `getUnreadCount` | `GET /api/feed?pageSize=1` → `unreadCount` |
  | `listBookmarkedItems({ page })` | 그대로 | `GET /api/bookmarks?page=` |
  | `listFeed({ page })` | 그대로 | `GET /api/feed?page=` |
  | `getWorkerStatus(worker)` | `getWorkerStatus(worker)` | `GET /api/worker-runs/status?worker=` (신규) |
  | `summarizeRuns({ worker, since })` | 그대로 | `GET /api/worker-runs/summary?…` |
  | `listWorkerRuns({ worker, pageSize })` | 그대로 | `GET /api/worker-runs?…` |
  | `getRotationNextCourtCode()` | `getCollectorState(ROTATION_NEXT_COURT_CODE)` | `GET /api/collector-state/rotation` (신규) |
  | `addBookmark(id)` / `removeBookmark(id)` | 그대로 | `POST /api/bookmarks` / `DELETE /api/bookmarks/{id}`, 404 → `ItemNotFoundError` |
  | `markFeedRead()` | `markFeedRead()` (시각은 저장소 기본값) | `POST /api/feed/read` (시각은 Spring Clock) |
  | `getPhotoFile(id, seq)` | `getItemPhotos` + `readPhotoFile` | `GET /api/photos/{id}/{seq}`의 상태·바이트·헤더 |
- **분석 이력을 메서드 하나로 합친 이유**: 화면은 "최근 11건과 전체 건수"를 항상 같이 쓴다. 둘로 나누면 Spring 요청이 하나 늘 뿐 얻는 것이 없다. 다른 메서드는 저장소 함수와 1:1이라 SQLite 구현체가 얇다.
- **`getWorkerStatus`에서 `now` 인자를 뺀다**: 판정의 "지금"은 데이터를 가진 쪽의 서버 시각이다. Spring은 주입된 `Clock`, SQLite 구현체는 저장소 기본값(`new Date()`)을 쓴다. Next와 Spring은 같은 머신의 루프백이라 시계 차이는 무시할 수 있다. 화면 표시용 `now`(소요 시간 계산 등)는 페이지가 그대로 만든다. 같은 이유로 `markFeedRead`도 시각을 받지 않는다.
- **사진 목록에서 `filePath`를 뺀다**: 화면은 `seq`만 쓴다. 서버 파일 경로를 HTTP 응답에 싣지 않는다(spec "사진 목록 API 호환"). 포트 반환 타입은 `ItemPhotoMeta = Omit<ItemPhoto, "filePath">`다.
- **오류 타입**: `ItemNotFoundError`는 지금 `src/lib/db/errors.ts`에 있어 화면 라우트가 가져오면 린트(D8)에 걸린다. `src/lib/domain/errors.ts`로 옮기고 `@/lib/db`는 재수출한다(기존 import 무변경). 포트는 도메인 오류만 던진다.
- **버린 대안 — 화면 단위 포트(`loadItemListPage(query)` 등)**: 화면 하나당 요청 1개가 되지만, Spring에 화면 모양의 엔드포인트가 생겨 화면을 바꿀 때마다 백엔드도 바꿔야 한다. 화면 조합은 Next(BFF)의 일이다. 요청 수는 D7의 상한으로 통제한다.
- **버린 대안 — 저장소 인터페이스(`AuctionRepository` 등) 그대로 HTTP 구현**: 동기 인터페이스이고 수집·사진 워커용 쓰기(`upsertItems`, `saveItemPhotos`)까지 섞여 있다. 화면에 필요한 것만 비동기로 다시 정의하는 편이 작고 명확하다.

### D2. 원천 선택과 기본값: `AUCTIONBOSS_DATA_SOURCE=sqlite|spring`, 기본 `sqlite`
- `getDataPort()`가 처음 불릴 때 환경 변수를 읽어 구현체를 만들고 프로세스 안에서 재사용한다. `spring`이면 `AUCTIONBOSS_SPRING_BASE`(예: `http://localhost:8080`)가 필수다. 알 수 없는 값, 주소 없음, `http(s)` 아닌 주소는 허용 값을 담은 오류로 던진다. 다른 원천으로 대신 동작하지 않는다.
- SQLite 구현체는 메서드가 처음 불릴 때 `getDb()`를 연다. 그래서 `spring` 모드에서는 SQLite 파일을 열지 않는다(모듈 로드만 된다).
- **기본값이 `sqlite`인 이유**: 운영 수집 워커는 SQLite에 쓰고 MySQL에는 시드만 있다. 지금 `spring`이 기본이면 화면은 수집이 멈춘 시드 데이터를 보여 준다. 운영 전환은 5단계 데이터 이전 직후 이 변수 하나를 바꾸는 것으로 끝낸다. compose·K8s의 웹 서비스에는 이 변수를 넣지 않고, `src/__tests__/deploy-config.test.ts`가 운영 구성에 `spring`이 없음을 고정한다.
- **버린 대안 1 — 지금 바로 Spring으로 전환**: 위의 낡은 데이터 문제. 수집 워커까지 MySQL에 쓰게 하려면 4·5단계를 앞당겨야 한다. 2단계 D2와 같은 이유로 기각.
- **버린 대안 2 — Next를 Spring 프록시로만 두기(Next `/api/**`를 Spring으로 넘기기)**: 화면은 서버 컴포넌트가 함수 호출로 데이터를 읽으므로 HTTP 프록시가 화면 데이터 경로를 바꾸지 못한다. 또 분석 워커가 쓰는 JSON API까지 Spring으로 넘어가 운영 분석이 MySQL로 간다(2단계 D2의 "두 DB" 상태). 기각.
- **버린 대안 3 — 화면을 Spring 쪽(Thymeleaf 등)으로 옮기기**: 화면 5개, `_lib` 순수 함수 20여 개와 그 테스트를 다시 써야 하고, 로드맵 목표 구조(Next 화면 → HTTP → Spring)와도 다르다. 기각.
- **버린 대안 4 — 요청마다 원천을 읽는 런타임 토글**: 화면마다 원천이 섞일 수 있고, 운영에서 바꿀 일이 5단계 한 번뿐이다. 재시작으로 바꾸는 환경 변수로 충분하다.

### D3. Spring 구현체: 서버 전용 `fetch`, zod 검증, 실패는 실패로
- `client.ts`는 `fetch(new URL(path, base), { cache: "no-store", signal: AbortSignal.timeout(5000) })`로 부른다. 메서드마다 허용 상태를 정한다(대부분 200, `getItemById`의 404는 `null`, 등록의 404는 `ItemNotFoundError`). 그 밖의 상태, 연결 실패, 시간 초과, 스키마 불일치는 `DataSourceError(method, path, status, cause)`로 던진다. 화면 요청은 Next 오류 페이지(500)로 끝난다. 일부만 그리거나 SQLite로 대신 읽지 않는다(spec "백엔드 응답 검증과 실패 처리"). 로그에는 경로와 원인만 남기고 쿼리 값 중 개인 정보가 될 수 있는 것(주소 검색어)은 남기지 않는다.
- **응답 스키마**: `schemas.ts`의 zod 스키마는 `z.object`(모르는 키 버림)다. 각 스키마의 `z.infer`가 도메인 타입(`AuctionItem`, `Analysis`, `ItemChange`, `FeedEntry`, `WorkerRun`, `RunsSummary`, `WorkerStatus` …)과 정확히 같은지 `config.ts`의 `ConfigTypeMatchesSchema`와 같은 타입 단언으로 컴파일 시점에 확인한다. 필드가 빠지면 `tsc`가, 값 형식이 다르면 런타임 검증이, 값이 다르면 계약 테스트(D6)가 잡는다.
- **목록 조건 직렬화**: `src/app/_lib/item-query-url.ts`의 `itemQuerySearchParams`를 `src/lib/domain/item-query.ts`로 옮기고(앱 쪽은 재수출) Spring 구현체가 쓴다. 화면 URL과 API 파라미터 이름이 같기 때문이다(`usage`, `sido`, `minFailed`, `dir` …). 이 직렬화는 `needsAnalysis`, `promptVersion`, `reanalysisCooldownHours`를 표현하지 않으므로, 그 필드가 든 조건이 들어오면 조용히 버리지 않고 던진다. 왕복 테스트(`parseItemQuery(serialize(q))`가 `q`와 같음)로 고정한다.
- **서버 전용**: 포트 모듈은 `server-only`를 가져온다(Next가 처리하는지 1장에서 확인, 안 되면 `"use client"` 파일에서 `@/lib/data-port` 가져오기를 린트로 막는다). Spring 주소가 브라우저 번들에 들어가지 않는다.

### D4. 페이지 이전: 데이터를 맨 위에서 병렬로 읽고, 렌더는 그대로
- 각 페이지는 맨 위에서 `const port = getDataPort()`로 받아 필요한 값을 `Promise.all`로 한 번에 읽는다. 상세는 물건이 있어야 404와 사진 상태를 알 수 있으므로 `getItemById` 1회 뒤 나머지를 병렬로 읽는다.
- `/status`는 `async`로 바꾸고, `WorkerStatusCard`와 `RotationInfo`는 데이터를 props로 받는 동기 컴포넌트가 된다. `RotationInfo`의 설정 오류 처리(`loadCollectorConfig` 실패 시 안내 문구)는 그대로 둔다.
- JSX와 `_lib` 순수 함수는 바꾸지 않는다. 바뀌는 것은 데이터를 얻는 줄뿐이다. 렌더 테스트 3개는 호출 방식만 `renderToStaticMarkup(await StatusPage())`처럼 바꾸고 기대값은 그대로 둔다. ROADMAP의 "기존 화면 테스트 통과"는 이 기준으로 판단한다.
- 동작 무변경 확인: 2장 시작 전에 시드 SQLite로 화면 5개(목록 변형 포함 12개 URL)의 HTML을 저장하고, 이전 후 같은 데이터로 다시 받아 바이트 단위로 같은지 본다(시각 표시는 고정 시계로 맞춘다).

### D5. Spring 화면용 읽기 API 5개와 계약 원본
- **계약 원본은 Next 라우트**: 1·2단계처럼 같은 경로의 Next API 라우트를 먼저 만들고(기존 저장소 함수 사용) 그 응답을 골든으로 삼는다. 덕분에 (a) 골든 생성기가 지금처럼 Next 핸들러를 부르면 되고, (b) 테스트에서 Next 핸들러를 "Spring 대역"으로 쓸 수 있다(D6). 이 라우트 5개는 기존 JSON API와 함께 5단계에 은퇴한다.

  | 경로 | 응답 | 오류 | Spring 위치 | SQL 문 수 |
  | --- | --- | --- | --- | --- |
  | `GET /api/items/filter-options` | `{ usageTypes, sidoValues, sigunguValues, courtValues }` | 500 | `item.ItemController` | 4 |
  | `GET /api/items/{id}/analyses?limit=` | `{ analyses, total }` | 400 `limit`, 404 | `item.ItemController` | 3 (존재, 목록, 건수) |
  | `GET /api/items/{id}/photos` | `{ photos: [{ id, itemId, seq, fileSize, mimeType, collectedAt }] }` | 404 | `item.ItemController` | 2 (존재, 목록) |
  | `GET /api/worker-runs/status?worker=` | `{ state, lastSuccessAt, lastRun }` | 400 `worker` | `worker.WorkerRunController` | 3 (마지막 회차, 마지막 성공, 마지막 완료) |
  | `GET /api/collector-state/rotation` | `{ nextCourtCode }` | — | `worker.CollectorStateController` | 1 |
- **선택지 정렬 규칙**: SQLite `DISTINCT … ORDER BY`는 BINARY(UTF-8 바이트) 비교다. MySQL 기본 정렬 규칙 `utf8mb4_0900_ai_ci`는 대소문자·악센트를 같게 보아 `DISTINCT`에서 값이 합쳐진다. `utf8mb4_bin`은 PAD SPACE라 뒤쪽 공백만 다른 값이 합쳐진다. 그래서 `COLLATE utf8mb4_0900_bin`(NO PAD, 바이트 비교)로 `DISTINCT`와 `ORDER BY`를 한다. `usageTypes`는 1단계 구현(자바 `TreeSet`, UTF-16 코드 단위)을 재사용한다. 시드에는 이런 값이 없으므로 Testcontainers 통합 테스트에 `A법원`/`a법원`/`A법원 `를 넣어 확인하고, 같은 사례를 Next 쪽 저장소 테스트에도 둔다.
- **분석 이력 `limit`**: 1~50 정수, 기본 10. 화면은 11을 보낸다. 검증 규칙(정수 형식, 범위, 빈 값)은 `feed-query.ts` 방식의 새 Next 파서와 1단계 `ItemQueryParser` 방식의 Java 파서로 같게 만든다. 정렬은 `analyzed_at DESC, id DESC`, 기존 `(item_id, analyzed_at DESC)` 인덱스를 탄다.
- **워커 상태**: 판정 규칙은 `worker-runs.ts`의 `getWorkerStatus`를 옮긴다(기록 없음 → stale, 마지막 성공 없으면 마지막 회차 시작 시각 기준, 기대 주기 × `observability.staleAfterIntervals` 초과 → stale, 아니면 마지막 완료 회차가 blocked/failed인지). 워커별 기대 주기(`intervalMs`, `analysis.intervalMs`, `photos.intervalMs`)와 배수는 `WorkerSettings`가 `config/collector.json`에서 호출마다 읽고, 테스트용 덮어쓰기 속성을 둔다. "지금"은 주입된 `Clock`이다. 정적 경로 `status`가 `PATCH /{id}`와 겹치지 않는지 테스트한다(2단계 `summary`와 같음).
- **로테이션**: 키 `collector.rotation.nextCourtCode` 하나만 읽는다. 일반 키 조회 API(`/api/collector-state/{key}`)는 차단 백오프 같은 내부 상태까지 노출하고 4단계(수집기 이식) 뒤에는 의미가 바뀌므로 만들지 않는다.
- **버린 대안 — 기존 API 조합으로 해결**: 워커 상태를 회차 목록 API 여러 번으로 계산하면(마지막 회차, `outcome=success`, 완료 회차 3종) 판정 로직이 Next에 두 벌 생기고 요청이 워커당 4~5개로 는다. 분석 이력을 상세 API에 붙이면 분석 워커도 쓰는 상세 계약(1단계 골든 90개)이 바뀐다. 둘 다 기각.

### D6. 동등성 검증: 골든을 다리로 쓴 3단 증명, Testcontainers는 Java 쪽에만
- **① Spring ≡ Next 핸들러 (Java, CI)**: 2단계 시나리오 골든에 새 시나리오 2개를 더한다. `ScenarioContractTest`가 그대로 재생한다.
  - 골든 형식에 단계별 선택 필드 `advanceMs`를 더한다. 그 단계부터 서버 시각이 그만큼 뒤로 밀린다(생성기는 고정 시계, Spring은 `MutableClock`). 기존 7개 시나리오는 이 필드가 없어 재생성 결과가 바이트 단위로 같아야 한다.
  - 시나리오 `config`에 `intervalMs`, `staleAfterIntervals` 덮어쓰기를 더한다(생성기는 `AUCTIONBOSS_CONFIG` 임시 파일, Spring은 `WorkerSettings` 덮어쓰기 속성).

  | 이름 | 단계 |
  | --- | --- |
  | `screen-reads` | 필터 선택지 → 분석 이력(분석 많은 물건 기본·`limit=11`·`limit=1`, 분석 없는 물건, 없는 물건 404, `limit=0`·`abc`·`51`·빈 값 400) → 분석 저장 2건 후 이력(`total` 증가, 순서) → 사진 목록(사진 픽스처 2건 물건, 사진 없는 물건, 없는 물건 404) → 로테이션 위치 |
  | `worker-status` | 세 워커 상태(시드 기준) → 수집 회차 시작 → 상태(진행 중, 성공 없음) → 성공 종료 → 상태 `ok` → 시작·차단 종료 → 상태 `blocked` → 시작(진행 중) → 상태 `blocked`, `lastRun` 진행 중 → 종료 실패 → 상태 `failed` → `advanceMs`로 기대 주기 × 배수를 넘김 → 상태 `stale`(`lastSuccessAt` 유지) → `worker` 없음·`foo` 400 |
  - 건너뜀 회차와 로테이션 기록 없음은 API로 만들 수 없으므로 Java 통합 테스트(`TestData`로 행 삽입)와 Next 저장소 테스트에서 따로 확인한다.
- **② Spring 구현체 ≡ SQLite 구현체 (TS, CI)**: `src/lib/data-port/__tests__/port-contract.test.ts`. `seedToSqlite`로 만든 임시 SQLite 하나에 대해, SQLite 구현체와 "Next 핸들러 대역 `fetch`"를 쓴 Spring 구현체를 나란히 만든다. 대역 `fetch`는 요청 경로를 Next 라우트 핸들러(기존 JSON API + D5의 5개)에 연결해 같은 프로세스에서 부른다. 사례 표(목록 조건 15종: 기본·정렬 5종×방향·필터 5종·페이지, 상세 3종, 분석 이력 3종, 변경 이력 2종, 사진 2종, 미확인 개수, 관심 목록·피드(포트로 등록·읽음 처리 후), 워커 상태·집계·회차 3워커, 로테이션)의 두 결과를 `toStrictEqual`로 비교한다. Spring 구현체의 직렬화·zod·변환은 여기서, Spring이 Next 핸들러와 같다는 것은 ①에서 증명된다.
  - **빈틈 막기(골든 포함 검사)**: 대역 `fetch`는 받은 요청을 `(메서드, 경로 틀, 쿼리 키 집합)`으로 기록한다. 테스트 마지막에 기록된 모든 틀이 커밋된 골든(1단계 90개 + 시나리오) 중 하나 이상에 있는지 확인한다. Spring 구현체가 골든에 없는 요청 모양을 쓰기 시작하면 이 검사가 실패한다(예: 미확인 개수용 `GET /api/feed?pageSize=1`이 골든에 없으면 시나리오에 단계를 더한다).
- **③ 화면 렌더 (TS, CI)**: 렌더 테스트 3개를 `describe.each(["sqlite", "spring"])`로 두 번 돈다. 준비는 지금처럼 SQLite 저장소 함수로 하고, `spring`일 때는 `setDataPortForTesting(createSpringPort({ fetch: 대역 }))`으로 바꾼다. 기대값은 하나다. 관심 목록·피드 화면 렌더 테스트(지금 없음)도 이번에 더한다.
- **Testcontainers를 TS 쪽에 쓰지 않는 이유**: TS 잡에 Docker·JDK·Spring 빌드가 들어가 CI 시간이 몇 분 늘고, 지금 병렬인 TS·Java 잡이 묶인다. ①이 Spring 실제 응답을 Testcontainers MySQL로 매 CI 확인하고, ②의 골든 포함 검사가 두 증명 사이의 빈틈을 막으므로 실제 Spring을 TS 테스트에서 다시 띄울 이득이 작다. 실제 연결은 개발 환경 비교(D9)로 한 번 확인한다.
- **버린 대안 — 기록된 Spring 응답을 그대로 재생(HAR 방식)**: 응답 파일이 골든과 따로 생겨 갱신이 두 벌이 되고, 렌더 테스트가 넣는 데이터마다 녹화가 필요하다. Next 핸들러 대역은 테스트가 넣은 데이터로 바로 응답한다.

### D7. 화면당 Spring 요청 수 상한
| 화면 | 요청 | 수 |
| --- | --- | --- |
| `/` | 목록(조건), 선택지, 전체 건수(`pageSize=1`), 분석 건수(`analyzed=true&pageSize=1`), 미확인, 수집 워커 상태 | 6 |
| `/items/{id}` | 물건, 분석 이력, 변경 이력, 미확인, 사진 목록(사진 상태 `collected`일 때만) | 5 |
| `/bookmarks` | 관심 목록, 미확인 | 2 |
| `/feed` | 피드, 미확인 | 2 |
| `/status` | 워커 3개 × (상태, 집계, 회차 20건), 로테이션, 미확인 | 11 |
| 폼 2개, 사진 파일 | 각 1 | 1 |
- 대역 `fetch`의 요청 기록으로 화면마다 수를 세어 `toBeLessThanOrEqual(상한)`과 "행 4건과 30건에서 같은 수"를 확인한다. 물건별 요청이 생기면(N+1) 30건 쪽이 늘어 실패한다.
- 화면 안의 요청은 서로 독립이라 병렬로 보낸다(상세는 물건 1회 뒤 병렬). 시드 기준 화면 응답 시간을 `sqlite`와 `spring` 모드로 재서 기록한다. 피드 화면은 `GET /api/feed` 응답에 미확인 개수가 이미 있어 1회로 줄일 수 있지만, 포트 메서드를 화면에 맞추지 않는다는 D1 원칙을 지키고 상한 2로 둔다.

### D8. 린트 강제와 완료 기준 해석
- ROADMAP 3단계 완료 기준 "`src/` 안에서 `better-sqlite3`를 쓰는 화면 코드가 0개"를 "페이지·컴포넌트·화면용 라우트는 데이터 포트만 쓰고, SQLite 접근은 포트의 SQLite 구현체 한 곳에만 있다"로 읽는다. 기존 JSON API 라우트(`src/app/api/**` 중 화면용 3개 제외)는 운영 분석 워커와 수집 경로가 쓰므로 5단계까지 SQLite를 직접 쓰는 것이 맞다. ROADMAP 문구를 이 해석대로 고친다.
- `eslint.config.mjs`에 `no-restricted-imports`를 더한다.
  - 대상: `src/app/**/*.{ts,tsx}`. 제외: `src/app/api/**`, `**/__tests__/**`.
  - 대상(다시 포함): `src/app/api/bookmarks/toggle/**`, `src/app/api/feed/mark-read/**`, `src/app/api/photos/**` (테스트 제외).
  - 금지: `better-sqlite3`, `@/lib/db`, `@/lib/db/*`, `@/lib/storage/*`, 상대 경로 `**/lib/db`, `**/lib/db/*`.
  - 대상 `src/lib/data-port/spring/**`: 같은 금지(Spring 구현체가 SQLite에 기대지 못하게).
- 변이 확인: 페이지 하나에 `import { getDb } from "@/lib/db"`를 넣으면 `npm run lint`가 실패하고, 기존 JSON API 라우트는 통과한다.

### D9. 개발 환경 비교 캡처
- `scripts/dev/compare-screens.sh`: ① `docker compose up -d mysql backend`(`local,seed`)와 개발 MySQL 시드 재적재(2단계 7장이 남긴 가짜 분석 3건·회차 1건 제거) ② `seed-to-sqlite`로 같은 시드의 임시 SQLite ③ `next build` 1회 후 `next start` 두 개: `:3100`은 `sqlite`(임시 SQLite), `:3101`은 `spring`(`AUCTIONBOSS_DB`를 존재하지 않는 디렉터리로 두어 SQLite를 열면 실패하게 함) ④ 같은 순서로 폼 동작(관심 2건 등록, 1건 해제, 읽음 처리)을 두 앱에 보냄 ⑤ 화면 5개와 변형(목록 필터·정렬·2페이지, 상세 분석 있음·없음·사진 대기)을 받아 HTML을 정규화(실행 시각에 따른 소요 시간·담은 시각 표시만)한 뒤 `diff` ⑥ 헤드리스 브라우저가 있으면 두 쪽 스크린숏을 `docs/untracked/`에 저장.
- 시드는 실명을 가린 데이터라 캡처를 남겨도 된다. 정규화 규칙과 차이 0건, 화면 응답 시간을 `docs/DEVELOPMENT_NOTES.md`에 남긴다. CI에는 넣지 않는다(D6과 같은 이유).

### D10. 인증과 노출
- 인증은 이번에도 없다(7단계). Spring은 Next 서버만 루프백으로 부르고, 브라우저는 지금처럼 Next만 본다. Spring 포트(`127.0.0.1:8080`)를 열지 않는 원칙(2단계 D9)을 그대로 둔다. CORS를 설정하지 않는다.
- 개발용 `spring` 모드에서 화면의 관심 토글은 인증 없는 Spring 쓰기 API를 부른다. Next 쪽 폼과 같은 수준이다.

## Risks / Trade-offs

- [대역 `fetch`(Next 핸들러)와 실제 Spring의 차이를 ②·③이 못 봄] → ①이 같은 요청을 실제 Spring에서 골든과 비교하고, 골든 포함 검사가 ②·③에서 쓴 요청 모양이 ①에 있는지 확인한다. D9로 실제 연결을 한 번 본다.
- [Next와 Spring의 "지금"이 달라 상태 판정이 경계에서 갈림] → 같은 머신 루프백이라 차이는 밀리초 단위다. 판정 경계(기대 주기 × 배수)는 분 단위라 화면에서 의미 있는 차이가 나지 않는다. 계약 비교는 고정 시계로 한다.
- [Spring 모드에서 요청 하나가 늦으면 화면 전체가 늦음] → 요청별 시간 제한 5초, 병렬 요청, 화면별 상한. 루프백이라 시드 기준 측정값을 기록하고 느리면 그때 손본다(캐시는 Non-Goal).
- [포트가 `Promise`가 되면서 `/status` 구조가 바뀜] → JSX와 표시 함수는 그대로 두고 데이터 위치만 옮긴다. D4의 HTML 바이트 비교로 무변경을 확인한다.
- [`config/collector.json`을 Next와 Spring이 따로 읽어 값이 갈림] → 두 쪽 모두 같은 파일을 기본 원천으로 쓴다(2단계와 같음). compose에서 같은 파일을 마운트하는지 문서에 적는다.
- [`/api/health`가 `spring` 모드에서도 SQLite를 봄] → 이번 범위 밖(Non-Goals). 개발용 `spring` 모드에서만 생기는 일이고, 5단계에서 헬스체크 원천을 함께 정한다.
- [두 경로 공존 기간이 길어짐] → 5단계에서 기존 JSON API 라우트, D5의 Next 라우트 5개, SQLite 구현체를 함께 지운다. 린트 예외 목록이 지울 대상 목록이 된다.
- [기존 `returnTo` 검증의 빈틈: `/\evil.example`은 `/`로 시작하고 `//`가 아니라 통과하는데, 라우트가 `new URL(returnTo, request.url)`로 만들면 `http://evil.example/`가 된다(Node로 확인). 이미 운영 코드에 있는 오픈 리다이렉트다] → 이 change는 검증 규칙을 바꾸지 않는다는 범위 결정을 지킨다. 원천과 무관한 기존 결함이므로 별도의 작은 수정(백슬래시·제어 문자 거절과 회귀 테스트)으로 먼저 처리하기를 권한다. 그 수정이 들어오면 6장의 폼 테스트에 같은 사례를 두 원천으로 더한다.

## Migration Plan

1. 이 change는 화면 코드의 데이터 경로를 포트로 옮기고 Spring에 읽기 API를 더한다. 기본 원천이 `sqlite`라 운영 화면 동작은 바뀌지 않는다. Flyway 마이그레이션은 없다.
2. 머지 → CI(TS 잡, Java 잡) 통과 → 개발 환경에서 D9 비교 1회 실행과 기록.
3. 롤백: 페이지·라우트를 이전 커밋으로 되돌리면 된다. 포트·Spring 새 API·골든은 남아 있어도 운영에 영향이 없다.
4. 운영 전환(5단계): 데이터 이전 직후 웹 서비스에 `AUCTIONBOSS_DATA_SOURCE=spring`, `AUCTIONBOSS_SPRING_BASE=http://backend:8080`을 넣고, 분석 워커 주소와 수집 워커를 함께 옮긴다. 되돌릴 때는 이 변수를 지운다.


> 2026-10-09 갱신: 위험 항목에 적은 `returnTo` 오픈 리다이렉트 우회(`/\\evil.example`)는 이 change와 별도로 먼저 고쳤다(커밋 "fix(security): 폼 returnTo 오픈 리다이렉트 우회 차단"). 이 change의 폼 엔드포인트 작업은 고친 검증 규칙을 그대로 쓴다.
