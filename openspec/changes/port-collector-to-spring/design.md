## Context

- 동기와 범위는 proposal.md, 지켜야 할 동작은 `specs/spring-backend/spec.md`와 기존 메인 스펙(`auction-collection`, `item-photos`, `run-observability`, `auction-history`)을 따른다.
- 1~2단계로 `backend/`(Spring Boot 4.1, Java 21, Jackson 3, MySQL 8, Flyway V1~V3)에 엔티티 8개, 읽기·쓰기 API, 주입된 `Clock`과 `MutableClock`, `config/collector.json`을 호출마다 읽는 설정(`AnalysisSettings`, `WorkerSettings`), 회차 시작·종료·보관 상한 정리(`WorkerRunService`, `WorkerRunPruner`), `collector_state` 엔티티와 로테이션 조회 API, 사진 디렉터리(`auctionboss.photos.dir`)와 경계 검사(`PhotoFileStore`), 시나리오 골든 재생(`ScenarioContractTest`)과 엄격 비교(`ContractTest.diff`)가 있다. 3단계(`switch-web-to-data-port`, 마무리 중)는 화면을 데이터 포트로 옮기며 Spring에 읽기 API 5개를 더했다.
- 옮길 TS 경로와 동작(코드 기준, 2026-10-09)
  | 위치 | 동작 |
  | --- | --- |
  | `workers/collector.ts` | `setInterval` 틱 + 메모리 `running` 플래그. 틱: 실행 중이면 `skipped(overlap)` → 공유 백오프 남았으면 `skipped(backoff)` → 회차. 회차: 로테이션 위치 읽기 → `selectRotationCourts` → 회차 시작 기록 → 법원마다 `fetchActiveItems({courts:[court]})`(두 번째 법원부터 누적 `pagesRequested >= maxRequestsPerRun`이면 그 법원부터 미시작) → **모든 법원이 끝난 뒤** `upsertItems(전체)` 한 번 → 종료 기록 → 로테이션 위치 저장. 실패 시 그 법원을 다음 시작 위치로, `SourceBlockedError`면 `blocked` + 백오프 `now + 1h` 연장, 그 밖은 `failed`. 오류 종류는 TS 오류 클래스 이름(`RobotDetectedError`, `WafBlockedError`, `ResponseSchemaError`, `SourceRequestError`) |
  | `src/lib/db/repository.ts` `upsertItems` | 한 SQLite 트랜잭션. 물건마다 자연 키 사전 SELECT → `INSERT ... ON CONFLICT DO UPDATE`(`first_seen_at` 보존) → 기존이면 `detectWatchedChanges`(숫자 필드는 숫자로, 그 밖은 문자열로, null↔값은 변경)로 `kind='change'` 행, 신규면 값이 있는 감시 필드마다 `kind='baseline'` 행. `changed`는 배치 시작 전 스냅숏과 배치 최종값을 비교해 물건당 한 번. 같은 배치에 같은 키가 두 번 나오면 두 번째 행의 이력은 첫 번째 처리 결과와 비교된다 |
  | `src/lib/db/collector-state.ts` | 키 `collector.rotation.nextCourtCode`(법원 코드), `backoff_until`(`toISOString()`). 백오프 연장은 `BEGIN IMMEDIATE` 트랜잭션 안에서 읽기·비교·쓰기, 저장값보다 늦을 때만 쓴다. 파싱 못 하는 값은 없음으로 본다 |
  | `src/lib/db/worker-runs.ts` | 회차 시작(`running`)과 건너뜀(`skipped`, `error_kind`=사유, 시작=종료=지금) 모두 보관 상한 정리를 한다 |
  | `workers/photos.ts` | 같은 틱 구조. 회차마다 새 소스(사진 세션은 그 회차 안에서 1회 부트스트랩 후 재사용). 대기 물건(`getPendingPhotoItems`: 식별자 있는 물건 중 미시도 우선, 실패는 `retryAfterHours` 경과 후, `photo_attempted_at ASC, id DESC`) → 물건 사이 `requestDelayMs` 대기 → 요청 직전 백오프 재확인(남았으면 회차 중단) → 식별자 없으면 건너뜀 → 사진 있으면 파일 저장 후 `saveItemPhotos`, 없으면 `empty`, 오류면 `failed`(차단이면 물건을 실패로 적지 않고 백오프 연장 후 중단). 결과: 차단 > 시도 ≥1이고 전부 실패 > 성공 |
  | `src/lib/storage/photos.ts` | base64 10MB 상한, 매직 바이트로 확장자·MIME(`jpg`/`png`/`gif`(87a·89a)/`bin`), 상대 경로 `{itemId}/{seq}{ext}`, 사진 디렉터리는 DB 파일 옆 `photos/` |
  | `src/lib/sources/courtauction/adapter.ts` | 세션 `GET /pgj/index.on`(쿠키 없으면 경고 후 계속), 검색 `POST .../searchControllerMain.on`(첫 페이지 `totalYn=Y`, 페이지 수는 `totalCnt`(행 수) 기준, `maxPages` 상한, 빈 페이지면 중단, 페이지 사이 `pageDelayMs`=5초), 매각기일 창 `오늘 ~ +60일`, `pageSize` 40 상한, 행을 (법원, 사건번호, 물건번호)로 접기, 응답 3단 검사(본문이 `{`로 시작하지 않으면 WAF → `data` 객체 없으면 형식 오류 → `ipcheck !== true`면 로봇탐지 → zod), 실패 오류에 실제 요청 수를 실음, 상세 `POST .../selectAuctnCsSrchRslt.on`의 `csPicLst`에서 `cortAuctnPicSeq`와 `picFile`이 모두 있는 항목만 사진으로. 요청 헤더: 고정 브라우저 UA, `Content-Type`, `Accept`, `Referer`, `Origin`, `X-Requested-With`, `Cookie` |
