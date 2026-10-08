## 1. 스펙 delta 검토

- [x] 1.1 delta 7개의 MODIFIED 블록을 메인 스펙 원문과 diff해, 의도한 문장 외에 바뀐 곳과 빠진 시나리오가 없는지 확인한다. 요구사항 수와 시나리오 수를 표로 남긴다
- [x] 1.2 고친 문장마다 근거 코드 위치와 그 동작을 지키는 테스트를 다시 열어 확인하고, 대조표(문장, 코드 파일:줄, 테스트)를 tasks 하단 메모에 남긴다
- [x] 1.3 `openspec validate align-specs-with-code --strict`가 통과하는지 확인한다

## 2. 테스트가 없던 규칙에 회귀 테스트 추가 (동작 변경 없음)

- [x] 2.1 `workers/lib/claude.ts`의 `runClaude`가 `ANTHROPIC_API_KEY`가 있으면 Messages API 경로를, 없으면 CLI 경로를 고르는지 테스트를 추가한다. 분기를 반대로 바꾸면 테스트가 실패하는지 변이로 확인한다
- [x] 2.2 상세 화면이 이전 분석을 최근 10건까지만 본문으로 보여 주고 나머지는 건수로 보여 주는지 테스트를 추가한다(기존 상세 렌더 테스트 방식을 따른다). 한도를 바꾸면 실패하는지 변이로 확인한다

## 3. delta로 고칠 수 없는 부분

- [x] 3.1 auction-analysis 메인 스펙의 Purpose에서 "서버 로컬의 Claude Code로" 문구를 "Claude(API 키가 있으면 Messages API, 없으면 로컬 CLI)로"에 맞게 직접 고친다
- [x] 3.2 이번 범위 밖으로 남긴 불일치를 후속 목록으로 정리해 tasks 하단 메모에 남긴다: 사진 워커 결함(회차 기록, 백오프 공유, 재시도 간격, 어댑터 우회), 배포 설정(분석 워커 주소 변수, Next 이미지 curl), run-observability "정상 상태" 시나리오와 판정 코드의 차이, 표현 문제(빈 줄, 오타, change 시점 말투)

## 4. 마무리

- [x] 4.1 게이트 5종(`npx tsc --noEmit`, `npm test`, `npm run build`, `npm run lint`, `cd backend && ./gradlew check`)이 통과하고 TS 테스트 수가 791에서 늘었는지 확인한다
- [x] 4.2 `regression-verifier`로 회귀 검증을 받고 커밋, 푸시한다
- [ ] 4.3 아카이브(메인 스펙 동기화)하고, 동기화 전후 요구사항 수와 시나리오 수를 비교해 줄어든 것이 없는지 확인한다

### 메모: 1.1~1.3 검토와 3.2 후속 목록 (2026-10-08)

검토 방식: 읽기 전용. delta 7개의 요구사항 블록을 메인 스펙 원문과 줄 단위로 diff했고(RENAMED 1건은 옛 이름 블록과 diff), 바뀐 문장마다 코드와 테스트를 다시 열었다. 줄 번호는 이 시점의 워킹트리 기준이다.

#### 1.1 delta와 메인 스펙 diff 결과

결론: 의도 밖의 변경은 없다. 빠진 시나리오도 없다(모든 요구사항에서 delta의 시나리오 수가 메인 이상이고, 메인에 있던 시나리오 제목은 전부 delta에 남아 있다). 메인과 다른 줄은 proposal에 적힌 의도 문장뿐이다. 각 블록 끝의 빈 줄 1개만 delta에서 빠져 있는데, 블록 사이 간격이라 의미 변화는 없다.

