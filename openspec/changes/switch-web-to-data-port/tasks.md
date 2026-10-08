## 1. 화면 데이터 접근 목록화와 포트 인터페이스

- [ ] 1.1 시작 기준을 확인한다. `add-spring-write-api`가 아카이브됐는지 확인하고, 게이트 5종(`npx tsc --noEmit`, `npm test`, `npm run build`, `npm run lint`, `cd backend && ./gradlew check`)이 통과하는지, TS·Java 테스트 수와 change 시작 커밋 해시를 이 파일 하단 메모에 남긴다
- [ ] 1.2 `grep -rn "@/lib/db\|better-sqlite3\|lib/storage" src/app`으로 design.md Context의 화면 데이터 접근 표가 코드와 같은지 다시 확인하고, 다른 점이 있으면 표와 메모를 고친다. 결과(파일별 호출 목록)를 메모에 남긴다
- [ ] 1.3 동작 무변경 기준선을 만든다. 시드 SQLite(`seed-to-sqlite`)와 고정 시계로 화면 5개와 변형(목록 필터·정렬·2페이지, 상세 분석 있음·없음·사진 대기, 관심·피드 빈 상태)을 서버 컴포넌트 직접 호출로 렌더해 HTML을 임시 디렉터리에 저장하는 스크립트(`scripts/dev/snapshot-screens.ts`)를 만든다. 두 번 돌려 같은지(결정성) 확인한다
- [ ] 1.4 `ItemNotFoundError`, `WorkerRunNotFoundError`를 `src/lib/domain/errors.ts`로 옮기고 `@/lib/db`는 재수출한다. 기존 테스트가 그대로 통과하는지 확인한다
- [ ] 1.5 `itemQuerySearchParams`를 `src/lib/domain/item-query.ts`로 옮기고 `src/app/_lib/item-query-url.ts`는 재수출한다. `needsAnalysis`·`promptVersion`·`reanalysisCooldownHours`가 든 조건은 던지게 한다. 왕복 테스트(`parseItemQuery(serialize(q))`가 `q`와 같음, 필터·정렬·반복 파라미터·페이지 사례)를 더한다. 변이 확인: `sido` 직렬화를 빼면 왕복 테스트가 실패한다
- [ ] 1.6 `src/lib/data-port/port.ts`에 `DataPort`(design.md D1의 읽기 13, 쓰기 3, 파일 1), `ItemPhotoMeta`, `PhotoFile`, `DataSourceError`를 정의한다. `server-only`를 Next가 처리하는지 확인하고 결과에 따라 D3의 서버 전용 방식을 정한다. `npx tsc --noEmit` 통과로 확인한다

## 2. SQLite 구현체와 화면 이전(동작 무변경)

- [ ] 2.1 `src/lib/data-port/sqlite.ts`(`createSqlitePort(db?)`, 첫 호출 때 연결)를 만든다. 메서드마다 임시 SQLite 단위 테스트를 둔다(분석 이력의 `limit`·`total`, 사진 목록에 `filePath` 없음, 로테이션 기록 없음 `null`, 없는 물건 등록 `ItemNotFoundError`, 사진 파일의 `Not Found`·`File Not Found` 구분)
- [ ] 2.2 `src/lib/data-port/index.ts`(`getDataPort()`, `setDataPortForTesting()`)를 만든다. 기본값 `sqlite`, `spring`인데 주소 없음·잘못된 주소·알 수 없는 값이면 허용 값을 담은 오류, 다른 원천으로 대신 동작하지 않음을 테스트한다. 변이 확인: 알 수 없는 값을 `sqlite`로 처리하게 바꾸면 테스트가 실패한다
- [ ] 2.3 `/bookmarks`, `/feed`를 포트로 옮긴다(맨 위 `Promise.all`). 1.3 기준선과 HTML이 같은지 확인한다
- [ ] 2.4 `/`(목록)을 포트로 옮긴다(선택지는 `listFilterOptions`, 수집 워커 상태는 `getWorkerStatus("collector")`). 기존 목록 렌더 테스트 4개와 1.3 기준선이 같은지 확인한다
- [ ] 2.5 `/items/{id}`를 포트로 옮긴다(물건 1회 뒤 분석 이력·변경 이력·미확인·사진 목록 병렬). 기존 상세 렌더 테스트 8개(404 2개 포함)와 1.3 기준선을 확인한다
- [ ] 2.6 `/status`를 `async`로 바꾸고 `WorkerStatusCard`·`RotationInfo`가 데이터를 props로 받게 한다. 렌더 테스트는 호출 방식만 `await`로 바꾸고 기대값은 그대로 둔다. 설정 오류 안내(`loadCollectorConfig` 실패) 경로를 렌더 테스트로 더한다. 1.3 기준선과 같은지 확인한다
- [ ] 2.7 관심 목록·피드 화면 렌더 테스트를 새로 만든다(빈 상태 안내, 담은 물건 행과 해제 폼의 `returnTo`, 미확인 강조와 읽음 버튼 노출 조건)