- 테스트 픽스처: `src/lib/sources/courtauction/__tests__/fixtures.ts`(실제 응답 1행 원문, 일괄매각 행, 도로명만 있는 행, 확장 필드 없는 행, 필수 키 누락 행, `validBody()`, 로봇탐지·WAF·형식 위반·`dma_pageInfo` 누락 본문), `fixtures/detail-response.ts`(실측 상세 응답에서 사진 2장과 기본정보를 발췌), 어댑터 테스트 66개, 수집기 테스트 19개, 사진 워커 테스트 18개.
- 차단 실측(NOTES §6.1, §10.5): 약 5분에 15회 미만 요청으로 IP 차단, 13분 넘게 지속, 쿠키를 새로 받아도 안 풀림. curl 기본 UA는 WAF HTML 차단. 그래서 운영 설정은 회차당 법원 1곳, 요청 상한 13, 주기 10분, 사진 30분마다 5건·30초 간격이다.
- 운영은 compose의 TS `collector`·`photos` 서비스가 SQLite에 쓴다. compose의 `backend`는 `local,seed` 프로필로 시드 MySQL만 보고 포트는 `127.0.0.1:8080`이다.

## Goals / Non-Goals

**Goals:**
- Spring 수집·사진 워커가 기존 워커와 같은 요청을 같은 간격으로 보내고, 같은 응답을 같은 저장 결과로 바꾼다는 것을 골든 두 종류(어댑터, 저장)로 기계적으로 증명한다.
- 서버 인스턴스가 여럿이어도 회차가 겹치지 않음을 Testcontainers MySQL 위에서 증명한다.
- 테스트·CI·개발 compose에서 외부 사이트로 요청이 나갈 수 있는 경로를 설정 두 겹과 테스트로 막는다.

**Non-Goals:**
- 운영 전환, TS 워커 정지, 데이터 이전(5단계). 이 change가 끝나도 운영 수집은 TS다.
- TS 쪽 동작 수정. 이식 중 TS 동작의 결함을 찾으면 Spring에서 고치지 않고 같은 동작으로 옮긴 뒤 메모에 남기고, 고칠지는 별도 change로 정한다(동등성 기준을 흔들지 않기 위해). 단, 안전과 관련된 결함(요청 폭주, 백오프 무시)은 즉시 보고한다.
- 수집 범위·주기·상한 값 변경, 분석 워커 이식, 지표·알림(6단계).

## Decisions

### D1. 범위: 수집 워커 + 사진 워커 + 소스 어댑터를 함께 옮기고, 분석 워커는 TS로 둔다
- **수집 워커**: ROADMAP 목표 구조("Spring Boot API + 수집")와 4단계 정의 그대로다.
- **사진 워커도 함께**: (1) 같은 어댑터(세션 부트스트랩, 3단 차단 감지)를 쓴다. 사진만 TS에 남기면 어댑터가 두 언어로 영구히 두 벌이 된다. (2) 공유 백오프는 같은 저장소에 있어야 의미가 있다. 수집기는 MySQL, 사진 워커는 SQLite에 백오프를 쓰면 서로의 차단을 못 보고, 이는 `item-photos` "차단 백오프를 워커 간 공유한다"를 깨뜨린다. (3) TS 사진 워커는 저장소 함수로 SQLite를 직접 연다. 남기려면 5단계 전에 사진 저장·대기열·백오프·파일 업로드 API를 새로 만들어야 하고, 그 API는 인증 없이 물건 상태를 바꾸는 쓰기 API가 된다.
- **분석 워커는 TS 유지**: 처음부터 HTTP로만 통신하게 만들었고 2단계에서 코드 변경 0줄로 Spring에 붙는 것을 확인했다. 외부 소스에 요청하지 않으므로 공유 백오프·요청 예산과도 무관하다.
- **버린 대안 — TS 수집기를 남기고 Spring에 "수집 결과 저장" API를 만든다**: 어댑터를 옮기지 않아 동등성 위험이 작다는 장점이 있다. 하지만 일괄 upsert, 로테이션·백오프 상태, 단일 실행 잠금, 사진 저장·파일 업로드까지 인증 없는 쓰기 API 5개 이상이 생기고(7단계 전), 배포 단위가 Spring + TS 워커 2종으로 남으며, ROADMAP의 목표 구조와 다르다. 기각.

### D2. 패키지와 계층
```
com.auctionboss.collect
├── source/              AuctionSource(계약), SourceItem(정규화 물건), PhotoLookupRef, SourcePhoto,
│                        FetchActiveItemsResult, FetchItemPhotosResult,
│                        SourceException ─┬ SourceRequestException
│                                         ├ ResponseSchemaException
│                                         └ SourceBlockedException ─┬ WafBlockedException
│                                                                   └ RobotDetectedException
├── source/courtauction/ CourtAuctionAdapter, CourtAuctionHttp(JDK HttpClient), SearchResponseParser,
│                        DetailResponseParser, 응답 record, RowFolder(행 접기·정규화), CourtAuctionConfig(빈 생성)
├── collector/           CollectorRun(회차 본체), ItemUpsertService(저장+이력 한 트랜잭션), WatchedFields,
│                        RotationSelector, CollectorRunDetail
├── photos/              PhotoRun(회차 본체), PendingPhotoQuery, PhotoFileWriter, PhotoSaveService
└── run/                 WorkerTicker(틱: 잠금·백오프·건너뜀 기록), RunLock(GET_LOCK), BackoffStore,
                         CollectorSettings(설정 읽기), SchedulingConfig(조건부), RunOnceRunner(1회 실행 모드)
```
- 소스 계약 패키지(`source`)는 소스 중립 타입만 둔다. 오류 클래스는 `kind()`로 TS 오류 이름(`SourceRequestError`, `ResponseSchemaError`, `WafBlockedError`, `RobotDetectedError`)을 돌려줘 `worker_runs.error_kind`가 같은 값이 된다. 실패 시점까지의 요청 수는 오류 필드(`requestsMade`)로 싣는다(TS `attachPagesRequested`와 같은 합산 규칙).
- 회차 기록은 기존 `worker.WorkerRunService`를 재사용한다. API용 `finish(rawId, body)` 안의 저장 부분을 내부 메서드(`finishRun(id, outcome, errorKind, errorMessage, detail)`)로 꺼내 API와 워커가 같은 코드를 쓴다. 건너뜀 기록(`recordSkipped(worker, reason)`, 보관 상한 정리 포함)을 더한다. 로테이션 위치와 백오프는 기존 `CollectorState` 엔티티의 테이블을 쓰는 `BackoffStore`와 로테이션 저장 메서드로 다룬다.