| capability | 요구사항 | 메인 시나리오 | delta 시나리오 | 바뀐 곳 |
|---|---|---|---|---|
| auction-analysis | 분석 대상 선정 | 9 | 9 | 조건 3 "낡은" -> "다른", 시나리오 1개 WHEN |
| auction-analysis | Claude Code 분석 실행 -> Claude 분석 실행 (RENAMED+MODIFIED) | 6 | 8 | 이름, 실행 방식 문단, 시나리오 2개 추가(API 키 있음/없음) |
| auction-analysis | 분석 결과 표시 | 7 | 9 | 이전 분석 10건 한도, 최신성 정의, 쿨다운 제외 문단, 시나리오 2개 추가 |
| auction-analysis | 분석 결과 수신 API | 2 | (delta에 없음, 변경 없음) | - |
| auction-collection | 수집 범위 설정 | 5 | 7 | "1단계 기본값" 삭제, 요청 수 상한 문단, 시나리오 2개 추가 |
| auction-history | 변경 이력 기록 | 6 | 7 | 기준점은 필드마다 한 항목·값 없는 필드 제외, 시나리오 1개 추가, 문장 2개 수정 |
| auction-history | 변경 이력 표시 | 3 | 4 | "기준점 1건뿐" -> "기준점 항목만", 최근 변동 7일, 시나리오 1개 추가 |
| auction-viewing | 물건 목록 열람 | 24 | 24 | 키워드 문구 2곳, 저감률 문단·시나리오 |
| auction-viewing | 물건 조회 API | 7 | 7 | 두 문단을 파라미터 목록으로 대체 |
| deployment-and-health | 헬스체크 엔드포인트 | 2 | 2 | 첫 문장(범위 명시) |
| run-observability | 실행 회차 기록 | 8 | 8 | 건너뜀 기록 범위 문단, 사진 워커 기록 문장, 건너뜀 시나리오 WHEN |
| run-observability | 실행 상태 판정 | 4 | 4 | 판정 문단 추가, 차단 시나리오 WHEN |
| spring-backend | 더미 시드 데이터 | 3 | 3 | 미적재 조건 문장, 운영 환경 시나리오 WHEN |
| spring-backend | 물건 목록 API 호환 | 5 | 7 | 파라미터 목록 3분할(sido·sigungu 여러 번), 재분석 정렬 문장, 시나리오 2개 추가 |

capability별 요구사항 수와 시나리오 수(4.3 비교용 기준값). 메인은 현재 값이고, 아카이브 후 기대값은 delta만큼 늘어난 값이다. 요구사항 수는 모두 그대로다.

| capability | 요구사항 (메인 -> 아카이브 후 기대) | 시나리오 (메인 -> 아카이브 후 기대) |
|---|---|---|
| auction-analysis | 4 -> 4 | 24 -> 28 |
| auction-collection | 5 -> 5 | 21 -> 23 |
| auction-history | 3 -> 3 | 11 -> 13 |
| auction-viewing | 4 -> 4 | 46 -> 46 |
| deployment-and-health | 3 -> 3 | 5 -> 5 |
| run-observability | 7 -> 7 | 21 -> 21 |
| spring-backend | 7 -> 7 | 22 -> 24 |
| (변경 없음) bookmarks, item-photos | 5, 5 | 16, 11 |

delta를 검토하며 눈에 띈 점(수정 필요는 아님):
- auction-analysis delta 첫 줄의 RENAMED 뒤에 MODIFIED가 새 이름으로 적혀 있다. OpenSpec 규칙에 맞다.
- run-observability delta는 "워커 종류는 수집·분석에 한정되지 않는다" 문장을 "회차를 기록하는 워커 종류는 수집·분석·사진 워커이며 사진 워커도 같은 형식으로 기록해야 한다(SHALL)"로 바꿨다. proposal에는 이 변경이 적혀 있지 않다(건너뜀 범위만 적혀 있음). 이 문장은 코드가 어기는 쪽(사진 워커는 기록하지 않음, 아래 3.2)이라 스펙을 낮춘 것은 아니고 더 구체화한 것이다. 다만 proposal "What Changes"의 run-observability 항목에 한 줄 보태 두면 아카이브 때 혼동이 없다.
- 다음 두 줄은 이 검토 중 워킹트리에 다른 작업이 겹쳐 있었다: `workers/__tests__/claude.test.ts`, `src/app/items/[id]/__tests__/page.render.test.ts`가 수정 중(2.1·2.2 작업으로 보임)이고 tasks.md 본문도 수정돼 있었다. 이 메모는 맨 끝에 추가만 했다.

#### 1.2 문장 - 근거 코드 - 테스트 대조표