## 3. Spring 화면용 읽기 API와 골든

- [ ] 3.1 Next 계약 원본 라우트 5개를 만든다(design.md D5: `filter-options`, `{id}/analyses`, `{id}/photos`, `worker-runs/status`, `collector-state/rotation`). 분석 이력 `limit` 파서(1~50, 기본 10, 정수 형식, 빈 값)와 `worker` 검증을 라우트 테스트로 고정한다. 정적 경로가 동적 경로에 잡히지 않는지(`filter-options` vs `{id}`, `status` vs `{id}`) 확인한다
- [ ] 3.2 Next 저장소 테스트에 선택지의 문자 그대로 구분(`A법원`, `a법원`, `A법원 `, 빈 문자열)과 정렬 사례를 더한다
- [ ] 3.3 골든 형식에 단계별 `advanceMs`와 `config`의 `intervalMs`·`staleAfterIntervals` 덮어쓰기를 더한다(생성기 `scripts/seed/generate-scenarios.ts`, Spring `ScenarioContractTest`). 기존 7개 시나리오를 다시 생성해 바이트 단위로 같은지 확인한다. 고정 시계 vitest에 `advanceMs` 사례를 더한다
- [ ] 3.4 시나리오 `screen-reads`, `worker-status`(design.md D6 표)를 정의하고 생성한다. 두 번 생성해 같은지, `"<iso-ms>"` 표식 0개, 원본 500 단계 없음을 확인한다
- [ ] 3.5 Spring `GET /api/items/filter-options`를 만든다(`COLLATE utf8mb4_0900_bin`의 `DISTINCT`·`ORDER BY`, 용도는 1단계 구현 재사용). Testcontainers 통합 테스트에 3.2와 같은 사례를 넣는다. 변이 확인: 정렬 규칙을 `utf8mb4_bin`으로 바꾸면 뒤쪽 공백 사례가, 기본 정렬 규칙으로 두면 대소문자 사례가 실패한다
- [ ] 3.6 Spring `GET /api/items/{id}/analyses`(Java `limit` 파서, 존재·목록·건수 3문장)와 `GET /api/items/{id}/photos`(파일 경로 제외)를 만든다. MockMvc 테스트로 `total`과 순서, 400 `limit`, 404, 응답에 `filePath` 키가 없음을 확인한다
- [ ] 3.7 `WorkerSettings`에 워커별 기대 주기와 `staleAfterIntervals` 읽기·덮어쓰기를 더하고, Spring `GET /api/worker-runs/status`를 만든다(주입된 `Clock`). `MutableClock` 통합 테스트로 기록 없음, 정상, 진행 중 뒤 차단, 건너뜀 뒤 차단(`TestData`로 삽입), 실패, 시간이 지나 미실행, 성공 없이 오래된 진행 중 회차를 확인한다. 변이 확인: 판정에서 `skipped` 제외 조건을 빼면 건너뜀 사례가 실패한다
- [ ] 3.8 Spring `GET /api/collector-state/rotation`을 만들고 기록 있음·없음을 테스트한다
- [ ] 3.9 `ScenarioContractTest`가 새 시나리오 2개까지 모두 일치할 때까지 고친다. 불일치 건수와 원인을 메모에 남긴다. 기존 읽기 골든 90개와 시나리오 7개도 계속 일치하는지 확인한다
- [ ] 3.10 `QueryCountTest`에 새 API 5개(선택지 4, 분석 이력 3, 사진 목록 2, 워커 상태 3, 로테이션 1)를 더하고 행 수를 바꿔도 같은지 확인한다