### D3. HTTP 클라이언트와 요청 형식: 실제 전송 기준으로 Node와 같게
- **선택**: JDK `HttpClient`(HTTP/1.1 고정, 리다이렉트 따라가지 않음, 연결 10초·응답 60초 타임아웃)를 어댑터 안에서만 쓴다. 헤더 이름과 값, 본문 JSON 키 순서는 TS 어댑터가 실제로 보낸 것과 같게 한다.
- **근거**: TS는 Node `fetch`(undici)를 쓰고, undici는 코드에 없는 기본 헤더(`accept-language`, `sec-fetch-mode`, `accept-encoding` 등)를 붙인다. WAF가 UA로 차단한 실측이 있으므로 헤더 차이가 차단 조건이 될 수 있다. 그래서 골든을 "TS 코드가 넘긴 인자"가 아니라 "루프백 가짜 서버가 받은 실제 요청"으로 만든다(D5). Java는 그 헤더 집합을 재현하고, `accept-encoding`을 보낸다면 압축 해제도 한다. HTTP/2로 협상하면 전송 형태가 달라지므로 HTTP/1.1로 고정한다.
- **의도된 차이**: TS `fetch`에는 타임아웃이 없다. Java는 타임아웃을 둔다(멈춘 연결이 단일 실행 잠금을 무기한 잡지 않게). 타임아웃은 `SourceRequestError`로 분류되어 백오프를 걸지 않는다.
- **버린 대안**: Spring `RestClient`(+ JDK 요청 팩토리). 헤더 기본값과 메시지 변환기가 끼어들어 전송 형태를 통제하기 어렵고, 어댑터는 원시 문자열 본문만 다루면 된다. WebClient는 리액티브 의존성을 들인다. 둘 다 기각.
- **대기**: 페이지·법원 사이 대기는 주입된 `Sleeper`로 한다. 테스트는 호출된 대기 시간을 기록해 골든과 비교하고 실제로 자지 않는다.
- **동시 요청 없음**: 어댑터 메서드는 동기이며 회차는 워커 전용 스레드 하나에서 돈다(D7). 가짜 서버 테스트가 동시에 처리 중인 요청 수의 최대값이 1인지 확인한다.

### D4. 외부 요청 안전장치: 두 겹의 기본 꺼짐
1. **주기 실행 꺼짐**: `auctionboss.collector.enabled`, `auctionboss.photos.enabled`(기본 `false`). `SchedulingConfig`와 각 틱 빈은 `@ConditionalOnProperty(havingValue = "true")`라 꺼져 있으면 스케줄러 자체가 없다. `@EnableScheduling`도 이 조건부 설정 안에만 둔다. 기동 시 두 값을 로그로 남긴다.
2. **외부 요청 허용 꺼짐**: `auctionboss.source.external-requests-allowed`(기본 `false`). 어댑터 HTTP 클라이언트는 매 요청 전에 대상 호스트가 루프백(`127.0.0.0/8`, `::1`, `localhost`)인지 보고, 아니고 허용도 없으면 네트워크에 나가지 않고 `SourceRequestException`("외부 요청이 허용되지 않았습니다")을 던진다. 차단이 아니므로 백오프도 걸지 않는다.
- **테스트 프로필**: `application-test.yml`에 소스 주소를 `http://127.0.0.1:9`(닫힌 포트)로 둔다. 테스트 하나가 테스트 컨텍스트에 스케줄러 빈이 없고, 소스 주소가 루프백이며, 외부 요청 허용이 꺼져 있음을 확인한다.
- **배포 설정**: compose와 K8s가 위 세 설정(환경 변수 `AUCTIONBOSS_COLLECTOR_ENABLED`, `AUCTIONBOSS_PHOTOS_ENABLED`, `AUCTIONBOSS_SOURCE_EXTERNAL_REQUESTS_ALLOWED`)을 켜지 않음을 `src/__tests__/deploy-config.test.ts`에 고정한다.
- **실제 사이트 확인**은 스케줄러를 켜지 않고 1회 실행 모드(D11)로만 한다. 그 명령에서만 외부 요청 허용을 켠다.
- **버린 대안**: 프로필(`collector`)로만 켜는 안. 프로필은 여러 개를 쉼표로 섞어 켜므로 의도치 않게 함께 켜지기 쉽고, 한 겹뿐이다. 소스 주소를 비워 두는 안은 5단계에 결국 채워야 하고 "왜 실패하는지"가 드러나지 않는다. 기각.