범례: "2.x에서 추가 예정"은 tasks 2.1·2.2가 만드는 테스트다. 검토 시점에 워킹트리에 이미 초안이 있었다(claude.test.ts의 "runClaude 경로 선택" 3개, page.render.test.ts:165 "이전 분석은 최근 10건만...", :192). 커밋 전이라 이 표에서는 "추가 예정"으로 둔다. "부분"은 테스트가 있지만 문장의 일부만 지킨다는 뜻이다.

auction-analysis

| 바뀐 문장 | 근거 코드 | 테스트 |
|---|---|---|
| 재분석 조건 3은 현재 버전과 "다른" 버전(높낮이 비교 없음) | `src/lib/db/repository.ts:379-383` (`... != @promptVersion`), `src/app/_lib/analysis-freshness.ts:90` (`!==`) | `src/lib/db/__tests__/repository.test.ts:794` "스펙 시나리오 - 프롬프트 버전 갱신에 따른 재분석...", `src/app/_lib/__tests__/analysis-freshness.test.ts:64` "분석 후 프롬프트 버전이 다르면 stale", `src/app/_lib/__tests__/analysis-freshness.integration.test.ts:114`, backend `ItemSearchRepositoryTest.needsAnalysisIncludesDifferentPromptVersionAndExcludesSameVersion` (:492) |
| 시나리오 "저장된 최신 분석의 버전이 현재와 다르면 재분석" | 위와 같음 | 위와 같음. "높고 낮음은 비교하지 않는다"는 부분은 낮은 버전·높은 버전을 모두 넣어 보는 전용 테스트 없음(부분) |
| API 키가 있으면 Messages API, 없으면 로컬 CLI | `workers/lib/claude.ts:292-297` (`runClaude`가 `process.env.ANTHROPIC_API_KEY` truthy면 `runClaudeViaApi`, 아니면 `runClaudeHeadless`) | 2.x에서 추가 예정 (초안: `claude.test.ts` "ANTHROPIC_API_KEY가 있으면...", "...없으면...", "...빈 문자열이면..."). 변이 확인은 2.1에서 한다 |
| 시나리오 "API 키가 있으면 API 우선 / 없으면 CLI" | 위와 같음 | 2.x에서 추가 예정. 기존 Direct API 모드 분석 시나리오는 `claude.test.ts`의 API 호출 단위 테스트가 지킨다 |
| 이전 분석은 가장 최근 10건까지만 본문, 나머지는 건수만 | `src/app/items/[id]/page.tsx:62` (`MAX_ANALYSES_FETCHED = 11`, 최신 1 + 이전 10), `:110-113` (조회·숨김 건수 계산), `:379`, `:394-395` (안내 문구) | 2.x에서 추가 예정 (초안: `page.render.test.ts:165`, `:192`). `src/app/_lib/__tests__/analysis-history.test.ts`는 최신/이전 분리만 지키고 한도는 지키지 않는다 |
| 시나리오 "이전 분석이 많은 물건 상세" | 위와 같음 | 2.x에서 추가 예정 |
| 최신성 "갱신 예정" = 최신 분석 이후 감시 필드 실제 변경 또는 버전 다름 | `src/app/_lib/analysis-freshness.ts:78-92` (`isRealChange`이고 `changedAt > analyzedAt`이면 stale, 버전 다르면 stale) | `analysis-freshness.test.ts:58`, `:64`, `:69`(경계), `:78`(기준점은 제외), `analysis-freshness.integration.test.ts:103`, `:114`, `:124`, `:158` |
| 화면 판정은 쿨다운을 적용하지 않는다(MUST NOT) | 같은 함수가 쿨다운 인자를 받지 않음(`analysis-freshness.ts:78-82`). SQL 쪽 쿨다운은 `repository.ts:566-575`, 별도 | `analysis-freshness.integration.test.ts:208` "쿨다운 중에는 SQL 재분석 후보에서 빠지지만, 화면은 여전히 갱신 예정(stale)이다" |
| 시나리오 "쿨다운 중에도 갱신 예정 표시" | 위와 같음 | 위 테스트(:208). 렌더 수준(상세 페이지 문구)에서 쿨다운을 다루는 테스트는 없음(부분) |

auction-collection

