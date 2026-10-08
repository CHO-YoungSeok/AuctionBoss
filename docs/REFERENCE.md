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

---

## 1. 실행 구성

| 프로세스 | 명령 | 동작 |
| --- | --- | --- |
| 웹 서버 | `npm start` | 화면과 REST API 제공. SQLite를 읽고 씁니다 |
| 수집 워커 | `npm run collector` | 시작하자마자 1회 실행하고, 이후 설정한 주기마다 반복합니다 |
| 분석 워커 | `npm run analyzer` | 웹 서버 API로 분석 대상을 받아 Claude로 분석합니다. `-- --once`를 붙이면 1회만 실행합니다 |
| 사진 워커 | `npm run photos` | 사진이 없는 물건 최대 10건의 사진을 받아 저장하고 종료합니다 |

분석 워커는 웹 서버에 의존하므로 서버를 먼저 띄웁니다.

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
| `observability.maxRunsPerWorker` | 1000 | 워커별로 보관할 실행 기록 수 |
| `observability.staleAfterIntervals` | 3 | 주기의 몇 배 동안 기록이 없으면 "멈춤"으로 볼지 |

## 3. 환경 변수

모두 선택 사항입니다.

**공통**

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `AUCTIONBOSS_DB` | `data/auctionboss.db` | SQLite 파일 경로 |
| `AUCTIONBOSS_CONFIG` | `config/collector.json` | 설정 파일 경로 |

**수집 워커**

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `AUCTIONBOSS_COLLECT_INTERVAL_MS` | 설정 파일 값 | 수집 주기 |
| `AUCTIONBOSS_COLLECT_BACKOFF_MS` | 3600000 | 접속 차단을 감지했을 때 쉬는 시간 (1시간) |
| `AUCTIONBOSS_COLLECT_PAGE_DELAY_MS` | 5000 | 페이지 요청 사이 간격 |
| `AUCTIONBOSS_COLLECT_PAGE_SIZE` | 40 | 페이지당 행 수. 소스가 허용하는 최대값이 40입니다 |
| `AUCTIONBOSS_COLLECT_BID_WINDOW_DAYS` | 60 | 오늘부터 며칠 뒤 매각기일까지 수집할지 |
| `AUCTIONBOSS_COLLECT_MAX_PAGES` | 50 | 법원 하나에서 요청할 최대 페이지 수 |

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
| GET | `/api/worker-runs/summary` | 최근 기간의 성공률 · 차단 횟수 집계 |

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
| `items` | 경매 물건. 소재지, 용도, 감정가, 최저매각가격, 매각기일, 유찰횟수, 진행상태, 면적 등 |
| `item_changes` | 감시 필드(최저매각가격, 유찰횟수, 매각기일, 진행상태)의 변경 이력. 이전 값과 새 값을 저장 |
| `analyses` | AI 분석 결과. 본문, 모델, 프롬프트 버전, 분석 시각 |
| `item_photos` | 저장된 물건 사진의 메타데이터. 파일은 `data/photos/`에 저장 |
| `bookmarks` | 관심 물건 |
| `feed_reads` | 피드를 어디까지 읽었는지 |
| `worker_runs` | 워커 실행 기록. 결과는 실행 중 · 성공 · 실패 · 차단 · 건너뜀 중 하나 |
| `collector_state` | 워커 상태 값. 다음 차례 법원, 사진 수집 백오프 종료 시각 |

## 6. 워커 동작

### 수집 워커

1. 이번 차례의 법원을 고릅니다. 실행할 때마다 다음 법원으로 넘어갑니다.
2. 페이지를 하나씩 요청하고, 요청 사이에 5초를 쉽니다. 동시 요청은 하지 않습니다.
3. 응답마다 세 가지를 확인합니다. 본문이 JSON인지, 접속 허용 플래그가 정상인지, 스키마를 통과하는지입니다.
4. 정상 응답은 도메인 모델로 바꿔 저장합니다. 감시 필드가 바뀐 물건은 변경 이력을 남깁니다.
5. 접속 차단을 감지하면 즉시 멈추고, 1시간 동안 다음 실행을 건너뜁니다.

이전 실행이 아직 끝나지 않았으면 이번 주기는 건너뛰고, 건너뛴 사실도 기록합니다.

### 분석 워커

1. 신규 분석 대상을 먼저 조회합니다. 분석 결과가 없는 물건입니다.
2. 남은 한도로 재분석 대상을 조회합니다. 분석 후 감시 필드가 바뀌었거나, 예전 프롬프트 버전으로 분석한 물건입니다. 최근 24시간 안에 분석한 물건은 제외합니다.
3. 면적당 가격과 차수별 저감률을 코드로 먼저 계산해 프롬프트에 넣습니다.
4. 물건을 하나씩 순서대로 분석하고 결과를 API로 저장합니다. 한 건이 실패해도 다음 물건으로 넘어갑니다.

## 7. 배포

| 방식 | 파일 | 내용 |
| --- | --- | --- |
| Docker | `Dockerfile` | 멀티 스테이지 빌드. SQLite 파일은 `/app/data` 볼륨에 저장 |
| Docker Compose | `docker-compose.yml` | 웹 · 수집 · 분석 서비스 구성 |
| Kubernetes | `k8s/` | Kustomize 매니페스트. 웹과 수집 워커는 같은 Pod에서 DB 볼륨을 공유하고, 분석 워커는 별도 Deployment에서 HTTP로만 통신. `/api/health`로 liveness · readiness 프로브 |
| CI | `.github/workflows/ci.yml` | 타입 검사 → 테스트 → 빌드 → 린트 |

## 8. Spring 백엔드 (이전 중)

`backend/`는 기존 백엔드를 Spring Boot + MySQL로 옮기는 중인 새 백엔드입니다. 1단계에서 읽기 API를 옮겼고, 화면·수집·분석 워커는 아직 위의 기존 구조를 씁니다. 단계는 [로드맵](ROADMAP.md)에 있습니다.

| 항목 | 내용 |
| --- | --- |
| 스택 | Java 21, Spring Boot 4.1, JPA + QueryDSL 7, Flyway, MySQL 8.4 |
| 포트 | 8080 |
| 제공 API | `GET /api/items`, `/api/items/:id`, `/api/items/:id/changes`, `/api/items/usage-types`, `/api/health`. 경로·파라미터·응답 형태는 4절의 기존 API와 같습니다 |
| 스키마 | `backend/src/main/resources/db/migration/V1__baseline.sql`. 5절의 테이블 8개를 컬럼 이름까지 그대로 옮겼습니다. 금액은 BIGINT, 시각은 UTC `DATETIME(3)` |
| 시드 | `seed` 프로필에서 DB가 비어 있을 때만 `db/seed/*.sql`을 넣습니다. 실명을 가린 물건 809건, 변경 이력 4,008건, 분석 12건 |
| 계약 테스트 | 기존 API 응답 90개를 정답으로 저장해 두고, 같은 요청에 같은 JSON이 나오는지 비교합니다 |

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
docker compose up -d mysql backend        # MySQL이 준비된 뒤 백엔드가 뜨고 시드가 들어갑니다
scripts/docker-smoke.sh                   # 처음 기동과 재기동(데이터 유지)을 자동으로 확인
(cd backend && ./gradlew bootRun --args='--spring.profiles.active=local,seed')   # IDE 개발용
(cd backend && ./gradlew check)           # 테스트 (Docker 필요)
```

---

기능별 요구사항은 [openspec/specs](../openspec/specs/)에, 개발 중 작성한 상세 기록은 [개발 기록](DEVELOPMENT_NOTES.md)에 있습니다.