### D5. 동등성 ① 어댑터 골든
- **픽스처 추출**: `scripts/collector-golden/extract-fixtures.ts`가 TS 픽스처 모듈을 import해 `backend/src/test/resources/contracts/source/fixtures/*.json`으로 쓴다(값 변형 없음). 기존 TS 픽스처를 고치지 않고 복사만 하므로 두 쪽이 같은 바이트를 본다. 상세 응답 픽스처의 개인 이름이 들어갈 수 있는 필드는 1단계 시드의 가림 규칙(`scripts/seed/masking.ts`)을 적용한 값으로 쓰고, 생성기와 Java 테스트 모두 가린 값을 입력으로 쓴다(입력이 같으면 동등성 비교에 영향 없음). 가림 적용 여부를 생성기 테스트로 고정한다.
- **생성**: `scripts/collector-golden/generate-source-goldens.ts`가 사례마다 Node `http` 루프백 서버를 띄워 응답 시퀀스(상태, `Set-Cookie`, 본문)를 순서대로 돌려주고, 받은 요청(메서드, 경로, 헤더, 본문)을 기록한다. 기존 TS `CourtAuctionAdapter`를 `baseUrl`=그 서버, 실제 `fetch`, 기록용 `sleep`, 고정 `now`로 만들어 부르고 결과를 `contracts/source/{사례}.json`에 쓴다. 형식: `{ now, options, call: { kind: "activeItems"|"photos", scope|ref, repeat }, responses: [...], expected: { items, pagesRequested } | { photos, requestsMade } | { error: { kind, requestsMade, messageHead } }, requests: [...], sleeps: [...] }`. 어댑터 코드는 바꾸지 않는다(이미 `baseUrl`·`fetchFn`·`sleep`·`now`를 주입받는다).
- **사례 목록**(최소): 정상 1페이지(실제 응답 행), 3페이지(`totalCnt` 기준 페이지 수), 빈 페이지 조기 종료, `maxPages` 상한, 일괄매각 접기, 도로명만, 확장 필드 없음(없음과 0 구별), 필수 키 누락 행 제외, 원문 보존 코드, 법원 2곳(법원 사이 대기), 세션 쿠키 없음, WAF HTML, `ipcheck:false`(안내 문구 있음·없음), `data` 없음, 형식 위반, JSON 해석 불가, HTTP 500, 2페이지에서 차단, 사진 2장, 사진 빈 목록, 순번·이미지 결측 항목, 사진 차단, 사진 HTTP 오류, 같은 인스턴스로 사진 2회(부트스트랩 1회).
- **Java 비교**: `SourceContractTest`가 사례마다 MockWebServer에 같은 응답을 넣고 Java 어댑터를 같은 옵션으로 부른다. 비교: 물건·사진은 `ContractTest.diff` 엄격 비교, 오류는 `kind`·`requestsMade`·메시지 첫 줄(zod 이슈 문구는 Java 검증기가 같은 문장을 만들 수 없으므로 첫 줄만), 요청은 순서·메서드·경로·본문(JSON 의미 비교)·헤더(이름 대소문자 무시, `host`·`content-length`·`connection` 같은 전송 계층 헤더 제외), 대기 시간 목록은 정확히.
- **네트워크 오류 사례**: 연결 끊김은 MockWebServer의 소켓 정책으로, TS 쪽은 서버가 소켓을 닫는 것으로 만든다. 둘 다 `SourceRequestError`인지와 요청 수만 비교한다.
- **버린 대안**: TS 테스트를 Java로 손으로 옮기는 안. 옮기는 사람이 기대값을 다시 쓰므로 TS와 실제로 같은지 증명하지 못한다. 기각(손으로 옮긴 단위 테스트는 경계 확인용으로만 둔다).

### D6. 동등성 ② 저장 골든
- **생성**: `scripts/collector-golden/generate-store-goldens.ts`가 시나리오마다 빈 임시 SQLite(`getDb` 스키마)와 임시 사진 디렉터리를 만들고, 기존 `startCollector`·`startPhotoWorker`를 `runImmediately:false`로 띄워 단계마다 `tick()`을 부른다. 소스는 시나리오가 정한 응답을 돌려주는 가짜 `AuctionSource`(정규화 물건 또는 오류 종류·요청 수)다. 고정 시각은 2단계의 `scripts/seed/fixed-clock.ts`(인자 없는 `Date`와 `Date.now()`만 고정)를 쓰고 단계마다 시각을 지정한다. 사진 워커는 `now`·`sleep`을 주입한다. 단계 뒤마다 스냅숏을 남긴다.
- **스냅숏**: `items`(전체 컬럼, `id` 포함), `item_changes`(`id` 순), `worker_runs`(`detail`은 JSON 의미 비교), `collector_state`(`key`, `value`, `updated_at`), `item_photos`, 사진 파일(상대 경로, 크기, SHA-256), 가짜 소스가 받은 호출(법원 순서, 사진 대상), 틱 결과.
- **시각·숫자 정규화**: SQLite의 ISO 문자열과 MySQL `DATETIME(3)`은 밀리초 3자리 `Z` 문자열로, 숫자 컬럼은 1단계 시드 변환(`scripts/seed/sql.ts`)과 같은 규칙으로 비교한다. 오류 메시지는 어댑터 골든과 같은 첫 줄 규칙이다.
- **Java 재생**: `StoreContractTest`가 시나리오마다 쓰기 대상 테이블을 비우고 `AUTO_INCREMENT`를 되돌린 뒤(2단계 D10과 같은 이유), `MutableClock`을 단계 시각으로 맞추고 가짜 `AuctionSource` 빈으로 `CollectorRun`·`PhotoRun`을 틱 경로(잠금 포함)로 실행해 같은 스냅숏을 비교한다. 시나리오 설정(법원, 상한, 사진 설정)은 골든의 `config`를 두 쪽이 같은 값으로 쓴다.
- **시나리오 목록**
  | 이름 | 단계 |
  | --- | --- |
  | `collect-insert-baseline` | 빈 DB에 3건 신규(1건은 매각기일 없음 → 그 필드 기준점 없음) |
  | `collect-update-change` | 이어서 최저가 하락+유찰 증가 1건, 소재지만 바뀜 1건, 그대로 1건, 매각기일 없던 물건에 기일 생김, 신규 1건 → 신규·갱신·변경 건수와 `kind` |
  | `collect-duplicate-in-batch` | 한 회차에 같은 키 2번(값 다름), 기존 물건과 신규 물건 각각 → TS의 이력 행과 `changed` 집계 그대로 |
  | `collect-rotation-budget` | 법원 3곳·회차당 3곳·요청 상한 2, 첫 법원 3페이지 → 두 번째 미시작 → 다음 회차는 두 번째부터. 법원 1곳·상한 1의 반복 |
  | `collect-court-removed` | 저장된 위치의 법원을 설정에서 뺀 뒤 회차 → 처음부터 |
  | `collect-blocked` | 법원 2곳 중 두 번째에서 차단 → 물건 미저장, `blocked`, 위치 유지, 백오프 1시간 → 다음 틱 `skipped(backoff)` → 더 이른 백오프 연장 시도 무시 → 백오프 뒤 정상 |
  | `collect-failed` | 형식 오류·요청 실패 → `failed`, 백오프 없음, 다음 틱 정상, 요청 수 기록 |
  | `photos-outcomes` | 사진 저장·사진 없음·식별자 없음·일부 실패 → 성공. 전부 실패 → `failed`. 대기 물건 없음 → 성공 0건 |
  | `photos-blocked-and-retry` | 두 번째 물건에서 차단 → 첫 물건만 저장, 두 번째는 실패로 안 적음, 백오프. 실패 물건 1시간 뒤 제외·25시간 뒤 포함(미시도 뒤 순서) |
  | `shared-backoff` | 사진 워커 차단 → 수집 틱 `skipped(backoff)`, 그 반대 |