## 4. Spring 구현체

- [ ] 4.1 `src/lib/data-port/spring/schemas.ts`에 응답 zod 스키마를 만들고 도메인 타입과의 일치를 타입 단언으로 고정한다. 변이 확인: `AuctionItem`에 필드를 하나 더하면 `tsc`가 실패한다
- [ ] 4.2 `spring/client.ts`를 만든다(`no-store`, 5초 시간 제한, 허용 상태, `DataSourceError` 변환, 요청 기록 훅, 로그에 검색어 값 제외). 가짜 `fetch`로 연결 실패, 시간 초과, 500, 스키마 불일치, 허용 404를 테스트한다
- [ ] 4.3 `spring/port.ts`(`createSpringPort({ baseUrl, fetch? })`)의 메서드 17개를 만든다. 사진 파일은 상태·바이트·`Content-Type`·`Cache-Control`을 그대로 넘긴다. 가짜 `fetch`로 요청 경로·쿼리·메서드·본문이 design.md D1 표와 같은지 메서드마다 확인한다
- [ ] 4.4 `spring` 모드에서 SQLite를 열지 않는지 확인한다: `@/lib/db`의 `getDb`를 던지게 바꾼 상태로 Spring 구현체 테스트가 통과한다

## 5. 동등성·렌더·요청 수 테스트

- [ ] 5.1 Next 핸들러 대역 `fetch`(`src/lib/data-port/__tests__/next-stand-in.ts`)를 만든다. 경로 틀을 기존 JSON API와 3.1의 라우트 핸들러에 연결하고, 받은 요청을 `(메서드, 경로 틀, 쿼리 키 집합)`으로 기록한다
- [ ] 5.2 포트 계약 테스트(`port-contract.test.ts`)를 만든다. 시드 SQLite에서 design.md D6 ②의 사례 표를 두 구현체로 불러 `toStrictEqual`로 비교한다. 쓰기 후 읽기(관심 2건 등록, 1건 해제, 읽음 처리 뒤 관심 목록·피드·미확인)도 두 구현체로 같은 결과인지 본다. 변이 확인: Spring 구현체에서 `listBookmarkedItems`의 `page` 전달을 빼면 실패한다
- [ ] 5.3 골든 포함 검사를 더한다. 5.2에서 기록된 요청 틀이 모두 커밋된 골든에 있는지 확인하고, 없는 틀은 시나리오 단계를 더해 3.4·3.9를 다시 돌린다. 변이 확인: 미확인 개수 요청에 새 쿼리 키를 붙이면 검사가 실패한다
- [ ] 5.4 렌더 테스트 5개 파일(목록, 상세, 상태, 관심, 피드)을 `describe.each(["sqlite", "spring"])`로 두 원천에서 돌린다. 기대값은 하나로 둔다. 렌더 테스트 수가 두 배가 되는 것을 메모에 남긴다
- [ ] 5.5 요청 수 테스트를 만든다. 대역 기록으로 화면별 요청 수가 design.md D7 상한 이하인지, 관심 물건·피드·회차 행 4건과 30건에서 같은지 확인한다. 변이 확인: 관심 목록 화면에서 물건마다 `getItemById`를 부르게 바꾸면 실패한다
- [ ] 5.6 실패 처리 렌더 테스트를 만든다. Spring 모드에서 대역이 500·형식이 다른 본문·연결 실패를 돌려주면 페이지가 던지고(부분 렌더 없음), 없는 물건 상세는 `notFound()`인지 확인한다

## 6. 폼 엔드포인트와 사진 라우트

- [ ] 6.1 `POST /api/bookmarks/toggle`을 포트로 옮긴다. 기존 라우트 테스트를 두 원천으로 돌려 303과 `Location`, 없는 물건 404와 관심 목록 불변, `returnTo` 검증(외부 주소·`//`·없음 → `/`)을 확인한다
- [ ] 6.2 `POST /api/feed/mark-read`를 포트로 옮기고 같은 방식의 라우트 테스트를 새로 만든다(303, `returnTo`, 처리 후 미확인 0, 피드 조회만으로는 미확인 불변)
- [ ] 6.3 `GET /api/photos/{itemId}/{seq}`를 포트로 옮긴다. 2단계 `photos` 시나리오의 사진 픽스처로 두 원천에서 상태·본문(SHA-256)·헤더·텍스트 오류(`Invalid ID`, `Not Found`, `File Not Found`)가 같은지 테스트한다