| 바뀐 문장 | 근거 코드 | 테스트 |
|---|---|---|
| "1단계 기본값은 지역 1곳" 삭제 | 해당 없음(삭제). 설정은 `config/collector.json`, 스키마 `src/lib/domain/config.ts` | 해당 없음 |
| 회차당 요청 수 상한: 도달하면 다음 법원 미시작, 시작한 법원은 끊지 않음, 첫 법원은 상한 무관 | `workers/collector.ts:215-225` (`index > 0 && pagesRequested >= maxRequestsPerRun`이면 `nextStart = court.courtCode; break`), 설정 `src/lib/domain/config.ts:29`, `config/collector.json:11` | `workers/__tests__/collector.test.ts:535` "maxRequestsPerRun을 넘으면 다음 법원을 시작하지 않되, 이미 시작한 법원은 끊지 않는다(3.5)". 다음 회차가 그 법원부터 이어지는 부분은 `collector.test.ts:423`(로테이션), `:504`가 지킨다 |
| 시나리오 "요청 수 상한 도달 시 다음 법원 미시작", "진행 중인 법원은 끝까지 수집" | 위와 같음 | 위 테스트(:535). 두 시나리오가 한 테스트에 같이 있다 |

auction-history

| 바뀐 문장 | 근거 코드 | 테스트 |
|---|---|---|
| 기준점은 감시 필드마다 한 항목, 값이 없는 필드는 남기지 않음 | `src/lib/db/repository.ts:321-328` (`baselineWatchedChanges`, `value === null`이면 `continue`), 호출 `:1038` | `repository.test.ts:144` "최초 저장 시 감시 필드별 기준점 행", `:207` "값이 NULL인 감시 필드는 기준점 행을 만들지 않는다", `:189`, `:358` "반복 수집에서... 최초 기준점만으로 유지" |
| 이력에 기준점 항목만 있으면 "변동 없음" 안내 | `src/app/items/[id]/page.tsx:117-121` (`listItemChanges` 후 `isRealChange` 필터), `src/app/_lib/change-history.ts` `isRealChange` | `src/app/_lib/__tests__/change-history.test.ts:53` "기준점 행만 있는 배열은 false". 상세 페이지 문구 렌더 검증은 없음(부분) |
| 목록의 "최근 변동"은 7일 이내 실제 변경, 기준점은 제외 | `src/app/_lib/change-history.ts:22` (`RECENT_CHANGE_DAYS = 7`), `:51-65`. 목록용 마지막 변경 시각의 기준점 제외는 `repository.ts`의 `last_changed_at` 계산 | `change-history.test.ts:70`, `:80`(7일 초과는 false), `repository.test.ts:631` "기준점 행은 최근 변경 시각 계산에서 제외된다" |
| 시나리오 "7일이 지난 변동" | 위와 같음 | `change-history.test.ts:80` |

auction-viewing

