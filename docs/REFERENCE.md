# 레퍼런스

AuctionBoss의 실행 구성, 설정, API, 데이터 모델, 운영 절차를 정리한 문서입니다. **5단계(2026-10-09) 이후 운영 구성 기준**입니다: Spring Boot + MySQL 백엔드가 데이터와 수집·사진 워커를 맡고, Next.js 웹과 분석 워커는 HTTP로만 백엔드와 통신합니다. SQLite·TS 수집기·Next JSON API는 은퇴했습니다(태그 `pre-retire-sqlite`).
프로젝트 소개는 [README](../README.md)를 먼저 보세요.

## 목차

1. [실행 구성](#1-실행-구성)
2. [설정 파일](#2-설정-파일)
3. [환경 변수](#3-환경-변수)
4. [REST API](#4-rest-api)
5. [데이터 모델](#5-데이터-모델)
6. [워커 동작](#6-워커-동작)
7. [배포](#7-배포)
8. [Spring 백엔드](#8-spring-백엔드)
9. [운영 전환 기록](#9-운영-전환-기록)
10. [롤백: 태그 + 백업으로 되돌리기](#10-롤백-태그--백업으로-되돌리기)

---

## 1. 실행 구성

운영 구성은 `docker compose up`입니다(서비스 4개). **이전 완료 표식이 없으면 백엔드가 기동을 거부하고, 그에 묶인 웹·분석 워커도 뜨지 않습니다**(9절).

| 서비스 | 하는 일 |
| --- | --- |
| `mysql` | MySQL 8.4. 데이터는 볼륨 `mysql-data` |
| `backend` | Spring Boot(포트 8080). REST API, 수집·사진 스케줄러, 사진 파일(볼륨 `photos-data`). 운영 프로필(`prod`)로 뜨고 수집·사진·외부 요청 허용 세 설정을 켭니다 |
| `web` | Next.js(포트 3000). `AUCTIONBOSS_DATA_SOURCE=spring`, 데이터는 전부 백엔드 HTTP로 읽고 씁니다 |
| `analyzer` | 분석 워커. `AUCTIONBOSS_API_BASE`로 백엔드 API만 씁니다. `ANTHROPIC_API_KEY`가 필요합니다(컨테이너에는 Claude Code CLI가 없음) |

로컬 개발(Docker 없이 웹·분석 워커만, 백엔드는 이미 떠 있다고 가정):

| 명령 | 동작 |
| --- | --- |
| `npm run dev` / `npm start` | 웹 서버. `AUCTIONBOSS_DATA_SOURCE=spring`과 `AUCTIONBOSS_SPRING_BASE=http://localhost:8080`이 필요합니다 |
| `npm run analyzer` | 분석 워커. `AUCTIONBOSS_API_BASE`를 백엔드로 지정합니다. `-- --once`를 붙이면 1회만 실행합니다 |
| `docker compose -p auctionboss-smoke -f docker-compose.smoke.yml up -d --wait` | 시드 809건으로 뜨는 스모크 백엔드(포트 18080) |
| `(cd backend && ./gradlew bootRun --args='--spring.profiles.active=local,seed')` | IDE 개발용 백엔드 |

수집과 사진 워커는 TS 프로세스가 아니라 백엔드 안의 스케줄러입니다(`npm run collector`·`npm run photos`는 은퇴했습니다).

## 2. 설정 파일

수집 범위와 주기는 `config/collector.json`에서 정합니다(백엔드가 `AUCTIONBOSS_CONFIG_PATH`로, 분석 워커가 `AUCTIONBOSS_CONFIG`로 읽습니다). 값이 없거나 형식이 틀리면 시작하지 않습니다.

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

모두 선택 사항이지만, 운영 구성의 DB 변수 4개는 `.env`에 필수입니다(7절).

**웹 서버**

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `AUCTIONBOSS_DATA_SOURCE` | `spring` | 화면 데이터 원천. 값은 `spring`뿐입니다. 비우면 `spring`이고, `sqlite`는 "은퇴했습니다" 오류, 알 수 없는 값은 허용 값을 담은 오류입니다. 다른 원천으로 대신 동작하지 않습니다 |
| `AUCTIONBOSS_SPRING_BASE` | 없음(필수) | 백엔드 주소(예: `http://localhost:8080`, compose는 `http://backend:8080`). 서버에서만 쓰고 브라우저에 노출되지 않습니다. 요청마다 5초 제한을 둡니다. 없으면 시작하지 못합니다 |
| `PORT` | `3000` | Next.js 서버 포트 |

**분석 워커**

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `AUCTIONBOSS_API_BASE` | `http://localhost:3000` | 서버 주소. 이제 데이터 API는 백엔드에 있으므로 백엔드 주소(compose는 `http://backend:8080`)로 지정해야 합니다 |
| `AUCTIONBOSS_CONFIG` | `config/collector.json` | 설정 파일 경로 |
| `ANTHROPIC_API_KEY` | 없음 | 있으면 Claude Messages API를 호출하고, 없으면 Claude Code CLI를 실행합니다 |
| `AUCTIONBOSS_ANALYZE_MODEL` | 없음 | 사용할 모델. 없으면 기본 모델을 씁니다 |
| `AUCTIONBOSS_ANALYZE_TIMEOUT_MS` | 120000 | 물건 1건 분석 제한 시간 |
| `AUCTIONBOSS_ANALYZE_PROMPT` | `workers/prompts/analyze-item.md` | 프롬프트 파일 경로 |
| `AUCTIONBOSS_CLAUDE_BIN` | `claude` | CLI 모드에서 실행할 파일 |

**백엔드와 MySQL (compose가 `.env`에서 주입, 값은 `.env.example` 참고)**

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | `localhost`, `3306`, 없음… | MySQL 접속 정보. compose 안의 backend는 `DB_HOST=mysql`, `DB_PORT=3306`으로 덮어씁니다. `DB_NAME`·`DB_USER`·`DB_PASSWORD`는 운영 구성에서 필수(`${VAR:?}`)입니다 |
| `MYSQL_ROOT_PASSWORD` | 없음(필수) | MySQL 컨테이너 root 비밀번호 |
| `MYSQL_HOST_PORT` | `3307` | MySQL을 내 컴퓨터(루프백)에서 접속할 포트 |
| `AUCTIONBOSS_CONFIG_PATH` | 없음(compose는 `/app/config/collector.json`) | 백엔드가 수집·사진·재분석 설정을 읽을 `config/collector.json` 위치 |
| `AUCTIONBOSS_COLLECTOR_ENABLED`, `AUCTIONBOSS_PHOTOS_ENABLED`, `AUCTIONBOSS_SOURCE_EXTERNAL_REQUESTS_ALLOWED`, `AUCTIONBOSS_PHOTOS_DIR` 등 | 8절 표 | 수집·사진 워커 설정. 코드 기본값은 꺼짐이고 운영 compose의 `backend`만 켭니다 |

이전에 있던 `AUCTIONBOSS_DB`와 TS 수집·사진 워커 변수(`AUCTIONBOSS_COLLECT_*`, `AUCTIONBOSS_PHOTOS_INTERVAL_MS` 등)는 은퇴했습니다. 같은 값은 설정 파일(`config/collector.json`)과 8절의 백엔드 속성(`AUCTIONBOSS_SOURCE_*`, `AUCTIONBOSS_COLLECTOR_*`, `AUCTIONBOSS_PHOTOS_*`)으로 바꿉니다.

## 4. REST API

데이터 API는 **Spring 백엔드(포트 8080)**가 제공합니다. 요청과 응답은 JSON이며 형식이 틀리면 400과 오류 내용을 돌려줍니다. 경로·파라미터·응답 형태는 은퇴한 Next JSON 라우트와 같고(계약·시나리오 골든이 고정), 웹은 데이터 포트(`src/lib/data-port`)를 거쳐 이 API를 부릅니다. 인증은 없습니다(개인용·내부망 전제). 쓰기 API가 열려 있으므로 compose는 8080을 루프백(`127.0.0.1`)에만 엽니다.

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


**운영**

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/api/health` | DB 연결 상태. 정상이면 200, 아니면 503 |

**웹 서버(Next)에 남은 라우트 4개**: `GET /api/health`(백엔드 `/api/health`를 5초 제한으로 불러 200일 때만 정상), `POST /api/bookmarks/toggle`·`POST /api/feed/mark-read`(화면 폼 제출용, 처리 후 원래 화면으로 303 리다이렉트), `GET /api/photos/:itemId/:seq`(백엔드에서 받아 전달). 그 밖의 JSON 라우트는 은퇴했습니다.

## 5. 데이터 모델

MySQL 테이블 8개로 구성됩니다. 스키마는 Flyway 마이그레이션(`backend/src/main/resources/db/migration/` `V1__baseline`, `V2__item_photo_attempt`, `V3__widen_write_columns`)이 기준입니다. 금액은 BIGINT, 시각은 UTC `DATETIME(3)`입니다.

| 테이블 | 내용 |
| --- | --- |
| `items` | 경매 물건. 소재지, 용도, 감정가, 최저매각가격, 매각기일, 유찰횟수, 진행상태, 면적 등. `photo_attempted_at`은 마지막 사진 시도 시각 |
| `item_changes` | 감시 필드(최저매각가격, 유찰횟수, 매각기일, 진행상태)의 변경 이력. 이전 값과 새 값을 저장 |
| `analyses` | AI 분석 결과. 본문, 모델, 프롬프트 버전, 분석 시각 |
| `item_photos` | 저장된 물건 사진의 메타데이터. 파일은 백엔드 사진 디렉터리(compose `photos-data` 볼륨의 `/app/photos`, `{itemId}/{seq}.{ext}`)에 저장 |
| `bookmarks` | 관심 물건 |
| `feed_reads` | 피드를 어디까지 읽었는지 |
| `worker_runs` | 워커 실행 기록. 결과는 실행 중 · 성공 · 실패 · 차단 · 건너뜀 중 하나 |
| `collector_state` | 워커 상태 값. 다음 차례 법원, `backoff_until`(접속 차단 백오프 종료 시각. 수집 워커와 사진 워커가 공유), `migration.completed`(5단계 이전 완료 표식) |

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
4. 받은 사진은 사진 디렉터리(`auctionboss.photos.dir`)에 저장하고 `item_photos`에 기록합니다. 시도한 물건은 `photo_attempted_at`을 갱신합니다.
5. 접속 차단을 감지하면 즉시 멈추고 공유 백오프를 늘립니다. 수집 워커도 이 백오프 동안 쉽니다.

### 분석 워커

1. 신규 분석 대상을 먼저 조회합니다. 분석 결과가 없는 물건입니다.
2. 남은 한도로 재분석 대상을 조회합니다. 분석 후 감시 필드가 바뀌었거나, 예전 프롬프트 버전으로 분석한 물건입니다. 최근 24시간 안에 분석한 물건은 제외합니다.
3. 면적당 가격과 차수별 저감률을 코드로 먼저 계산해 프롬프트에 넣습니다.
4. 물건을 하나씩 순서대로 분석하고 결과를 API로 저장합니다. 한 건이 실패해도 다음 물건으로 넘어갑니다.

## 7. 배포

| 방식 | 파일 | 내용 |
| --- | --- | --- |
| Docker | `Dockerfile`(웹·분석 워커 이미지), `backend/Dockerfile` | 멀티 스테이지 빌드. 네이티브 빌드 도구·SQLite 볼륨 없음. 웹 이미지 약 1.07GB(은퇴 전 1.49GB) |
| Docker Compose | `docker-compose.yml` | 운영 구성: `mysql` · `backend`(prod 프로필, 수집·사진·API) · `web`(spring 원천) · `analyzer`(→ backend). `backend`가 수집·사진 주기 실행과 외부 요청 허용(세 설정)을 켭니다. 볼륨은 `mysql-data`, `photos-data`(백엔드 `/app/photos`)입니다. DB 변수(`DB_NAME`·`DB_USER`·`DB_PASSWORD`·`MYSQL_ROOT_PASSWORD`)는 필수(`${VAR:?}`)이고 `ANTHROPIC_API_KEY`만 선택입니다. web과 analyzer는 backend가 healthy가 된 뒤 시작하고, web 헬스체크는 curl 없이 Node 전역 `fetch`로 `/api/health`가 200인지 확인합니다. **이전 완료 표식이 없으면 backend가 기동을 거부합니다**(9절) |
| 스모크 | `docker-compose.smoke.yml`, `scripts/docker-smoke.sh` | 독립 프로젝트(`auctionboss-smoke`)로 `mysql`·`backend`만, `local,seed` 프로필(시드 809건), 호스트 포트 18080. 수집·사진·외부 요청 허용 없음. 스크립트는 이 파일과 `-p auctionboss-smoke`만 쓰므로 끝의 `down -v`가 운영 볼륨을 지우지 않습니다 |
| Kubernetes | `k8s/` | Kustomize 매니페스트(정적 검증만, 클러스터에 배포한 적 없음). 웹(컨테이너 하나, 볼륨 없음) · 백엔드(`replicas: 1`, `Recreate`, 사진 PVC, 세 설정 켬) · MySQL(StatefulSet, 영속 볼륨) · 분석 워커(→ 백엔드 서비스). Secret은 키 이름만 있고 값은 `kubectl create secret`으로 만듭니다. 자세한 내용은 `deploy/k8s/README.md` |
| CI | `.github/workflows/ci.yml` | TypeScript 잡(타입 검사 → 테스트 → 빌드 → 린트), OpenSpec 스펙·change 엄격 검증 잡, Java 잡(`./gradlew check`) |

`deploy-config.test.ts`가 "수집기가 동시에 둘 이상 켜지는 구성 없음", "세 설정은 compose `backend`와 K8s 백엔드에서만 켜짐", "SQLite 볼륨·PVC·`AUCTIONBOSS_DB` 없음", "테스트·스모크 구성에서는 외부 요청 허용이 꺼짐", 비밀이 리터럴이 아니라 `${VAR:?}`·`secretKeyRef`로만 주입됨을 고정합니다.

## 8. Spring 백엔드

`backend/`는 데이터의 유일한 주인입니다. 단계별로 1단계 읽기 API, 2단계 쓰기 API, 3단계 화면용 읽기 API 5개, 4단계 수집·사진 워커와 소스 어댑터, 5단계 데이터 이전·운영 전환·은퇴를 거쳤습니다. 단계는 [로드맵](ROADMAP.md)에 있습니다.

| 항목 | 내용 |
| --- | --- |
| 스택 | Java 21, Spring Boot 4.1, JPA + QueryDSL 7, Flyway, MySQL 8.4 |
| 포트·노출 | 8080. 인증이 없으므로(7단계 예정) compose는 루프백에만 엽니다. 외부에 노출하지 않습니다 |
| 제공 API | 4절의 전부. 요청 검증과 응답은 계약 골든 90개와 시나리오 골든 10개·171단계가 고정합니다 |
| 분석 워커 연결 | 분석 워커는 코드 변경 없이 `AUCTIONBOSS_API_BASE`만 백엔드로 돌려 연결됩니다(`workers/analyzer.ts`·`workers/lib/`·`workers/prompts/`는 5단계 전환 전후 코드 diff 0줄. `workers/lib/api.ts`의 낡은 경로를 가리키던 주석 4줄만 고쳤습니다) |
| 수집·사진 워커 | 소스 어댑터(`collect.source.courtauction`)와 수집·사진 회차, 스케줄러, 단일 실행 잠금(MySQL `GET_LOCK`). 아래 "수집·사진 워커 설정" |
| 스키마 | Flyway `V1`~`V3`. 5절 참고 |
| 시드 | `seed` 프로필에서 DB가 비어 있을 때만 `db/seed/*.sql`을 넣습니다. 실명을 가린 물건 809건, 변경 이력 4,008건, 분석 12건. 운영에서는 쓰지 않습니다 |
| 화면 데이터 포트 | `src/lib/data-port`가 화면의 데이터 접근(읽기 13, 쓰기 3, 사진 파일 1)을 한 곳에 모읍니다. 구현체는 Spring 하나입니다. 화면 한 장이 백엔드로 보내는 요청은 최대 `/` 6, `/items/:id` 5, `/bookmarks` 2, `/feed` 2, `/status` 11개입니다. 린트가 `src/app/**`의 `better-sqlite3`·`@/lib/db`·`@/lib/data-port/spring/*` 가져오기와 `workers/**`의 `@/lib/data-port`·`next` 가져오기를 막습니다 |

**수집·사진 워커 설정 (코드 기본값 꺼짐, 운영 compose의 `backend`만 켬)**

Spring의 수집·사진 워커는 설정으로 명시해 켜기 전에는 스케줄러 빈조차 만들어지지 않습니다. 소스 HTTP 클라이언트는 외부 요청 허용 설정이 따로 없으면 루프백이 아닌 주소로 요청을 보내지 않습니다. 이 두 겹은 별개이고, 실제 사이트로 요청이 나가려면 둘 다 켜야 합니다. 세 설정을 켜는 곳은 compose `backend`와 K8s 백엔드 Deployment뿐이고(스모크·개발 스크립트·CI에는 이름도 없음), `deploy-config.test.ts`가 고정합니다. 환경 변수는 Spring의 이름 규칙으로 속성 이름을 바꾼 것입니다(`.`·`-`를 `_`로, 대문자로. 예: `auctionboss.source.page-delay-ms` → `AUCTIONBOSS_SOURCE_PAGE_DELAY_MS`).

| 속성 | 환경 변수 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `auctionboss.collector.enabled` | `AUCTIONBOSS_COLLECTOR_ENABLED` | `false` | 수집 스케줄러를 만듭니다(첫 겹) |
| `auctionboss.photos.enabled` | `AUCTIONBOSS_PHOTOS_ENABLED` | `false` | 사진 스케줄러를 만듭니다(첫 겹) |
| `auctionboss.source.external-requests-allowed` | `AUCTIONBOSS_SOURCE_EXTERNAL_REQUESTS_ALLOWED` | `false` | `false`이면 루프백이 아닌 주소는 소켓을 열기 전에 거절합니다(둘째 겹) |
| `auctionboss.source.base-url` | `AUCTIONBOSS_SOURCE_BASE_URL` | 법원경매정보 주소 | 소스 주소. 테스트·개발 검증은 루프백 가짜 서버를 가리킵니다 |
| `auctionboss.source.page-size` / `page-delay-ms` / `bid-window-days` / `max-pages` | `AUCTIONBOSS_SOURCE_PAGE_SIZE` 등 | 40 / 5000 / 60 / 50 | 은퇴한 TS 수집기의 `AUCTIONBOSS_COLLECT_*`와 같은 뜻 |
| `auctionboss.collector.run-immediately` / `auctionboss.photos.run-immediately` | `AUCTIONBOSS_COLLECTOR_RUN_IMMEDIATELY` 등 | `true` | 기동 직후 회차를 한 번 실행할지 |
| `auctionboss.collector.max-courts-per-run` / `max-requests-per-run` | `AUCTIONBOSS_COLLECTOR_MAX_COURTS_PER_RUN` 등 | 설정 파일 값 | 설정 파일의 회차당 법원 수·요청 수 상한을 덮어씁니다 |
| `auctionboss.collector.block-backoff-ms` | `AUCTIONBOSS_COLLECTOR_BLOCK_BACKOFF_MS` | 3600000 | 차단 시 공유 백오프 길이 |
| `auctionboss.photos.max-items-per-run` | `AUCTIONBOSS_PHOTOS_MAX_ITEMS_PER_RUN` | 설정 파일 값 | 회차당 물건 수 |
| `auctionboss.photos.dir` | `AUCTIONBOSS_PHOTOS_DIR` | `data/photos`(compose는 `/app/photos`) | 사진 파일 디렉터리. 읽기 API와 사진 워커가 같은 값을 씁니다 |
| `auctionboss.config-path` | `AUCTIONBOSS_CONFIG_PATH` | 없음 | `config/collector.json` 위치. 수집 범위·주기·사진 설정은 호출마다 이 파일에서 읽습니다 |
| `auctionboss.workers.shutdown-wait-ms` | `AUCTIONBOSS_WORKERS_SHUTDOWN_WAIT_MS` | 30000 | 종료 시 진행 중 회차를 기다리는 상한. 넘으면 회차 스레드를 중단합니다 |

켜졌을 때의 동작: 고정 주기 틱마다 MySQL `GET_LOCK`(워커별 이름)으로 단일 실행을 보장합니다. 잠금을 못 얻으면 실행하지 않고 `skipped`(`error_kind=overlap`)를, 공유 백오프가 남았으면 `skipped(backoff)`를 기록합니다. 스케줄러가 켜질 때 "다른 수집기가 같은 소스에 요청하고 있으면 안 된다"는 경고를, 기동할 때마다 두 워커와 외부 요청 허용 상태를 로그로 남깁니다.

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
| `scripts/dev/verify-analyzer-on-spring.sh` | 분석 워커를 코드 변경 없이 환경 변수만 바꿔 임시 MySQL의 Spring에 붙이고, 가짜 Claude CLI로 분석 결과가 저장되는지 확인합니다 | 없음 |
| `scripts/docker-smoke.sh` | 스모크 구성의 처음 기동과 재기동(데이터 유지)을 확인합니다. 스모크 프로젝트만 지웁니다 | 없음 |
| `scripts/dev-db.sh` (`npm run db:up`·`db:down`·`db:status`) | IDE 개발용 MySQL 컨테이너를 켜고 끕니다(데이터 보존) | 없음 |

가짜 소스 서버(`scripts/dev/fake-source-server.ts`)는 이미 가림 처리된 동결 골든 픽스처로 응답하고, 가짜 Claude CLI는 `scripts/dev/fake-claude`입니다. 실제 사이트 최소 확인은 위 1회 실행 모드를 사람이 한 번만 돌리는 방식입니다.

**동시 운영 금지**

수집기는 백엔드 하나뿐이어야 합니다. 두 수집기가 서로 다른 DB의 백오프와 로테이션을 보면 어떤 잠금으로도 막을 수 없어 요청 예산이 두 배가 되고 한쪽이 차단돼도 다른 쪽이 모릅니다. 롤백으로 옛 TS 구성을 되살릴 때(10절)도 백엔드를 먼저 멈춥니다. 같은 MySQL을 보는 Spring 인스턴스 둘은 `GET_LOCK`이 막습니다.

**데이터 이전 1회 실행 모드 (5단계)**

`auctionboss.run-once`에 아래 값을 주면 웹 서버와 스케줄러 없이 한 번 실행하고 종료합니다(종료 코드 성공 0, 실패 1, 로그는 `[import]` 줄). 세 모드 모두 `auctionboss.collector.enabled`·`auctionboss.photos.enabled`가 참이면 기동을 거부하므로 운영 compose에서는 두 값을 끄고 실행합니다(9절 명령 참고).

| 모드 | 설정 | 하는 일 |
| --- | --- | --- |
| `import` | `auctionboss.import.dir`(내보내기 디렉터리, 필수), `auctionboss.import.replace`(기본 `false`: 대상이 비어 있지 않으면 중단, `true`: FK 역순 `DELETE` 뒤 다시 적재), `auctionboss.import.dry-run`(기본 `false`: `true`면 전부 실행하고 롤백), 사진 대상 `auctionboss.photos.dir` | 한 트랜잭션으로 8개 테이블을 id 그대로 적재하고 행 수·정규화 해시를 매니페스트와 대조, 사진 파일을 복사·해시 대조한 뒤 이전 완료 표식(`collector_state.migration.completed`)을 씁니다 |
| `export-state` | 없음 | 표준 출력에 `{"backoffUntil":"…Z"\|null,"rotationNextCourtCode":"…"\|null}` 한 줄. 롤백 때 옛 구성에 차단 백오프·로테이션 위치를 되쓰는 근거입니다(10절) |
| `delta-report` | `auctionboss.delta.since=<ISO UTC>`(이상, `>=`) | 그 시각 이후 테이블별로 생긴 건수 한 줄(`items`, `item_changes`, `analyses`, `worker_runs`, `bookmarks`, `item_photos`). 값은 출력하지 않습니다 |

환경 변수로는 `AUCTIONBOSS_RUN_ONCE`, `AUCTIONBOSS_IMPORT_DIR`, `AUCTIONBOSS_IMPORT_REPLACE`, `AUCTIONBOSS_IMPORT_DRY_RUN`, `AUCTIONBOSS_DELTA_SINCE`입니다. 내보내기 도구(`scripts/migrate/export.ts`)는 5단계 은퇴 때 함께 지워졌고(태그 `pre-retire-sqlite`에 있음), 매니페스트·SQL 형식과 해시 규칙은 [개발 기록 18.2](DEVELOPMENT_NOTES.md)와 `backend/src/test/resources/migration/` 골든에 있습니다.

**프로필**

| 프로필 | 용도 |
| --- | --- |
| `prod` | 운영. 시드 없음, 접속 정보는 환경 변수에서 읽습니다. 이전 완료 표식이 없으면 스케줄러를 켠 채로는 기동을 거부합니다 |
| `local` | 로컬 MySQL 접속. 저장소 루트 `.env`(git 미추적)에서 `DB_*` 값을 읽습니다 |
| `seed` | 시드 로더를 켭니다. 운영에서는 쓰지 않습니다 |
| `test` | Testcontainers MySQL로 테스트합니다 |

**실행과 검증**

```bash
cp .env.example .env
docker compose -p auctionboss-smoke -f docker-compose.smoke.yml up -d --wait   # 시드 스모크, http://localhost:18080/api/items
scripts/docker-smoke.sh                   # 처음 기동과 재기동(데이터 유지) 자동 확인
(cd backend && ./gradlew bootRun --args='--spring.profiles.active=local,seed')   # IDE 개발용
(cd backend && ./gradlew check)           # 테스트 789개 (Docker 필요)
```

---

기능별 요구사항은 [openspec/specs](../openspec/specs/)에, 개발 중 작성한 상세 기록은 [개발 기록](DEVELOPMENT_NOTES.md)에 있습니다.

---

## 9. 운영 전환 기록

5단계(2026-10-09)에 SQLite(TS 구성)에서 MySQL·Spring 백엔드로 한 번 옮겼습니다. 같은 절차를 다시 쓸 일은 없으므로(역이전 도구 없음, 내보내기 도구 은퇴) 절차는 기록으로만 남깁니다. 설계는 `openspec/changes/archive/2026-10-09-migrate-data-and-cutover/design.md` D10, 수치는 [개발 기록 18절](DEVELOPMENT_NOTES.md)과 그 change의 `tasks.md` 메모에 있습니다.

**전환 절차(요약)**: (1) 사전 확인(게이트 5종, `docker compose config -q`, 이미지 사전 빌드) → (2) 쓰기 정지(T0, 옛 TS 서비스 stop) → (3) SQLite 백업 API 스냅숏으로 8개 테이블 내보내기(매니페스트에 행 수·해시) → (4) MySQL 기동 → (5) 가져오기 드라이런 1회 뒤 본 실행(스케줄러를 끈 1회 실행: `AUCTIONBOSS_RUN_ONCE=import`, 한 트랜잭션, 해시 8/8 일치 필요) → (6) 스케줄러 끈 백엔드로 이전 뒤 API·화면 전수 비교(불일치 0 필요) → (7) 백엔드·웹 켬(T1) → (8) 확인(헬스, 화면 5개 200, 첫 수집·사진 회차 결과).

| 기록 | 값 |
| --- | --- |
| 전환 직전 구성 커밋 | `8cd214b`(옛 TS 구성 compose의 기준) |
| 은퇴 직전 태그 | `pre-retire-sqlite` |
| 이전 원본 | `data/auctionboss.db` |
| T0 / T1 | 2026-10-09 `08:14:33Z` / `08:18:37Z` |
| 가져오기 | 본 실행 약 4초(Spring 보고 377ms), 해시 8/8 일치, 행 수 809/4008/12/10/0/0/1/16, 사진 16개 |
| 이전 후 비교 | API 3,326건 불일치 0, 화면 18건 차이 0 |
| T0→T1 | 4m04s |
| 수집 공백 | 약 17h51m(TS 마지막 수집 종료 → Spring 첫 수집 시작) |
| 첫 수집·사진 회차 | 수집 성공(신규 466건, 요청 15), 사진 성공(저장 3·실패 2) |
| 분석 워커 | 전환 때 올리지 않음(사용자 결정) |

**이전 완료 표식**: 가져오기가 성공하면 같은 트랜잭션에서 `collector_state.migration.completed`를 씁니다. `prod` 프로필에서 수집·사진 스케줄러가 켜져 있는데 표식이 없으면 백엔드가 기동을 거부합니다. 빈 MySQL에서 `docker compose up`을 해도 빈 DB로 실제 사이트에 요청이 나가지 않게 하는 장치입니다. 새 환경에 처음 띄울 때는 가져오기로 데이터를 넣거나(이전), 스케줄러를 끄고 `seed` 프로필로 띄워야 합니다.

**전환 뒤 켜 둘지**는 사람이 정합니다. 켜 두면 실제 사이트로 주기 요청이 나갑니다(`docker compose up -d backend web`이 곧 수집 시작).

## 10. 롤백: 태그 + 백업으로 되돌리기

MySQL → SQLite 역이전 도구는 없습니다. 은퇴 후의 롤백은 은퇴 직전 코드와 전환 직전 SQLite 백업으로 되돌리는 것이고, 그 사이 MySQL에 생긴 데이터는 버립니다(분석 호출 비용과 회차 기록 외에는 수집기가 다시 만듭니다). 잃으면 안 되는 것은 **차단 백오프**이므로 되쓰기를 합니다.

| 되돌릴 재료 | 위치 |
| --- | --- |
| 은퇴 직전 코드(TS 수집기·SQLite 포트·`scripts/migrate/rollback-state.ts` 포함) | git 태그 `pre-retire-sqlite` |
| 옛 TS 구성 compose(`web`·`collector`·`photos`·`analyzer`) | `git show 8cd214b:docker-compose.yml` |
| 전환 직전 SQLite 백업 | `backups/auctionboss-pre-cutover-20261009.db`(git 무시, 이 머신에만 있음) |
| 손대지 않은 원본 | `data/auctionboss.db`와 `data/photos/` |

1. **쓰기 멈추기**: `docker compose stop backend analyzer web`(MySQL은 켜 둡니다). 수집기가 둘 동시에 돌면 안 되므로 백엔드가 멈췄는지 확인합니다.
2. **델타 보고와 상태 내보내기**(MySQL이 아직 있을 때, 값은 출력되지 않음): 전환 이후 생긴 건수와 차단 백오프·로테이션 위치를 기록합니다.
   ```bash
   docker compose run --rm -e AUCTIONBOSS_COLLECTOR_ENABLED=false -e AUCTIONBOSS_PHOTOS_ENABLED=false \
     -e AUCTIONBOSS_RUN_ONCE=delta-report -e AUCTIONBOSS_DELTA_SINCE=<T1 ISO UTC> backend
   docker compose run --rm -T -e AUCTIONBOSS_COLLECTOR_ENABLED=false -e AUCTIONBOSS_PHOTOS_ENABLED=false \
     -e AUCTIONBOSS_RUN_ONCE=export-state backend | grep '^{"backoffUntil"' > state.json
   ```
3. **옛 코드 꺼내기**: 별도 작업 디렉터리에 태그를 체크아웃합니다(현재 작업 트리를 건드리지 않음). 이 디렉터리에서 의존성 설치와 이미지 빌드가 됩니다.
   ```bash
   git worktree add ../auctionboss-rollback pre-retire-sqlite
   ```
4. **상태 되쓰기**: 백업 복사본(또는 원본)에 MySQL의 백오프가 더 늦을 때만 쓰고 로테이션 위치를 덮어씁니다. 경로는 필수 인자이고 파일이 없으면 새로 만들지 않고 실패합니다.
   ```bash
   cd ../auctionboss-rollback
   npx tsx scripts/migrate/rollback-state.ts --sqlite <되돌릴 SQLite 파일> --state ../AuctionBoss/state.json
   ```
5. **옛 구성 기동**: 옛 compose는 볼륨 `auctionboss_auctionboss-data`를 씁니다. SQLite 파일과 사진을 이 볼륨에 복사한 뒤 올립니다. 복사에서 놓치기 쉬운 두 가지: (a) 볼륨에 남은 빈 DB의 `auctionboss.db-wal`·`-shm`을 먼저 지웁니다(남기면 새 파일 위에 옛 WAL이 적용되어 되쓴 상태가 보이지 않습니다). (b) 파일 소유자를 web 컨테이너의 `node`(uid 1000)로 맞춥니다(안 하면 `SQLITE_READONLY`).
   ```bash
   docker run --rm -v auctionboss_auctionboss-data:/dest -v "$PWD/<SQLite와 photos가 있는 디렉터리>":/src:ro alpine sh -c '
     set -e
     rm -f /dest/auctionboss.db /dest/auctionboss.db-wal /dest/auctionboss.db-shm
     cp /src/auctionboss.db /dest/auctionboss.db
     [ -f /src/auctionboss.db-wal ] && cp /src/auctionboss.db-wal /dest/auctionboss.db-wal
     [ -d /src/photos ] && cp -R /src/photos /dest/
     chown -R 1000:1000 /dest'
   git show 8cd214b:docker-compose.yml | docker compose -p auctionboss --project-directory . -f - up -d web collector photos
   ```
   분석 워커는 올라오자마자 한 회차를 돌아 실제 Claude를 호출하므로 비용을 피하려면 `analyzer`를 빼고 올립니다.
6. **확인**: web `/api/health` 200, 화면 5개 200, 옛 수집기 로그에 `소스 차단 백오프 중이라 건너뜁니다`(차단 백오프가 있었을 때), `SQLITE_READONLY` 없음. 첫 틱이 백오프를 건너뛰지 않으면 즉시 `collector photos`를 멈춥니다(실제 사이트로 요청이 나갑니다). 롤백 소요 시간·델타 건수·원인을 기록합니다.

이 절차의 3~6단계(옛 볼륨 복사·상태 되쓰기·옛 구성 기동)는 은퇴 **전** 구성으로 운영 복사본에서 두 번 리허설해 소요 16.5s·16.8s를 확인했습니다(결함 2건 수정, [개발 기록 18.7](DEVELOPMENT_NOTES.md)). 은퇴 **후**에는 태그 체크아웃 경로로 다시 리허설하지 않았습니다. 상시 환경의 백업과 `mysqldump` 복구는 6단계에서 정합니다.
