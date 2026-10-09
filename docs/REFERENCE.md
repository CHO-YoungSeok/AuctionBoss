# 레퍼런스

AuctionBoss의 실행 구성, 설정, API, 데이터 모델을 정리한 문서입니다.
프로젝트 소개는 [README](../README.md)를 먼저 보세요.

## 목차

1. [실행 구성](#1-실행-구성)
2. [설정 파일](#2-설정-파일)
3. [환경 변수](#3-환경-변수)
4. [REST API](#4-rest-api)
5. [데이터 모델](#5-데이터-모델)
6. [워커 동작](#6-워커-동작)
7. [배포](#7-배포)
8. [Spring 백엔드 (이전 중)](#8-spring-백엔드-이전-중)
9. [운영 전환 런북](#9-운영-전환-런북)
10. [롤백 런북](#10-롤백-런북)

---

## 1. 실행 구성

| 프로세스 | 명령 | 동작 |
| --- | --- | --- |
| 웹 서버 | `npm start` | 화면과 REST API 제공. SQLite를 읽고 씁니다 |
| 수집 워커 | `npm run collector` | 시작하자마자 1회 실행하고, 이후 설정한 주기마다 반복합니다 |
| 분석 워커 | `npm run analyzer` | 웹 서버 API로 분석 대상을 받아 Claude로 분석합니다. `-- --once`를 붙이면 1회만 실행합니다 |
| 사진 워커 | `npm run photos` | 상주하며 설정한 주기마다 사진이 없는 물건의 사진을 받아 저장합니다. `-- --once`를 붙이면 1회만 실행합니다 |

분석 워커는 웹 서버에 의존하므로 서버를 먼저 띄웁니다.

위 표는 로컬 개발 구성입니다. compose·K8s 운영 구성은 5단계부터 다릅니다. 수집·사진은 Spring 백엔드가 맡고(TS `collector`·`photos` 서비스 없음), 웹은 백엔드에서 읽고(`AUCTIONBOSS_DATA_SOURCE=spring`), 분석 워커는 백엔드와 통신합니다. 7절과 9절을 보세요.

## 2. 설정 파일

수집 범위와 주기는 `config/collector.json`에서 정합니다. 값이 없거나 형식이 틀리면 워커가 시작하지 않습니다.

| 항목 | 기본값 | 설명 |
| --- | --- | --- |
| `scope.courts` | 서울 5개 법원 | 수집 대상 법원 목록 |
| `scope.maxCourtsPerRun` | 1 | 한 번 실행할 때 수집할 법원 수. 나머지는 다음 실행으로 넘어갑니다 |
| `scope.maxRequestsPerRun` | 13 | 요청 수가 이 값에 닿으면 다음 법원 수집을 시작하지 않습니다 |
| `intervalMs` | 600000 | 수집 주기 (10분) |
| `analysis.maxItemsPerRun` | 5 | 실행당 신규 분석 건수 |
| `analysis.maxReanalysisPerRun` | 2 | 실행당 재분석 건수 |
| `analysis.reanalysisCooldownHours` | 24 | 같은 물건을 다시 분석하기까지의 최소 간격 |
| `analysis.intervalMs` | 600000 | 분석 주기 (10분) |
| `photos.intervalMs` | 1800000 | 사진 워커 주기 (30분) |
| `photos.maxItemsPerRun` | 5 | 회차당 사진을 받을 물건 수 |
| `photos.requestDelayMs` | 30000 | 사진 요청 사이 간격 (30초) |
| `photos.retryAfterHours` | 24 | 사진을 받지 못한 물건을 다시 시도하기까지의 간격 |
| `observability.maxRunsPerWorker` | 1000 | 워커별로 보관할 실행 기록 수 |
| `observability.staleAfterIntervals` | 3 | 주기의 몇 배 동안 기록이 없으면 "멈춤"으로 볼지 |

## 3. 환경 변수

모두 선택 사항입니다.

**공통**

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `AUCTIONBOSS_DB` | `data/auctionboss.db` | SQLite 파일 경로 |
| `AUCTIONBOSS_CONFIG` | `config/collector.json` | 설정 파일 경로 |

**웹 서버: 화면 데이터 원천**

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `AUCTIONBOSS_DATA_SOURCE` | `sqlite` | 화면(페이지 5개와 폼·사진 라우트 3개)이 데이터를 읽는 곳. `sqlite`는 `AUCTIONBOSS_DB`의 SQLite, `spring`은 Spring API입니다. 알 수 없는 값은 허용 값을 담은 오류로 끝나고, 다른 원천으로 대신 동작하지 않습니다. 로컬 개발 기본값은 `sqlite`이고, 운영 구성(compose·K8s)은 `spring`입니다(5단계) |
| `AUCTIONBOSS_SPRING_BASE` | 없음 | `AUCTIONBOSS_DATA_SOURCE=spring`일 때 필요한 Spring 주소(예: `http://localhost:8080`). 서버에서만 쓰고 브라우저에 노출되지 않습니다. 요청마다 5초 제한을 둡니다 |

**수집 워커**

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `AUCTIONBOSS_COLLECT_INTERVAL_MS` | 설정 파일 값 | 수집 주기 |
| `AUCTIONBOSS_COLLECT_BACKOFF_MS` | 3600000 | 접속 차단을 감지했을 때 쉬는 시간 (1시간) |
| `AUCTIONBOSS_COLLECT_PAGE_DELAY_MS` | 5000 | 페이지 요청 사이 간격 |
| `AUCTIONBOSS_COLLECT_PAGE_SIZE` | 40 | 페이지당 행 수. 소스가 허용하는 최대값이 40입니다 |
| `AUCTIONBOSS_COLLECT_BID_WINDOW_DAYS` | 60 | 오늘부터 며칠 뒤 매각기일까지 수집할지 |
| `AUCTIONBOSS_COLLECT_MAX_PAGES` | 50 | 법원 하나에서 요청할 최대 페이지 수 |

**사진 워커**

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `AUCTIONBOSS_PHOTOS_INTERVAL_MS` | 설정 파일 값 | 사진 워커 주기 |
| `AUCTIONBOSS_PHOTOS_MAX_ITEMS` | 설정 파일 값 | 회차당 물건 수 |
| `AUCTIONBOSS_PHOTOS_REQUEST_DELAY_MS` | 설정 파일 값 | 요청 사이 간격 |
| `AUCTIONBOSS_PHOTOS_RETRY_AFTER_HOURS` | 설정 파일 값 | 실패 물건 재시도 간격 |

**분석 워커**

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `AUCTIONBOSS_API_BASE` | `http://localhost:3000` | 웹 서버 주소 |
| `ANTHROPIC_API_KEY` | 없음 | 있으면 Claude Messages API를 호출하고, 없으면 Claude Code CLI를 실행합니다 |
| `AUCTIONBOSS_ANALYZE_MODEL` | 없음 | 사용할 모델. 없으면 기본 모델을 씁니다 |
| `AUCTIONBOSS_ANALYZE_TIMEOUT_MS` | 120000 | 물건 1건 분석 제한 시간 |
| `AUCTIONBOSS_ANALYZE_PROMPT` | `workers/prompts/analyze-item.md` | 프롬프트 파일 경로 |
| `AUCTIONBOSS_CLAUDE_BIN` | `claude` | CLI 모드에서 실행할 파일 |

## 4. REST API

요청과 응답은 JSON이며, 입력은 zod로 검증합니다. 형식이 틀리면 400과 오류 내용을 돌려줍니다.

**물건**

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/api/items` | 물건 목록. 필터 · 정렬 · 페이지네이션 지원 |
| GET | `/api/items/:id` | 물건 1건과 최신 분석 |
| GET | `/api/items/:id/changes` | 물건의 변경 이력 |
| GET | `/api/items/usage-types` | 저장된 용도 목록 |
| GET | `/api/items/filter-options` | 목록 화면 선택지. `{ usageTypes, sidoValues, sigunguValues, courtValues }` (3단계 추가) |
| GET | `/api/items/:id/analyses` | 분석 이력과 전체 건수 `{ analyses, total }`. `limit`은 1~50 정수, 기본 10 (3단계 추가) |
| GET | `/api/items/:id/photos` | 사진 목록(파일 경로 제외) `{ photos }` (3단계 추가) |
| GET | `/api/photos/:itemId/:seq` | 저장된 물건 사진 파일 |

`GET /api/items`의 주요 파라미터는 다음과 같습니다.

| 파라미터 | 설명 |
| --- | --- |
| `page`, `pageSize` | 페이지 번호와 크기. 기본 20건, 최대 200건 |
| `sort`, `dir` | 정렬 기준(`auctionDate`, `minBidPrice`, `bidRatio`, `failedBidCount`, `pricePerArea`)과 방향(`asc`, `desc`) |
| `q` | 소재지 · 사건번호 · 건물명 키워드 |
| `sido`, `sigungu`, `court` | 지역과 법원 |
| `usage` | 용도. 여러 번 줄 수 있습니다 |
| `minPrice`, `maxPrice` | 최저매각가격 범위 (원) |
| `minFailed`, `minDiscountRate` | 최소 유찰횟수, 최소 저감률. 저감률은 0~100 사이 정수입니다. 예를 들어 30은 감정가보다 30% 이상 내려간 물건입니다 |
| `dateFrom`, `dateTo`, `excludePast` | 매각기일 범위, 지난 기일 제외 |
| `bookmarked`, `hasPhotos`, `analyzed` | 관심 물건, 사진 유무, 분석 유무 |
| `needsAnalysis`, `promptVersion` | 분석 워커 전용. 재분석이 필요한 물건만 조회 |

**분석과 워커 기록** (분석 워커와 수집 워커가 사용)

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| POST | `/api/analyses` | 분석 결과 저장 |
| GET | `/api/worker-runs` | 워커 실행 기록 목록 |
| POST | `/api/worker-runs` | 실행 시작 기록 |
| PATCH | `/api/worker-runs/:id` | 실행 종료 기록 (결과, 처리 건수, 오류) |
| GET | `/api/worker-runs/summary` | 최근 기간의 성공률 · 차단 횟수 집계 (`since`의 시간대 오프셋은 UTC로 정규화해 비교) |
| GET | `/api/worker-runs/status?worker=` | 워커 상태 판정 `{ state, lastSuccessAt, lastRun }`. `worker`는 `collector`, `analyzer`, `photos` (3단계 추가) |
| GET | `/api/collector-state/rotation` | 다음 수집 로테이션 법원 `{ nextCourtCode }` (3단계 추가) |

**관심 물건과 피드**

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/api/bookmarks` | 관심 물건 목록 |
| POST | `/api/bookmarks` | 관심 등록 (중복 등록은 무시) |
| DELETE | `/api/bookmarks/:itemId` | 관심 해제 |
| GET | `/api/feed` | 관심 물건의 변동 피드 |
| POST | `/api/feed/read` | 피드 읽음 처리 |
| POST | `/api/bookmarks/toggle`, `/api/feed/mark-read` | 화면의 폼 제출용. 처리 후 원래 화면으로 돌아갑니다 |

**운영**

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/api/health` | DB 연결 상태. 정상이면 200, 아니면 503 |

> 인증은 없습니다. 개인용 · 내부망 사용을 전제로 합니다.

## 5. 데이터 모델

SQLite 테이블 8개로 구성됩니다. 스키마는 `src/lib/db/schema.ts`에 있습니다.

| 테이블 | 내용 |
| --- | --- |
| `items` | 경매 물건. 소재지, 용도, 감정가, 최저매각가격, 매각기일, 유찰횟수, 진행상태, 면적 등. `photo_attempted_at`은 마지막 사진 시도 시각 |
| `item_changes` | 감시 필드(최저매각가격, 유찰횟수, 매각기일, 진행상태)의 변경 이력. 이전 값과 새 값을 저장 |
| `analyses` | AI 분석 결과. 본문, 모델, 프롬프트 버전, 분석 시각 |
| `item_photos` | 저장된 물건 사진의 메타데이터. 파일은 `data/photos/`에 저장 |
| `bookmarks` | 관심 물건 |
| `feed_reads` | 피드를 어디까지 읽었는지 |
| `worker_runs` | 워커 실행 기록. 결과는 실행 중 · 성공 · 실패 · 차단 · 건너뜀 중 하나 |
| `collector_state` | 워커 상태 값. 다음 차례 법원, `backoff_until`(접속 차단 백오프 종료 시각. 수집 워커와 사진 워커가 공유) |

## 6. 워커 동작

### 수집 워커

1. 이번 차례의 법원을 고릅니다. 실행할 때마다 다음 법원으로 넘어갑니다.
2. 페이지를 하나씩 요청하고, 요청 사이에 5초를 쉽니다. 동시 요청은 하지 않습니다.
3. 응답마다 세 가지를 확인합니다. 본문이 JSON인지, 접속 허용 플래그가 정상인지, 스키마를 통과하는지입니다.
4. 정상 응답은 도메인 모델로 바꿔 저장합니다. 감시 필드가 바뀐 물건은 변경 이력을 남깁니다.
5. 접속 차단을 감지하면 즉시 멈추고, 1시간 동안 다음 실행을 건너뜁니다. 이 백오프(`backoff_until`)는 사진 워커와 공유합니다.

이전 실행이 아직 끝나지 않았으면 이번 주기는 건너뛰고, 건너뛴 사실도 기록합니다.

### 사진 워커

1. 공유 백오프가 남아 있으면 이번 회차는 건너뛰고 기록합니다.
2. 사진이 없고 `photo_attempted_at`이 없거나 재시도 간격(24시간)이 지난 물건을 회차 상한(5건)만큼 고릅니다.
3. `AuctionSource` 어댑터로 물건마다 사진을 요청하고, 요청 사이에 30초를 쉽니다.
4. 받은 사진은 `data/photos/`에 저장하고 `item_photos`에 기록합니다. 시도한 물건은 `photo_attempted_at`을 갱신합니다.
5. 접속 차단을 감지하면 즉시 멈추고 공유 백오프를 늘립니다. 수집 워커도 이 백오프 동안 쉽니다.

### 분석 워커

1. 신규 분석 대상을 먼저 조회합니다. 분석 결과가 없는 물건입니다.
2. 남은 한도로 재분석 대상을 조회합니다. 분석 후 감시 필드가 바뀌었거나, 예전 프롬프트 버전으로 분석한 물건입니다. 최근 24시간 안에 분석한 물건은 제외합니다.
3. 면적당 가격과 차수별 저감률을 코드로 먼저 계산해 프롬프트에 넣습니다.
4. 물건을 하나씩 순서대로 분석하고 결과를 API로 저장합니다. 한 건이 실패해도 다음 물건으로 넘어갑니다.

## 7. 배포

| 방식 | 파일 | 내용 |
| --- | --- | --- |
| Docker | `Dockerfile` | 멀티 스테이지 빌드. SQLite 파일은 `/app/data` 볼륨에 저장 |
| Docker Compose | `docker-compose.yml` | 운영 구성: `mysql` · `backend`(prod 프로필, 수집·사진·API) · `web`(spring 원천) · `analyzer`(→ backend). TS 수집·사진 서비스는 없고, `backend`가 수집·사진 주기 실행과 외부 요청 허용(세 설정)을 켭니다. 볼륨은 `mysql-data`, `photos-data`(백엔드 `/app/photos`)이고 `auctionboss-data`(옛 SQLite)는 롤백 창 동안 선언만 남깁니다. DB 변수(`DB_NAME`·`DB_USER`·`DB_PASSWORD`·`MYSQL_ROOT_PASSWORD`)는 필수(`${VAR:?}`)이고 `ANTHROPIC_API_KEY`만 선택입니다. web은 backend가 healthy가 된 뒤 시작하고, web 헬스체크는 curl 없이 Node 전역 `fetch`로 `/api/health`가 200인지 확인(웹은 백엔드 헬스체크로 판정). **이전 완료 표식이 없으면 backend가 기동을 거부합니다**(9절) |
| 스모크 | `docker-compose.smoke.yml`, `scripts/docker-smoke.sh` | 독립 프로젝트(`auctionboss-smoke`)로 `mysql`·`backend`만, `local,seed` 프로필(시드 809건), 호스트 포트 18080. 수집·사진·외부 요청 허용 없음. 스크립트는 이 파일과 `-p auctionboss-smoke`만 쓰므로 끝의 `down -v`가 운영 볼륨을 지우지 않습니다 |
| Kubernetes | `k8s/` | Kustomize 매니페스트(정적 검증만). 웹(컨테이너 하나, 볼륨 없음) · 백엔드(`replicas: 1`, `Recreate`, 사진 PVC, 세 설정 켬) · MySQL(StatefulSet, 영속 볼륨) · 분석 워커(→ 백엔드 서비스). Secret은 키 이름만 있고 값은 `kubectl create secret`으로 만듭니다. 자세한 내용은 `deploy/k8s/README.md` |
| CI | `.github/workflows/ci.yml` | 타입 검사 → 테스트 → 빌드 → 린트. OpenSpec 스펙·change 엄격 검증 잡 포함 |

## 8. Spring 백엔드 (이전 중)

`backend/`는 기존 백엔드를 Spring Boot + MySQL로 옮기는 새 백엔드입니다. 1단계에서 읽기 API를, 2단계에서 쓰기 API를, 3단계에서 화면용 읽기 API 5개를, 4단계에서 수집·사진 워커와 소스 어댑터를 옮겼고, 5단계에서 데이터 이전 도구와 배포 구성 전환(compose·K8s가 백엔드 중심)을 했습니다. 실제 전환은 9절 런북으로 사람이 확인한 뒤 실행합니다. Spring의 수집·사진 워커는 코드 기본값이 꺼짐이고, 운영 배포 구성(compose·K8s의 백엔드)만 켭니다. 단계는 [로드맵](ROADMAP.md)에 있습니다.

| 항목 | 내용 |
| --- | --- |
| 스택 | Java 21, Spring Boot 4.1, JPA + QueryDSL 7, Flyway, MySQL 8.4 |
| 포트 | 8080 |
| 제공 API | `GET /api/items`, `/api/items/:id`, `/api/items/:id/changes`, `/api/items/usage-types`, `/api/health`. 경로·파라미터·응답 형태는 4절의 기존 API와 같습니다 |
| 쓰기·나머지 API | `POST /api/analyses`, `POST /api/worker-runs`, `PATCH /api/worker-runs/:id`, `GET /api/worker-runs`, `GET /api/worker-runs/summary`, `GET·POST /api/bookmarks`, `DELETE /api/bookmarks/:itemId`, `GET /api/feed`, `POST /api/feed/read`, `GET /api/photos/:itemId/:seq`. 요청 검증과 응답은 기존 API와 같고, 시나리오 계약 테스트 7개·115단계로 비교합니다 |
| 인증·노출 | 인증이 없습니다(7단계 예정). 쓰기 API가 열려 있으므로 compose는 8080을 루프백(`127.0.0.1`)에만 엽니다. 외부에 노출하지 않습니다 |
| 화면용 읽기 API(3단계) | `GET /api/items/filter-options`, `/api/items/:id/analyses`, `/api/items/:id/photos`, `/api/worker-runs/status`, `/api/collector-state/rotation`. 4절의 같은 경로 Next 라우트가 계약 원본이고, 시나리오 골든(`screen-reads`, `worker-status`)으로 비교합니다. 선택지는 `COLLATE utf8mb4_0900_bin`으로 SQLite와 같은 구분·정렬을 합니다 |
| 화면 폼 엔드포인트 | `POST /api/bookmarks/toggle`, `POST /api/feed/mark-read`(303 리다이렉트)는 Spring에 없고 Next에 남습니다. 데이터 포트로 Spring의 `bookmarks`·`feed/read`를 부릅니다 |
| 분석 워커 연결 | 분석 워커는 코드 변경 없이 `AUCTIONBOSS_API_BASE`만 바꿔 Spring에 저장할 수 있습니다(개발 환경 검증: `scripts/dev/verify-analyzer-on-spring.sh`, 수동). 운영 전환은 5단계입니다 |
| 수집·사진 워커(4단계) | 소스 어댑터(`collect.source.courtauction`)와 수집·사진 회차, 스케줄러, 단일 실행 잠금을 Java로 옮겼습니다. 기본 꺼짐이고 켜는 방법·설정은 아래 "수집·사진 워커 설정"에 있습니다. 같은 입력에서 TS와 같은 요청·저장 결과가 나오는 것은 어댑터 골든 34사례와 저장 골든 10시나리오·44단계로 비교합니다 |
| 스키마 | `backend/src/main/resources/db/migration/V1__baseline.sql`. 5절의 테이블 8개를 컬럼 이름까지 그대로 옮겼습니다. 금액은 BIGINT, 시각은 UTC `DATETIME(3)` |
| 시드 | `seed` 프로필에서 DB가 비어 있을 때만 `db/seed/*.sql`을 넣습니다. 실명을 가린 물건 809건, 변경 이력 4,008건, 분석 12건 |
| 계약 테스트 | 기존 API 응답 90개와 시나리오 10개·171단계를 정답으로 저장해 두고, 같은 요청에 같은 JSON이 나오는지 비교합니다 |
| 화면 데이터 포트 | `src/lib/data-port`가 화면의 데이터 접근(읽기 13, 쓰기 3, 사진 파일 1)을 한 곳에 모읍니다. 구현체는 SQLite와 Spring 둘이고 `AUCTIONBOSS_DATA_SOURCE`로 고릅니다(3절). 화면 한 장이 Spring으로 보내는 요청은 최대 `/` 6, `/items/:id` 5, `/bookmarks` 2, `/feed` 2, `/status` 11개입니다. `src/app/**`에서 `@/lib/db`·`better-sqlite3`를 가져오면 린트가 실패합니다(기존 JSON API 라우트 제외) |

**수집·사진 워커 설정 (4단계, 기본 꺼짐)**

Spring의 수집·사진 워커는 설정으로 명시해 켜기 전에는 스케줄러 빈조차 만들어지지 않습니다. 소스 HTTP 클라이언트는 외부 요청 허용 설정이 따로 없으면 루프백이 아닌 주소로 요청을 보내지 않습니다. 이 두 겹은 별개이고, 실제 사이트로 요청이 나가려면 둘 다 켜야 합니다. 세 설정을 켜는 곳은 compose `backend`와 K8s 백엔드 Deployment뿐이고(스모크·개발 스크립트·CI에는 이름도 없음), `deploy-config.test.ts`가 고정합니다. 환경 변수는 Spring의 이름 규칙으로 속성 이름을 바꾼 것입니다(`.`·`-`를 `_`로, 대문자로. 예: `auctionboss.source.page-delay-ms` → `AUCTIONBOSS_SOURCE_PAGE_DELAY_MS`).

| 속성 | 환경 변수 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `auctionboss.collector.enabled` | `AUCTIONBOSS_COLLECTOR_ENABLED` | `false` | 수집 스케줄러를 만듭니다(첫 겹) |
| `auctionboss.photos.enabled` | `AUCTIONBOSS_PHOTOS_ENABLED` | `false` | 사진 스케줄러를 만듭니다(첫 겹) |
| `auctionboss.source.external-requests-allowed` | `AUCTIONBOSS_SOURCE_EXTERNAL_REQUESTS_ALLOWED` | `false` | `false`이면 루프백이 아닌 주소는 소켓을 열기 전에 거절합니다(둘째 겹) |
| `auctionboss.source.base-url` | `AUCTIONBOSS_SOURCE_BASE_URL` | 법원경매정보 주소 | 소스 주소. 테스트·개발 검증은 루프백 가짜 서버를 가리킵니다 |
| `auctionboss.source.page-size` / `page-delay-ms` / `bid-window-days` / `max-pages` | `AUCTIONBOSS_SOURCE_PAGE_SIZE` 등 | 40 / 5000 / 60 / 50 | 3절 `AUCTIONBOSS_COLLECT_*`와 같은 뜻 |
| `auctionboss.collector.run-immediately` / `auctionboss.photos.run-immediately` | `AUCTIONBOSS_COLLECTOR_RUN_IMMEDIATELY` 등 | `true` | 기동 직후 회차를 한 번 실행할지 |
| `auctionboss.collector.max-courts-per-run` / `max-requests-per-run` | `AUCTIONBOSS_COLLECTOR_MAX_COURTS_PER_RUN` 등 | 설정 파일 값 | 설정 파일의 회차당 법원 수·요청 수 상한을 덮어씁니다 |
| `auctionboss.collector.block-backoff-ms` | `AUCTIONBOSS_COLLECTOR_BLOCK_BACKOFF_MS` | 3600000 | 차단 시 공유 백오프 길이 |
| `auctionboss.photos.max-items-per-run` | `AUCTIONBOSS_PHOTOS_MAX_ITEMS_PER_RUN` | 설정 파일 값 | 회차당 물건 수 |
| `auctionboss.photos.dir` | `AUCTIONBOSS_PHOTOS_DIR` | `data/photos` | 사진 파일 디렉터리. 읽기 API와 사진 워커가 같은 값을 씁니다 |
| `auctionboss.config-path` | `AUCTIONBOSS_CONFIG_PATH` | 없음 | `config/collector.json` 위치. 수집 범위·주기·사진 설정은 호출마다 이 파일에서 읽습니다 |
| `auctionboss.workers.shutdown-wait-ms` | `AUCTIONBOSS_WORKERS_SHUTDOWN_WAIT_MS` | 30000 | 종료 시 진행 중 회차를 기다리는 상한. 넘으면 회차 스레드를 중단합니다 |

켜졌을 때의 동작: 고정 주기 틱마다 MySQL `GET_LOCK`(워커별 이름)으로 단일 실행을 보장합니다. 잠금을 못 얻으면 실행하지 않고 `skipped`(`error_kind=overlap`)를, 공유 백오프가 남았으면 `skipped(backoff)`를 기록합니다. 스케줄러가 켜질 때 "기존(TS) 수집기·사진 워커가 같은 소스에 요청하고 있으면 안 된다"는 경고를, 기동할 때마다 두 워커와 외부 요청 허용 상태를 로그로 남깁니다.

**1회 실행 모드 (개발 검증·실제 사이트 최소 확인용)**

웹 서버와 스케줄러 없이 틱 하나만 돌리고 종료합니다. 같은 단일 실행 잠금·공유 백오프 확인·회차 기록을 거칩니다. 종료 코드는 성공 0, 건너뜀·차단·실패·시간 초과·회차 미시작 1입니다. 스케줄러를 켜는 설정과 같이 주면 기동이 실패하고, 외부 요청 허용 설정은 건드리지 않습니다.

```bash
# 수집 1회: 법원 1곳, 페이지 1개 (요청 2개: 세션, 검색). 실제 사이트로 나가는 명령이므로 사람이 한 번만 실행
java -jar backend.jar --auctionboss.run-once=collector --auctionboss.source.external-requests-allowed=true \
  --auctionboss.source.max-pages=1 --auctionboss.collector.max-courts-per-run=1
# 사진 1회: 대기 조건을 만족하는 물건 하나 (요청 2개: 세션, 상세)
java -jar backend.jar --auctionboss.run-once=photos --auctionboss.source.external-requests-allowed=true \
  --auctionboss.photos.only-item-id=<id>
```

환경 변수로는 `AUCTIONBOSS_RUN_ONCE=collector|photos`이고, 대기 상한은 `auctionboss.run-once-timeout-ms`(기본 30분)입니다. 요청 허용을 주지 않으면 소켓을 열기 전에 거절되어 종료 코드 1입니다.

**개발 검증 스크립트 (수동, Docker·JDK 필요, CI에서 안 돌림)**

| 스크립트 | 하는 일 | 외부 요청 |
| --- | --- | --- |
| `scripts/dev/verify-collector-on-spring.sh` | 임시 MySQL과 루프백 가짜 소스 서버에 Spring을 붙여 수집·사진 전체 경로(저장·API·사진 파일)와, Spring 둘이 같은 MySQL을 볼 때 회차가 겹치지 않는지 확인합니다 | 없음(가짜 서버만) |
| `scripts/dev/live-check-collector.sh` | 실제 사이트 최소 확인 절차를 고정한 스크립트입니다. 기본은 dry-run(가짜 서버, 임시 SQLite). 사전 확인(TS 워커 정지, 백오프 만료, 직전 TS 회차 15분 이상) 뒤 수집 1회·사진 1회를 하고 TS SQLite(읽기 전용)와 비교합니다 | `--i-confirm-live`를 줘야만. 요청 합계 4, 사진 전 대기 60초 이상 |

**동시 운영 금지**

TS 수집기·사진 워커와 Spring 수집기·사진 워커를 동시에 켜면 안 됩니다. 두 수집기는 서로 다른 DB(SQLite와 MySQL)의 백오프와 로테이션 위치를 보므로 어떤 잠금으로도 서로를 막을 수 없어, 요청 예산이 두 배가 되고 한쪽이 차단돼도 다른 쪽이 모릅니다. 5단계 배포 구성은 compose·K8s에서 TS 수집·사진 서비스를 없애고, `deploy-config.test.ts`가 "수집기가 동시에 둘 이상 켜지는 구성이 없음"을 고정합니다. 전환 절차는 9절, 되돌리기는 10절입니다.

**데이터 이전 1회 실행 모드 (5단계)**

`auctionboss.run-once`에 아래 값을 주면 웹 서버와 스케줄러 없이 한 번 실행하고 종료합니다(종료 코드 성공 0, 실패 1, 로그는 `[import]` 줄). 세 모드 모두 `auctionboss.collector.enabled`·`auctionboss.photos.enabled`가 참이면 기동을 거부하므로 운영 compose에서는 두 값을 끄고 실행합니다(9절 명령 참고).

| 모드 | 설정 | 하는 일 |
| --- | --- | --- |
| `import` | `auctionboss.import.dir`(내보내기 디렉터리, 필수), `auctionboss.import.replace`(기본 `false`: 대상이 비어 있지 않으면 중단, `true`: FK 역순 `DELETE` 뒤 다시 적재), `auctionboss.import.dry-run`(기본 `false`: `true`면 전부 실행하고 롤백), 사진 대상 `auctionboss.photos.dir` | 한 트랜잭션으로 8개 테이블을 id 그대로 적재하고 행 수·정규화 해시를 매니페스트와 대조, 사진 파일을 복사·해시 대조한 뒤 이전 완료 표식(`collector_state.migration.completed`)을 씁니다 |
| `export-state` | 없음 | 표준 출력에 `{"backoffUntil":"…Z"\|null,"rotationNextCourtCode":"…"\|null}` 한 줄. 롤백 때 `scripts/migrate/rollback-state.ts`가 읽습니다 |
| `delta-report` | `auctionboss.delta.since=<ISO UTC>`(이상, `>=`) | 그 시각 이후 테이블별로 생긴 건수 한 줄(`items`, `item_changes`, `analyses`, `worker_runs`, `bookmarks`, `item_photos`). 값은 출력하지 않습니다 |

환경 변수로는 `AUCTIONBOSS_RUN_ONCE`, `AUCTIONBOSS_IMPORT_DIR`, `AUCTIONBOSS_IMPORT_REPLACE`, `AUCTIONBOSS_IMPORT_DRY_RUN`, `AUCTIONBOSS_DELTA_SINCE`입니다.

**프로필**

| 프로필 | 용도 |
| --- | --- |
| `local` | 로컬 MySQL 접속. 저장소 루트 `.env`(git 미추적)에서 `DB_*` 값을 읽습니다 |
| `seed` | 시드 로더를 켭니다. 운영에서는 쓰지 않습니다 |
| `test` | Testcontainers MySQL로 테스트합니다 |

**환경 변수**

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | `localhost`, `3306`, `auctionboss`, … | MySQL 접속 정보. `.env.example` 참고 |
| `AUCTIONBOSS_CONFIG_PATH` | `../config/collector.json` 또는 `config/collector.json` | 재분석 최소 간격을 읽을 설정 파일 |
| `MYSQL_ROOT_PASSWORD` | 없음 | compose의 MySQL 컨테이너 root 비밀번호 |
| `MYSQL_HOST_PORT` | `3307` | compose의 MySQL을 내 컴퓨터에서 접속할 포트 |

**실행**

```bash
cp .env.example .env
# 시드로 띄워 보기(스모크 구성, 별도 프로젝트·볼륨·포트 18080). 운영 구성은 `docker compose up`이지만 이전 완료 표식이 필요합니다(9절)
docker compose -p auctionboss-smoke -f docker-compose.smoke.yml up -d --wait   # http://localhost:18080/api/items
scripts/docker-smoke.sh                   # 처음 기동과 재기동(데이터 유지)을 자동으로 확인(같은 스모크 프로젝트만 지웁니다)
npm run db:up                             # IDE 개발용 MySQL 켜기 (db:down 끄기, db:status 상태. 데이터는 보존)
(cd backend && ./gradlew bootRun --args='--spring.profiles.active=local,seed')   # IDE 개발용
(cd backend && ./gradlew check)           # 테스트 (Docker 필요)
```

**화면을 Spring으로 띄워 보기 (개발용)**

로컬 개발 기본값은 `sqlite`입니다. 화면이 Spring에서도 같게 나오는지 보려면 Spring을 띄운 뒤 웹 서버를 `spring` 모드로 실행합니다. 이때 SQLite 파일은 열지 않으므로 Spring이 꺼지면 화면이 500으로 끝납니다.

```bash
AUCTIONBOSS_DATA_SOURCE=spring AUCTIONBOSS_SPRING_BASE=http://localhost:8080 npm run dev
bash scripts/dev/compare-screens.sh   # 임시 MySQL+Spring+SQLite에 두 모드를 띄워 화면 HTML 비교, 응답 시간, Spring 중단 확인 (Docker·JDK 필요, 수동)
```

---

기능별 요구사항은 [openspec/specs](../openspec/specs/)에, 개발 중 작성한 상세 기록은 [개발 기록](DEVELOPMENT_NOTES.md)에 있습니다.

---

## 9. 운영 전환 런북

SQLite(TS 구성)에서 MySQL·Spring 백엔드로 옮기는 절차입니다. 리허설과 실제 전환이 같은 문서를 따릅니다. 단계마다 `date -u`로 시각을 적고, 비밀번호 같은 값은 화면에 출력하지 않습니다. 각 단계의 근거는 `openspec/changes/migrate-data-and-cutover/design.md` D10입니다.

**첫 줄 주의**: 5장 구성 커밋 이후의 `docker compose up`은 곧 운영 전환입니다. 이전 완료 표식(MySQL `collector_state`의 `migration.completed`)이 없으면 `prod` 프로필의 backend가 기동을 거부하고, 그에 묶인 web·analyzer도 뜨지 않습니다. 표식 없이 `docker compose up`을 하지 마세요.

| 기록 | 값 |
| --- | --- |
| 전환 직전 구성 커밋 | `8cd214b` (롤백 때 TS 구성을 되살리는 기준) |
| 이전 원본 | `data/auctionboss.db` (compose 볼륨 `auctionboss_auctionboss-data`는 빈 DB) |
| T0 쓰기 정지 | `____` (UTC) |
| 내보내기 시작·끝 | `____` / `____` |
| 가져오기(본 실행) 시작·끝 | `____` / `____` |
| API 비교 요청 수·불일치 | `____` / `____` |
| T1 켬 | `____` |
| T2 확인 끝 | `____` |
| 다운타임(T2−T0) | `____` |
| 수집 공백(백엔드 첫 수집 회차 시작 − TS 마지막 수집 회차 종료) | `____` |
| TS 마지막 수집 회차 종료 | `____` |

1. **사전 확인**: 4단계 아카이브, 게이트 5종(`npx tsc --noEmit`, `npm test`, `npm run build`, `npm run lint`, `cd backend && ./gradlew check`), `docker compose config -q`가 오류 없이 해석되는지, `.env`에 `DB_NAME`·`DB_USER`·`DB_PASSWORD`·`MYSQL_ROOT_PASSWORD`가 있는지(값은 보지 않음), SQLite `collector_state`의 `backoff_until`이 과거이거나 없는지, TS 마지막 수집 회차 종료 시각을 적습니다.
2. **쓰기 정지(T0, 다운타임 시작)**: 전환 직전 구성(옛 compose)으로 TS 서비스를 멈춥니다. 현재 파일에는 `collector`·`photos` 서비스가 없으므로 옛 파일을 표준 입력으로 줍니다. 진행 중인 회차가 없는지 확인합니다.
   ```bash
   git show 8cd214b:docker-compose.yml | docker compose -p auctionboss --project-directory . -f - stop collector photos analyzer web
   ```
3. **백업·내보내기**: 원본 스냅숏은 `better-sqlite3` 백업 API로 뜨고 그 SHA-256이 매니페스트에 적힙니다. 결과는 `data/migration/<시각>/`(git 무시)입니다. 사진은 `item_photos`가 가리키는 파일만 복사됩니다. 매니페스트의 테이블별 행 수가 1.3 실측 이상인지 봅니다. 롤백 기준이므로 롤백 창 동안 지우지 않습니다.
   ```bash
   npx tsx scripts/migrate/export.ts --source data/auctionboss.db
   ls data/migration/
   ```
4. **구성 전환**: 전환 커밋을 체크아웃한 상태에서 MySQL만 올립니다. 운영 프로필 MySQL 볼륨이 시드로 차 있다면 5에서 `replace`로 교체합니다.
   ```bash
   docker compose up -d --wait mysql
   ```
5. **가져오기**: 드라이런 1회 → 본 실행. `replace`는 대상이 시드뿐임을 드라이런 보고로 확인한 경우에만 줍니다. 스케줄러는 반드시 끕니다(`AUCTIONBOSS_COLLECTOR_ENABLED=false`, `AUCTIONBOSS_PHOTOS_ENABLED=false`). 내보내기 디렉터리는 읽기 전용으로 마운트합니다.
   ```bash
   EXP=$PWD/data/migration/<시각>
   RUN="docker compose run --rm -v $EXP:/import:ro \
     -e AUCTIONBOSS_COLLECTOR_ENABLED=false -e AUCTIONBOSS_PHOTOS_ENABLED=false \
     -e AUCTIONBOSS_IMPORT_DIR=/import"
   $RUN -e AUCTIONBOSS_RUN_ONCE=import -e AUCTIONBOSS_IMPORT_DRY_RUN=true backend   # 드라이런
   $RUN -e AUCTIONBOSS_RUN_ONCE=import backend                                       # 본 실행
   ```
   테이블별 행 수·해시 8/8 일치와 사진 대조가 로그에 나와야 합니다. 하나라도 어긋나면 6으로 가지 않고 10절로 갑니다.
6. **검증**: 백엔드를 스케줄러 끈 채 띄우고(`docker compose run -d --service-ports --name auctionboss-verify -e AUCTIONBOSS_COLLECTOR_ENABLED=false -e AUCTIONBOSS_PHOTOS_ENABLED=false backend`), 백업 스냅숏(`$EXP/source.db`)과 API를 전수 비교합니다. 불일치가 1건이라도 있으면 7로 가지 않고 10절로 갑니다. 끝나면 `docker rm -f auctionboss-verify`.
   ```bash
   npx tsx scripts/migrate/compare-api.ts --source-db $EXP/source.db --spring-base http://localhost:8080
   SQLITE_DB=$EXP/source.db SPRING_BASE=http://localhost:8080 SKIP_FORMS=1 bash scripts/dev/compare-screens.sh
   ```
7. **켬(T1)**: 백엔드 첫 수집 틱이 TS 마지막 회차 종료 + 수집 주기(`config/collector.json`의 `intervalMs`) 이후인지 확인합니다(아니면 백엔드 기동을 그만큼 늦춥니다). 남아 있는 옛 컨테이너는 `--remove-orphans`로 정리합니다.
   ```bash
   docker compose up -d --remove-orphans backend web analyzer
   ```
8. **확인(T2, 다운타임 끝)**: `curl -fsS http://localhost:3000/api/health`, 화면 5개(`/`, `/items/<id>`, `/bookmarks`, `/feed`, `/status`) 200, 백엔드 첫 수집·사진 회차 결과(결과 종류, 요청 페이지 수, 신규·갱신·변경 건수), 분석 워커 첫 회차 성공, `git diff --stat <시작 커밋> -- workers/analyzer.ts workers/lib workers/prompts`가 0줄인지 확인합니다. 다운타임 = T2 − T0, 수집 공백은 이전된 `worker_runs`로 MySQL 쿼리 하나로 잽니다.

전환 뒤 운영 스택을 계속 켜 둘지는 확인이 끝난 뒤 사람이 정합니다(켜 두면 실제 사이트로 주기 요청이 나갑니다).

## 10. 롤백 런북

MySQL → SQLite 역이전 도구는 없습니다. 롤백 창(전환 뒤, 회차 기준은 design.md 결정 기록 2) 안에서는 전환 직전 백업(`data/migration/<시각>/source.db`)과 손대지 않은 원본 SQLite(`data/auctionboss.db`)로 되돌리고, 그 사이 MySQL에 생긴 데이터는 버립니다. 잃으면 안 되는 차단 백오프와 로테이션 위치만 되씁니다.

1. **수집·쓰기 멈추기**: 백엔드(스케줄러)·분석 워커·웹을 멈춥니다. MySQL은 켜 둡니다(아래 1회 실행이 씁니다).
   ```bash
   docker compose stop backend analyzer web
   ```
2. **델타 보고**: 전환 시각(T1) 이후 MySQL에 생긴 건수를 기록합니다(값은 출력되지 않음).
   ```bash
   docker compose run --rm -e AUCTIONBOSS_COLLECTOR_ENABLED=false -e AUCTIONBOSS_PHOTOS_ENABLED=false \
     -e AUCTIONBOSS_RUN_ONCE=delta-report -e AUCTIONBOSS_DELTA_SINCE=<T1 ISO UTC> backend
   ```
3. **상태 내보내기**: MySQL의 `backoffUntil`과 로테이션 위치를 JSON 한 줄로 받습니다.
   ```bash
   docker compose run --rm -T -e AUCTIONBOSS_COLLECTOR_ENABLED=false -e AUCTIONBOSS_PHOTOS_ENABLED=false \
     -e AUCTIONBOSS_RUN_ONCE=export-state backend | grep '^{"backoffUntil"' > state.json
   ```
4. **상태 되쓰기**: MySQL 백오프가 SQLite 값보다 늦을 때만 쓰고, 로테이션 위치는 값이 있으면 덮어씁니다. 대상은 전환 때 손대지 않은 원본 `data/auctionboss.db`입니다(이전 원본이 이 파일이라는 1.2 확정에 따름. 경로는 필수 인자이고 파일이 없으면 새로 만들지 않고 실패합니다).
   ```bash
   npx tsx scripts/migrate/rollback-state.ts --sqlite data/auctionboss.db --state state.json
   ```
5. **TS 구성 기동**: 전환 직전 커밋(`8cd214b`)의 compose로 `web`·`collector`·`photos`·`analyzer`를 올립니다. 먼저 백엔드가 멈춰 있는지 확인합니다(TS 수집기와 동시에 돌면 안 됩니다). 옛 compose는 볼륨 `auctionboss_auctionboss-data`를 쓰는데 이 볼륨의 DB는 비어 있으므로(1.2), 원본 파일과 사진을 볼륨에 복사한 뒤 올립니다. 원본 `data/`는 그대로 남습니다.
   ```bash
   docker compose ps backend   # 실행 중이 아니어야 함
   docker run --rm -v auctionboss_auctionboss-data:/dest -v "$PWD/data":/src:ro alpine \
     sh -c 'cp -a /src/auctionboss.db /dest/ && cp -a /src/photos /dest/ 2>/dev/null; true'
   git show 8cd214b:docker-compose.yml | docker compose -p auctionboss --project-directory . -f - up -d web collector photos analyzer
   ```
   (`mysql`·`backend`는 올리지 않습니다. 볼륨이 손상됐거나 되돌린 상태를 의심할 때는 `$EXP/source.db`를 같은 방식으로 복사합니다.)
6. 롤백 소요 시간과 델타 건수, 원인을 기록합니다. 롤백 창이 끝난 뒤의 롤백은 git 되돌리기와 6단계 백업 체계의 몫입니다.