- 사진 시나리오의 물건은 수집 단계로 만들고(같은 경로), 사진 상태·시도 시각 조정은 두 쪽에 같은 이식 가능한 SQL로 준비한다.
- **결정성**: 생성기는 전체를 두 번 만들어 바이트 단위로 같은지 확인한다(2단계와 같음).

### D7. 스케줄링과 단일 실행: `TaskScheduler` 틱 + MySQL `GET_LOCK`, 회차는 워커 전용 스레드
- **틱**: 조건부 `SchedulingConfig`가 `ThreadPoolTaskScheduler`에 워커마다 `scheduleAtFixedRate(tick, interval)`을 등록한다(간격은 `config/collector.json`의 `intervalMs`, `photos.intervalMs`를 기동 시 읽음. TS도 기동 시 읽는다). 기동 직후 1회 실행은 TS `runImmediately`처럼 기본 켬, 설정으로 끌 수 있다.
- **틱 동작(스케줄러 스레드, 짧게 끝남)**: ① 전용 JDBC 연결을 하나 얻어 `SELECT GET_LOCK('auctionboss.<worker>', 0)` ② 0이면 연결을 닫고 `skipped(overlap)` 기록 ③ 1이면 공유 백오프 확인, 남았으면 `RELEASE_LOCK` 후 `skipped(backoff)` ④ 아니면 그 연결과 회차를 워커 전용 단일 스레드 실행기로 넘기고 틱은 끝난다. 회차가 끝나면(성공·실패·예외 모두) `finally`에서 `RELEASE_LOCK`과 연결 반환. 순서(겹침 → 백오프)는 TS와 같다.
- **왜 회차를 틱 스레드에서 돌리지 않나**: `scheduleAtFixedRate`는 실행이 주기보다 길면 다음 실행을 미뤘다가 끝나자마자 몰아서 실행한다. 그러면 겹친 주기가 `skipped(overlap)`로 기록되지 않고 회차가 연달아 돌아 요청 간격이 줄어든다. 틱과 회차를 나누면 TS의 `setInterval` + 건너뜀과 같은 동작이 된다.
- **`GET_LOCK`을 고른 근거**: 잠금이 연결에 묶여 있어 프로세스가 죽거나 연결이 끊기면 MySQL이 즉시 푼다(스펙 "사람의 개입 없이 풀림"). 기다리지 않는 시도(`timeout 0`)라 "못 얻으면 건너뜀 기록"이 그대로 표현된다. 테이블·마이그레이션·의존성이 늘지 않는다. MySQL이 유일한 DB이고 Testcontainers로 같은 엔진을 시험한다.
- **버린 대안 1 — ShedLock**: 표 기반 임대(`lock_until`)라 `lockAtMostFor`를 추측해야 하고, 회차가 그보다 길면 두 인스턴스가 겹친다. 짧게 잡으면 겹치고 길게 잡으면 죽은 인스턴스의 잠금이 그만큼 남는다. 잠금을 못 얻으면 조용히 건너뛰어 `skipped(overlap)` 기록을 위한 훅이 없다(직접 감싸야 한다). 테이블(Flyway V4)과 의존성이 는다. 기각.
- **버린 대안 2 — 메모리 플래그만**(TS와 같음): 롤링 배포 중 두 인스턴스가 겹치거나 `replicas`를 늘리면 회차가 겹친다. ROADMAP 완료 기준 "수집 회차가 겹쳐 실행되지 않는다"를 인스턴스 범위로 증명할 수 없다. 프로세스 안 빠른 경로로 함께 두지도 않는다(같은 연결 잠금으로 충분하고 판단 경로가 둘이 되면 시험이 늘어난다). 기각.
- **버린 대안 3 — `collector_state` 행 `SELECT ... FOR UPDATE`**: 회차 내내(수 분) 트랜잭션을 열어 두어야 하고, 물건 저장 트랜잭션(D8)과 경계가 섞인다. 기각.
- **연결 사용량**: 잠금마다 회차 동안 Hikari 연결 1개를 쥔다(수집·사진 동시면 2개). 기본 풀 10에서 API 여유가 충분하다. 저장은 다른 연결(트랜잭션)로 한다.
- **잠금 대상**: 수집과 사진은 서로 다른 이름의 잠금이다(TS도 두 워커가 동시에 돌 수 있다). 두 워커의 요청 예산은 공유 백오프와 각자의 간격으로 다룬다(기존 스펙).
- **종료**: 애플리케이션 종료 시 스케줄러를 먼저 멈추고 진행 중 회차를 기다린다(TS `stop()`과 같음, 기다리는 상한은 설정).