| 바뀐 문장 | 근거 코드 | 테스트 |
|---|---|---|
| 키워드 필터 이름에서 "소재지" 제거, 검색 범위는 소재지·사건번호·건물명 | `repository.ts:616` (`address`, `case_no`, `building_name` LIKE) | `repository.test.ts:1156` "키워드를 포함하는 물건만 남긴다", `:1162` "사건번호와 건물명도 검색 대상이다" |
| `q`의 `%`·`_`는 글자 그대로 | `repository.ts:491-498`, `:616-619` | `repository.test.ts:1171` (`%`), `:1180` (`_`) |
| 저감률은 (감정가-최저가)/감정가*100으로 판정, 유찰 여부·횟수는 조건이 아님 | `repository.ts:627-631` (`appraisal_price > 0` 조건, 유찰 컬럼을 쓰지 않음) | `repository.test.ts:1205` "지정한 최소 저감률 이상인 물건만 남긴다"(부분: 이 테스트의 물건은 모두 `failedBidCount: 1`이라 "유찰 무관"을 직접 검증하지 못한다), `item-query.test.ts:148` (파싱) |
| 감정가가 없거나 0, 최저가가 없는 물건은 저감률 필터 불통과 | `repository.ts:628-629` (`appraisal_price > 0`, NULL 산술은 거짓) | 테스트 없음(감정가 0, NULL 감정가, NULL 최저가 케이스 없음) |
| 시나리오 "저감률 30% 이상, 유찰 여부와 무관" | 위와 같음 | 위 `:1205`(부분) |
| 시나리오 "소재지 키워드 검색"(동 이름, 소재지·사건번호·건물명) | 위와 같음 | `repository.test.ts:1156`, `:1162` |
| API 파라미터 목록: page, pageSize(기본 20, 최대 200) | `src/lib/domain/item-query.ts:58` (`MAX_PAGE_SIZE = 200`), `:371` | `item-query.test.ts:221` (`MAX_PAGE_SIZE + 1` 거부), `:36`(기본값) |
| analyzed, needsAnalysis(true만), promptVersion, 함께 와야 함 | `item-query.ts:388` 및 교차검증, `repository.ts:556-561` | `item-query.test.ts:163`, `:172`, `:178`, `:183`, `:188`, `:194`; `src/app/api/items/__tests__/route.test.ts:134` |
| usage 여러 번, 50개 한도, 개별 용도 단위 매칭 | `item-query.ts:67`, `:393-395`, `repository.ts:592` | `item-query.test.ts:59`, `:131`; `repository.test.ts:1086`, `:1092` |
| minPrice·maxPrice와 minEok·minMan·maxEok·maxMan, 같은 쪽이면 원 단위 우선 | `item-query.ts:338-350`, `:423` 이하, `:497-500` | `item-query.test.ts:378`, `:384`, `:388`, `:393`, `:398`; `route.test.ts:200`, `:251` |
| minFailed, q, 지역 sido·sigungu(여러 번, 50개) | `item-query.ts:70`, `:400`, `:411-419` | `item-query.test.ts:77`(가격), `:360`(반복 파라미터 한도), `route.test.ts:186`; `repository.test.ts:1439`, `:1453` |
| dateFrom·dateTo(YYYY-MM-DD), excludePast(true만, 한국 시간 오늘 이후) | `item-query.ts:427-436`, `:541-548`, `repository.ts:673-677` | `item-query.test.ts:414`, `:420`, `:425`, `:430`, `:442`; `repository.test.ts:1485`; `route.test.ts:234`, `:241` |
| bookmarked(true/false) | `item-query.ts:438-441` | `item-query.test.ts:449`; `repository.test.ts:1511`, `:1515`; `route.test.ts:227`, `:246` |
| court, minDiscountRate(0~100), hasPhotos(true/false) | `item-query.ts:444-450`, `repository.ts:634-637` | `item-query.test.ts:148`; `repository.test.ts:1195`, `:1205`, 사진 필터 테스트(`:1219` 부근) |
| sort 5개(pricePerArea 포함), dir | `item-query.ts:34-41` | `item-query.test.ts:205`, `:212`("네 개의 sort 값"이라는 제목이 낡았다. 표현 문제로 3.2에 둔다) |
| 빈 값·역전 범위·dateFrom>dateTo·promptVersion 없는 needsAnalysis는 400 | `item-query.ts:371` 이하 스키마, `:541-548` | `item-query.test.ts:92`, `:119`, `:238`, `:393`, `:425`, `:178`; `route.test.ts:92`, `:106`, `:113`, `:134` |
| 모르는 이름의 파라미터는 무시, 스칼라가 여러 번 오면 첫 값 | `item-query.ts` 파서(strict 스키마가 아닌 화이트리스트 입력) | `item-query.test.ts:260`, `:265` |

deployment-and-health

| 바뀐 문장 | 근거 코드 | 테스트 |
|---|---|---|
| 범위는 Next.js 웹 앱, DB는 SQLite, Spring 헬스체크는 spring-backend가 정의 | `src/app/api/health/route.ts:7-33` (`getDb()`로 `SELECT 1`, 200/503) | `src/app/api/health/__tests__/route.test.ts:14` (200), `:32` (503). Spring 쪽은 `backend/src/test/java/com/auctionboss/health/HealthApiTest.java`, `HealthDatabaseDownTest.java`가 지킨다 |

run-observability