## 7. lint 강제

- [ ] 7.1 `eslint.config.mjs`에 design.md D8의 `no-restricted-imports` 규칙(화면 대상, 화면용 라우트 3개 재포함, Spring 구현체 대상, 테스트·기존 JSON API 제외)을 더한다. `npm run lint`가 통과하는지 확인한다
- [ ] 7.2 변이 확인: 페이지, `_components` 파일, 화면용 라우트 하나, Spring 구현체에 각각 `@/lib/db`(또는 상대 경로, `better-sqlite3`) 가져오기를 넣으면 lint가 실패하고, 기존 JSON API 라우트는 통과하는지 확인하고 되돌린다. 결과를 메모에 남긴다
- [ ] 7.3 `src/__tests__/deploy-config.test.ts`에 compose·K8s 웹 서비스가 `AUCTIONBOSS_DATA_SOURCE=spring`을 설정하지 않음을 고정한다(spec "운영 데이터 원천 유지")

## 8. 개발 환경 spring 모드 캡처 검증

- [ ] 8.1 `scripts/dev/compare-screens.sh`를 만든다(design.md D9 절차, `AUCTIONBOSS_DB`를 존재하지 않는 경로로 둔 `spring` 인스턴스, 같은 폼 동작, 정규화 규칙을 스크립트 안에 명시, 비밀 값 출력 금지)
- [ ] 8.2 개발 환경에서 1회 실행한다. 화면 5개와 변형의 HTML 차이 0건, `spring` 인스턴스가 SQLite를 열지 않았음, 두 모드의 화면 응답 시간을 확인하고 메모에 남긴다. 헤드리스 브라우저가 있으면 스크린숏을 `docs/untracked/`에 저장한다
- [ ] 8.3 Spring을 멈춘 상태에서 `spring` 인스턴스 화면이 오류로 끝나고 SQLite 데이터가 보이지 않는지 확인한다

## 9. 마무리

- [ ] 9.1 게이트 5종을 모두 통과시킨다. TS·Java 테스트 수가 1.1보다 줄지 않았는지 확인하고, 줄었으면 이유를 보고한다
- [ ] 9.2 수치를 `docs/DEVELOPMENT_NOTES.md`에 기록한다: 화면별 Spring 요청 수, 새 API SQL 문 수와 `EXPLAIN`, 시나리오·단계 수와 불일치 원인, 포트 계약 사례 수, 두 모드의 화면 응답 시간, 8.2 결과, 테스트 수 변화
- [ ] 9.3 `docs/REFERENCE.md`와 README에 `AUCTIONBOSS_DATA_SOURCE`·`AUCTIONBOSS_SPRING_BASE`, 새 API 5개(Next·Spring), 운영 기본값 `sqlite`, 개발용 `spring` 모드 실행법을 반영한다
- [ ] 9.4 `docs/ROADMAP.md` 3단계를 갱신한다: 완료 기준을 "페이지·컴포넌트·화면용 라우트는 데이터 포트만 쓰고 SQLite 접근은 포트의 SQLite 구현체 한 곳(린트로 강제), 기존 화면 테스트가 두 원천에서 통과"로 고치고, 운영 화면 전환(`AUCTIONBOSS_DATA_SOURCE=spring`)과 기존 JSON API·SQLite 구현체 은퇴를 5단계 할 일에 적는다. 상태·수치·기록 위치를 채운다
- [ ] 9.5 `regression-verifier` 서브에이전트로 회귀 검증을 받고 지적 사항을 반영한다
- [ ] 9.6 커밋하고 푸시한 뒤 GitHub Actions의 TS 잡과 Java 잡이 통과하는지 확인한다
- [ ] 9.7 `openspec validate switch-web-to-data-port --strict`를 통과시킨 뒤 change를 아카이브하고, 메인 스펙 `web-data-port`가 생기고 `spring-backend`에 요구사항이 반영됐는지 확인한다

---

### 메모
<!-- 1.1 시작 커밋·테스트 수, 1.2 화면 데이터 접근 재확인, 3.9 불일치 원인, 7.2 lint 변이 결과, 8.2 비교 결과를 여기에 남긴다 -->