### D8. 트랜잭션 경계
| 동작 | 트랜잭션 | 비고 |
| --- | --- | --- |
| 회차 시작·종료·건너뜀 기록 | 각각 독립(`REQUIRES_NEW` 아님, 회차 본체는 트랜잭션 밖) | 실패는 잡아서 로그만(`run-observability` "회차 기록이 워커 동작을 방해하지 않음") |
| 물건 저장 + 변경 이력 | 회차당 쓰기 1개 | 모든 법원 요청이 끝난 뒤 한 번(TS와 같은 시점). 물건마다 자연 키 사전 SELECT → `INSERT ... ON DUPLICATE KEY UPDATE`(`first_seen_at` 제외) → 이력 INSERT. 신규·갱신은 사전 SELECT로 정한다(`ON DUPLICATE`의 영향 행 수 1/2 대신, TS와 같은 판단 기준) |
| 로테이션 위치 | 독립 1개 | 실패는 로그만(다음 회차가 같은 법원부터) |
| 백오프 연장 | 독립 1개, 한 문장 | `INSERT INTO collector_state (key, value, updated_at) VALUES ('backoff_until', ?, ?) AS new ON DUPLICATE KEY UPDATE value = IF(<저장값 파싱 시각> < <새 시각>, new.value, value), updated_at = IF(...)` 형태. 저장값 시각은 `STR_TO_DATE`로 읽고, 파싱 불가(NULL)면 새 값으로 덮는다(TS와 같음). MySQL은 `SET` 절을 왼쪽부터 적용하므로 `updated_at`을 `value`보다 먼저 쓴다. 문장 하나라 InnoDB 행 잠금으로 동시 연장이 직렬화되고, 행이 없을 때의 동시 삽입도 중복 키 갱신으로 합쳐진다 |
| 사진 저장(물건 하나) | 쓰기 1개 | 파일을 먼저 쓰고 `item_photos` upsert + `items.photo_*` 갱신(TS와 같은 순서) |
- 물건 저장 트랜잭션이 실패하면(이력 INSERT 오류 등) 회차는 `failed`로 기록된다. 이때 TS는 catch에서 `nextStart`를 저장하는데, 저장은 모든 법원 요청이 끝난 뒤라 그 값은 "이번 회차 대상 다음 법원"이다. 즉 저장이 취소된 법원도 로테이션 위치는 전진한다. 원인이 소스가 아니라 DB이고 다음 바퀴에 다시 수집되므로 이 동작을 그대로 옮기고(Non-Goals: 동등성 우선), 골든 밖 단위 테스트(이력 INSERT 실패 주입)로 고정한다. 스펙 시나리오 "이력 기록 실패"도 이 동작으로 적었다.
- 격리 수준은 InnoDB 기본(REPEATABLE READ). 수집 잠금으로 수집 회차는 하나뿐이고, 같은 물건을 쓰는 다른 경로는 사진 저장(`photo_*` 컬럼만)과 분석 저장(다른 테이블)뿐이다.
- 회차 하나의 물건 수는 법원 1곳 기준 수백 건이다. 물건당 3~7문장이면 수천 문장이므로 JDBC 배치는 처음에는 쓰지 않고, 시드 규모에서 회차 저장 시간을 재서 1초를 넘으면 배치로 바꾼다(수치는 DEVELOPMENT_NOTES에).

### D9. 정규화 모델과 변경 감지
- `SourceItem`은 TS `AuctionItemInput`의 필드를 같은 이름·같은 의미로 담는 record다. 없음은 `null`, 정수는 `Long`, 면적·좌표·최저가율은 소스 원문을 보존하는 TS 동작과 같은 타입(`BigDecimal`/`Double`은 1장에서 TS 값 범위를 보고 정함)으로 둔다.
- 감시 필드 비교 규칙(`minBidPrice`, `failedBidCount`는 숫자, `auctionDate`, `status`는 문자열, null↔값은 변경)과 이력 값의 문자열 표기(`String(value)`: 정수는 소수점 없이)는 TS와 같게 한다. 기존 DB 값과 새 값을 비교할 때 MySQL `BIGINT`와 SQLite `INTEGER`가 같은 문자열을 만드는지 저장 골든이 확인한다.
- 어댑터 쪽 변환 함수(`toInt`, `toIntNonZero`, `text`, `toIsoDate`, `deriveStatus`, `pickAddress`, `pickMinBidPrice`, `resolveCourtCode`, `readCookieHeader`)는 이름을 맞춰 옮기고, 어댑터 골든과 별도로 TS 단위 테스트의 경계값을 Java 단위 테스트로 옮긴다.

### D10. 사진 워커 세부
- 대기 물건 SQL은 TS `selectPendingPhotoItems`와 같은 조건·정렬로 옮긴다. `retryBefore = now - retryAfterHours`.
- 파일 저장은 사진 디렉터리(`auctionboss.photos.dir`) 아래 `{itemId}/{seq}{ext}`. MIME·확장자 판정과 10MB 상한은 `src/lib/storage/photos.ts`와 같다. 쓰기 전에 `PhotoFileStore`와 같은 경계 검사를 한다. 사진 파일 API(2단계)가 같은 디렉터리를 읽으므로 스펙 시나리오 "사진 파일 API로 같은 바이트"를 통합 테스트로 확인한다.
- 회차마다 새 어댑터 인스턴스(사진 세션 재사용 범위가 회차 하나)라 프로토타입 범위 빈 또는 팩토리로 만든다.