| 바뀐 문장 | 근거 코드 | 테스트 |
|---|---|---|
| 수집 워커는 겹침·백오프로 건너뛴 주기를 회차 기록으로 남김 | `workers/collector.ts:289-302` (`safeRecordSkippedRun(logger, "overlap" / "backoff")`) | `workers/__tests__/collector.test.ts:259` "...skipped/overlap으로 기록된다", `:284` "...skipped/backoff로 기록된다", `:308`, `:364` |
| 분석 워커가 겹쳐 건너뛴 주기는 회차 기록이 아니라 로그 | `workers/analyzer.ts:306-311` (경고 로그만 남기고 `return`) | 테스트 없음(`workers/__tests__/analyzer*.test.ts`에 `startAnalyzer`의 겹침 건너뜀을 다루는 테스트가 없다) |
| 회차를 기록하는 워커 종류는 수집·분석·사진 | `src/lib/domain/types.ts:388` (`WORKER_KINDS = ["collector", "analyzer", "photos"]`). 사진 워커 코드는 기록하지 않음(3.2 참고) | `src/app/api/worker-runs/__tests__/route.test.ts:58`, `:70`(collector, analyzer만). `photos`로 시작하는 테스트 없음 |
| 상태 판정: 미실행이 아니면 마지막 완료 회차가 차단이면 차단, 실패면 실패, 진행 중·건너뜀은 판정에 쓰지 않음 | `src/lib/db/worker-runs.ts:368-398` (`selectLastCompleted` 쿼리는 `outcome IN ('success','failed','blocked')`, `:204`) | `src/lib/db/__tests__/worker-runs.test.ts:399`, `:412`, `:425`, `:439` |
| 시나리오 "차단 상태"(그 뒤에 건너뜀 회차만 있어도) | 위와 같음 | `worker-runs.test.ts:439` "backoff 건너뜀은 최근 회차로 취급되지 않는다 - 직전 blocked에 이은 skip도 blocked를 유지한다" |

spring-backend

| 바뀐 문장 | 근거 코드 | 테스트 |
|---|---|---|
| 시드는 시드 적재 설정을 켠 실행에서만 적재 | `backend/src/main/java/com/auctionboss/common/seed/SeedLoader.java:24-30` (`@ConditionalOnProperty(auctionboss.seed.enabled=true)`), `backend/src/main/resources/application-seed.yml` | `backend/src/test/java/com/auctionboss/common/seed/SeedDisabledTest.java:17` "기본_test_프로필에는_로더가_없고_items는_0건이다", `SeedLoaderStartupTest.java:20` |
| 시나리오 "시드 적재 설정을 켜지 않고 시작" | 위와 같음 | `SeedDisabledTest.java:17` |
| 재분석 대상은 최신 분석 시각이 오래된 순, 같으면 id 오름차순, sort·dir 무시 | `backend/src/main/java/com/auctionboss/item/search/ItemSearchRepository.java:84-86` | `ItemSearchRepositoryTest.needsAnalysisIsOrderedByOldestAnalysisThenIdAndIgnoresSort` (:548). 기존 API와 순서가 같다는 부분은 `ContractTest`가 맡는지 확인하지 못했다(저장소 수준만 확인, 부분) |
| sido·sigungu는 여러 번 지정 가능, 하나라도 일치 | `ItemQueryParser.java:42` (`MULTI_VALUE`), `:111`, `ItemSearchRepository.java:162-163` (`sido.in(...)`) | `ItemSearchRepositoryTest.regionAndCourtFiltersMatchExactly` (:183, `sido("서울특별시", "부산광역시")` 포함). API 수준 복수값 테스트는 못 찾음(부분) |
| 시나리오 "재분석 대상 정렬", "지역 복수값" | 위와 같음 | 위 두 테스트 |

정리: 테스트가 아예 없는 문장은 3개다. (1) 분석 워커의 겹침 건너뜀을 로그로만 남김, (2) 저감률 필터에서 감정가 0·NULL, 최저가 NULL 제외, (3) `photos` 워커 종류로 회차를 시작하는 API 경로. "부분"은 저감률의 "유찰 무관", 쿨다운의 렌더 수준 검증, 상세의 "변동 없음" 안내 문구, Spring 재분석 정렬·지역 복수값의 API 수준 검증이다.

#### 1.3 validate 결과

`openspec validate align-specs-with-code --strict` -> `Change 'align-specs-with-code' is valid` (오류·경고 없음).

#### 3.2 후속 목록 (이번 change 범위 밖, 스펙은 지금 문구를 유지)

사진 워커 결함 (스펙: item-photos, run-observability). 파일은 모두 `workers/photos.ts`다.