### D11. 설정과 실행 모드
- **설정 원천**: `CollectorSettings`가 `config/collector.json`의 `scope`(법원, `maxCourtsPerRun`, `maxRequestsPerRun`), `intervalMs`, `photos`(주기, 회차당 물건 수, 요청 간격, 재시도 간격)를 읽는다. 검증 규칙은 TS `config.ts`의 zod 스키마와 같고(법원 1곳 이상, 양의 정수 등), 같은 잘못된 설정 사례를 Java 테스트로 옮긴다. 범위·상한은 회차마다 읽고(설정 변경이 다음 회차에 반영), 주기는 기동 시 읽는다.
- **어댑터 옵션**: 페이지 크기(40 상한), 페이지 대기(5초), 매각기일 창(60일), 최대 페이지(50), 백오프(1시간)는 TS 기본값을 그대로 쓰고 Spring 설정(`auctionboss.source.*`, `auctionboss.collector.block-backoff-ms`)으로만 바꿀 수 있다. TS의 개발용 환경 변수 이름은 따라가지 않는다.
- **1회 실행 모드**: `auctionboss.run-once=collector|photos`이면 `RunOnceRunner`가 스케줄러 없이 틱 경로(잠금·백오프 확인·회차 기록 포함) 하나를 실행하고 종료 코드(성공 0, 그 밖 1)로 끝난다. 웹 서버는 띄우지 않는다(`spring.main.web-application-type=none`). 1회 실행용 덮어쓰기: `auctionboss.source.max-pages`, `auctionboss.collector.max-courts-per-run`, `auctionboss.photos.max-items-per-run`, 사진 대상 물건 id 지정(`auctionboss.photos.only-item-id`). 실제 사이트 확인(D13)에만 쓴다.

### D12. 아키텍처 테스트(ArchUnit)
- 규칙: (1) `..collect.source.courtauction..` 밖의 클래스는 그 패키지에 의존하지 않는다(빈 생성은 그 패키지 안 `CourtAuctionConfig`가 한다). (2) `..collect.source..`는 `jakarta.persistence..`, `org.springframework.jdbc..`, `org.springframework.data..`, `com.auctionboss.item..`·`worker..`·`photo..`에 의존하지 않는다. (3) `java.net.http..`는 `..collect.source.courtauction..`에서만 쓴다. (4) `@Scheduled`·`TaskScheduler`는 `..collect.run..`에서만 쓴다.
- 소스 고유 필드명 누출: ArchUnit은 문자열 상수를 보지 못하므로, `backend/src/main/java`에서 어댑터 패키지 밖 파일에 소스 필드명 목록(`dlt_srchResult`, `dma_pageInfo`, `ipcheck`, `srnSaNo`, `maemulSer`, `csPicLst`, `picFile`, `cortOfcCd` 등, 어댑터 응답 record에서 자동 수집)이 나타나지 않는지 보는 테스트를 둔다.
- 각 규칙은 일부러 위반하는 코드를 넣어 실패하는지 확인한다(변이 확인, tasks 7장).

### D13. 개발 환경 검증과 실제 사이트 최소 1회
- **가짜 서버 전체 경로**: `scripts/dev/verify-collector-on-spring.sh`가 compose MySQL(시드) + 루프백 가짜 소스 서버(어댑터 골든 응답 재생) + Spring(스케줄러 켬, 주기 짧게, 소스 주소=가짜 서버, 외부 요청 허용 꺼짐)을 띄워 수집 3회·사진 1회를 돌리고, 회차 기록·건너뜀·`GET /api/items`·사진 파일 API를 확인한다. 같은 스크립트로 Spring 인스턴스 2개를 띄워 `overlap` 건너뜀이 생기고 회차가 겹치지 않음을 확인한다.
- **실제 사이트 최소 1회(수동)**: 스크립트 `scripts/dev/live-check-collector.sh`로 절차를 고정하되, 실행은 사람이 한 번만 한다.
  1. 사전 확인: 운영 TS `collector`·`photos` 컨테이너를 멈춘다(`docker compose stop collector photos`). SQLite `collector_state.backoff_until`이 과거이고, TS 마지막 수집·사진 회차가 끝난 지 15분 이상인지 확인한다(5분 15회 미만 임계, NOTES §6.1). 하나라도 아니면 중단한다.
  2. 빈 확인용 DB: 시드 없는 별도 데이터베이스(`auctionboss_live_check`, Flyway만)와 임시 사진 디렉터리를 쓴다. 가린 시드와 실데이터를 섞지 않기 위해서다.
  3. 수집 1회: `auctionboss.run-once=collector`, 법원 1곳(서울중앙), `max-pages=1`, 외부 요청 허용 켬 → 세션 1 + 검색 1 = 요청 2개.
  4. 60초 이상 기다린 뒤 사진 1회: `run-once=photos`, 3에서 저장된 물건 하나만 지정 → 세션 1 + 상세 1 = 요청 2개.
  5. 확인: 회차 2건 성공, 요청 수 4 이하, 사진 파일·API. 3의 물건 중 TS SQLite에도 있는 물건을 자연 키로 맞춰 정규화 컬럼(시각 컬럼 제외)을 비교하는 스크립트(`scripts/collector-golden/compare-live.ts`, 읽기 전용, 추가 요청 없음)로 불일치 건수를 센다.
  6. TS 워커를 다시 켠다. 3·4에서 차단이 나면 Spring 쪽 백오프는 MySQL에만 있으므로 TS 워커는 1시간 뒤에 켠다.
  7. 기록: 요청 수, 소요 시간, 비교 결과(건수만, 실데이터 값·개인 정보는 남기지 않음)를 DEVELOPMENT_NOTES에. 확인용 DB와 사진 디렉터리는 지운다.