| 결함 | 근거 | 요구하는 스펙 |
|---|---|---|
| 회차 기록 없음 | 파일 전체에 `startWorkerRun`/`finishWorkerRun`/`recordRun` 호출이 없다(`workers/analyzer.ts:102`는 호출한다). `run()`은 1-86줄에 걸쳐 로그만 남김. `WORKER_KINDS`에는 `photos`가 이미 있다(`src/lib/domain/types.ts:388`) | run-observability "실행 회차 기록"(사진 워커도 같은 형식으로 기록) |
| 차단 백오프 공유 안 됨 | `:15-23`과 `:68-76`이 `collector_state`의 키 `'backoff_until'`을 직접 읽고 쓴다. 수집 워커는 이 키를 쓰지 않고 프로세스 메모리 변수 `blockedUntil`(`workers/collector.ts:165`, `:296-302`, `:311`)만 쓰며, `COLLECTOR_STATE_KEYS`에는 로테이션 키뿐이다(`src/lib/db/collector-state.ts:18-26`). 그래서 사진 워커가 차단을 만나도 수집 워커는 멈추지 않고, 수집 워커의 차단도 사진 워커가 모른다. 또 백오프 길이가 10분 고정(`:70`)이고 `error.message.includes("HTTP")` 문자열 검사로 차단을 판정한다(`:69`) | item-photos "차단 백오프를 워커 간 공유한다", run-observability 같은 시나리오 |
| 실패 재시도 간격 없음 | `src/lib/db/repository.ts:1124-1128`의 `getPendingPhotoItems`가 `photo_status = 'failed'`를 매 호출마다 후보에 넣는다(정렬만 뒤로 보냄). 실패 시각·횟수·대기 시간 컬럼이 없다. 실패는 `:66`에서 `failed`로 기록만 한다 | item-photos "수집을 시도했으나 실패한 물건도 즉시 재시도해서는 안 된다(MUST NOT)", "실패한 물건이 대기열을 막지 않음" |
| 어댑터 우회 | `:2` `import { fetchItemDetailPhotos } from "../src/lib/sources/courtauction/detail"`. `AuctionSource` 인터페이스(`src/lib/sources/types.ts:30-40`)에는 사진 조회가 없어 워커가 소스 고유 함수를 직접 부른다. CLAUDE.md의 "소스 접근은 `AuctionSource` 어댑터 뒤로 격리" 위반 | auction-collection의 소스 격리 요구사항 |
| (덤) 테스트 없음 | `workers/__tests__/`에 `photos` 테스트가 없다 | - |

배포 설정 결함

| 결함 | 근거 |
|---|---|
| 분석 워커 주소 변수 이름 불일치 | 코드는 `AUCTIONBOSS_API_BASE`를 읽고(`workers/analyzer.ts:141`, `:282`) 없으면 `DEFAULT_API_BASE = "http://localhost:3000"`(`workers/lib/api.ts:20`)로 간다. compose는 `BASE_URL=http://web:3000`(`docker-compose.yml:37`), K8s는 `BASE_URL`=`http://auctionboss-service:3000`(`k8s/deployment-analyzer.yaml:29-30`)을 준다. 두 환경에서 분석 워커가 자기 컨테이너의 localhost로 요청한다 |
| Next 이미지에 curl 없음 | `docker-compose.yml:11` web 헬스체크가 `curl -f http://localhost:3000/api/health`인데, `Dockerfile`은 `node:22-slim` 기반이고(`Dockerfile:2`, `:13`, `:21`) curl을 설치하지 않는다(`grep curl Dockerfile` 결과 없음). 헬스체크는 항상 실패한다. 비교: `backend/Dockerfile:17`은 curl을 설치한다. K8s는 httpGet 프로브(`k8s/deployment.yaml:32-43`)라서 해당 없음 |
| compose analyzer에 ANTHROPIC_API_KEY 미전달 | `docker-compose.yml:30-37` analyzer 서비스에 `env_file`·`ANTHROPIC_API_KEY`가 없다. 컨테이너에는 CLI도 없으므로(스펙: "CLI 바이너리가 없더라도 유효한 API 키가 있으면 정상 동작") 분석이 실패한다. K8s는 `secretRef: auctionboss-secret`을 쓰지만 `k8s/secret.yaml`의 data가 비어 있어(주석뿐) 키가 없다 |