- 이 절차는 CI에 넣지 않는다.

### D14. 동시 운영 금지와 5단계 런북
- 두 수집기는 서로 다른 DB(SQLite, MySQL)의 백오프와 로테이션 위치를 보므로 어떤 잠금으로도 서로를 막을 수 없다. 그래서 장치는 (1) Spring 기본 꺼짐 두 겹(D4), (2) compose·K8s가 켜지 않음을 테스트로 고정, (3) Spring 스케줄러가 켜질 때 "TS 수집기·사진 워커가 멈춰 있어야 한다"는 경고 로그, (4) 5단계 런북이다.
- **5단계 런북 초안**(`docs/REFERENCE.md`에): TS `collector`·`photos` 정지 → 진행 중 회차 없음 확인 → 데이터 이전(이때 `collector_state`의 `backoff_until`, `collector.rotation.nextCourtCode`도 옮긴다) → Spring에 `AUCTIONBOSS_COLLECTOR_ENABLED`·`AUCTIONBOSS_PHOTOS_ENABLED`·`AUCTIONBOSS_SOURCE_EXTERNAL_REQUESTS_ALLOWED` 설정 → compose에서 TS 두 서비스 제거 → 첫 회차 관찰. 롤백은 역순(Spring 끄고 TS 켜기, 그 사이 MySQL에 쌓인 수집분은 5단계 런북에서 다룸).
- **ROADMAP 4단계 완료 기준 해석**: "같은 응답 샘플로 기존 수집기와 같은 저장 결과가 나온다"는 저장 골든(D6) 전 시나리오 일치로, "수집 회차가 겹쳐 실행되지 않는다"는 두 인스턴스 잠금 테스트(Testcontainers)와 D13 두 인스턴스 확인으로 판정한다. 운영 전환은 5단계 할 일에 적는다.

## Risks / Trade-offs

- [Java 어댑터의 전송 형태가 Node와 미세하게 달라 WAF·로봇탐지에 걸림] → 실제 전송 헤더 기준 골든(D3, D5), HTTP/1.1 고정, 실제 사이트 확인은 요청 4개로 제한하고 TS 워커를 멈춘 창에서만(D13). 차단되면 5단계 전에 원인을 찾는다.
- [동등성 골든이 TS 픽스처 범위만 덮음] → 픽스처는 실제 응답 샘플에서 왔고 경계 사례를 합성으로 더한다. 실제 사이트 1회 결과를 TS SQLite의 같은 물건과 비교한다(D13 5).
- [두 수집기 동시 운영으로 요청 예산 두 배, 서로 백오프를 못 봄] → 두 겹 기본 꺼짐, 배포 설정 테스트, 기동 경고, 런북(D4, D14).
- [`GET_LOCK` 연결이 회차 중 끊겨 잠금이 풀리고 다른 인스턴스가 시작] → 이 단계와 5단계는 인스턴스 하나다. 연결 끊김은 저장 트랜잭션도 실패시키므로 회차가 실패로 끝난다. 타임아웃(D3)으로 무기한 회차를 막는다.
- [고정 주기 틱이 회차 시작 시각을 TS와 다르게 정렬] → 주기·건너뜀 의미만 같으면 된다. 저장 골든은 틱을 직접 부르므로 영향 없다.
- [저장 실패 회차에서 로테이션 위치가 전진해 그 법원 물건이 한 바퀴 늦어짐] → TS와 같은 동작이고 원인이 DB 오류라 드물다. 회차가 `failed`로 기록되어 보인다(D8).
- [픽스처 JSON에 실측 응답의 개인 정보가 복제됨] → 이미 저장소에 있는 TS 픽스처의 복사본이고, 이름 필드는 시드 가림 규칙을 적용한다(D5). 실제 사이트 확인 결과는 수치만 남긴다(D13).
- [MySQL과 SQLite의 숫자·문자열 차이(정수 표기, 대소문자 비교, 콜레이션)] → 저장 골든이 이력 값 문자열과 자연 키 일치를 직접 비교한다. 자연 키 컬럼 콜레이션 차이(`utf8mb4_0900_ai_ci`는 대소문자·악센트 무시)로 SQLite에서 다른 키가 MySQL에서 같은 키가 되는 경우가 있는지 1장에서 시드로 확인한다.

## Migration Plan

1. 이 change는 `backend/`에 꺼진 상태의 워커를 더하고, TS 쪽에는 골든 생성 스크립트만 더한다. 운영 compose·K8s, TS 워커, SQLite는 그대로다. Flyway 마이그레이션은 없다.
2. 머지 → CI(TS 잡, Java 잡) 통과 → 개발 환경 가짜 서버 검증 → 실제 사이트 최소 1회(D13) → 기록.
3. 롤백: `backend/`의 `collect` 패키지·테스트·골든, `scripts/collector-golden/`, `scripts/dev/`의 새 스크립트를 되돌리면 끝난다. 스케줄러가 꺼져 있으므로 운영 데이터에 영향이 없다.
4. 운영 전환은 5단계에서 D14 런북으로 한다.

## Open Questions

- 실제 사이트 확인(D13)을 하는 날의 TS 수집 창: 운영 상시 환경이 아직 없으므로(ROADMAP), 개발 머신에서 TS 워커가 돌고 있지 않다면 1단계의 "멈춤" 확인만 하면 된다. 절차는 같다.
- 물건 저장을 JDBC 배치로 바꿀지: D8의 측정 결과로 정한다. 스펙·작업 분해와 무관하다.