run-observability "정상 상태" 시나리오와 판정 코드 차이

- 스펙 시나리오(`specs/run-observability/spec.md` "정상 상태"): "최근에 성공 회차가 있으면 -> 정상, 마지막 성공 시각 제공"
- 코드(`src/lib/db/worker-runs.ts:368-398`): 순서가 다르다. (1) 기록이 없으면 stale. (2) 기준 시각(마지막 성공이 있으면 그 시각, 없으면 마지막 기록 시작 시각)이 기대 주기 x N보다 오래되면 stale. (3) 그렇지 않으면 마지막 **완료** 회차가 blocked면 blocked, failed면 failed, 나머지는 ok.
- 차이점: 최근에 성공 회차가 있어도 그 뒤 완료 회차가 실패·차단이면 ok가 아니다(코드가 맞고 시나리오 문구는 단순화돼 있다). 반대로 완료된 회차가 하나도 없고 진행 중 회차만 있으면(성공 없음, 주기 이내) `ok`가 되며 `lastSuccessAt`은 null이다. 이 경우는 스펙이 아무 말도 하지 않는다. 차단 상태인데 마지막 성공이 오래되면 stale이 차단보다 우선한다. 이번 change가 고친 "차단 상태"·판정 문단과는 모순되지 않으나 "정상 상태" 시나리오는 아직 코드와 다르다.
- 제안: 시나리오를 "마지막 완료 회차가 성공이고 마지막 성공이 기대 주기의 N배 이내이면 정상"으로 고치고, "완료 회차 없이 진행 중만 있는 경우"와 "미실행이 차단·실패보다 우선" 한 줄을 판정 문단에 추가한다. 테스트는 `worker-runs.test.ts:360`이 현재 시나리오 문구를 지키므로 문구 변경 시 함께 본다.

표현 문제 (메인 스펙 기준, 줄 번호는 `openspec/specs/<capability>/spec.md`)

- 빈 줄 누락(시나리오 제목 앞): auction-analysis 132 "갱신 예정 표시", 139 "소스 한계 고지"; auction-collection 34 "법원 수 상한에 따른 분할 수집", 91 "상세 조회 식별자 보존", 132 "차단 시 로테이션 위치 유지"; auction-viewing 237 "면적당 가격 정렬"; run-observability 39 "회차별 대상 법원 기록", 46 "워커 간 차단 백오프 공유". 이 중 auction-analysis 2곳, auction-collection 1곳(34), auction-viewing 1곳, run-observability 2곳은 delta 사본에도 그대로 들어 있다(delta 줄: analysis 132·143, collection 17, viewing 168, run-observability 35·42). 같은 방식으로 고치려면 delta와 메인을 함께 고쳐야 한다.
- 오타: 맞춤법 오류로 확정할 것은 찾지 못했다. 중복 단어, 이중 공백, 후행 공백, 키워드 철자(SHALL/MUST) 기계 검사는 모두 통과. 코드 쪽 표현으로는 `item-query.test.ts:212`의 테스트 제목 "네 개의 sort 값"이 낡았다(실제 5개). 스펙 용어 불일치로는 "할인율"(auction-viewing 메인의 저감률 시나리오 원문)과 "저감률"이 섞여 있었고 delta가 시나리오는 "저감률"로 통일했다.
- change 시점 말투(메인 스펙 줄): auction-collection 23 "1단계 기본값은 지역 1곳이다"(delta가 삭제), 29 "이 기능이 도입되기 전과 동일하게", 48 "이 기능 도입 전과 동일하다"; auction-viewing 30 "이 변경 이전과 달라져서는 안 된다", 115·119 "새로 추가된 조건을 지정하지 않고", "새로 추가된 어떤 필터로도"(시나리오 제목 "지정하지 않은 새 조건은 결과를 바꾸지 않음" 포함); spring-backend 124 "이 구성 추가로 영향을 받으면 안 된다"; run-observability 5 Purpose가 "수집·분석 워커"만 말하고 사진 워커를 빼놓음. 이 중 collection 29·48, viewing 30·115·119는 MODIFIED 블록 안이라 delta에서 함께 고칠 수 있다. spring-backend 124는 delta에 없는 요구사항이라 별도 delta나 직접 수정이 필요하다.
