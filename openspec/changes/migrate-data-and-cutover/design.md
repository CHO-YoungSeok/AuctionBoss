## Context

- 동기와 범위는 proposal.md, 지켜야 할 동작은 `specs/spring-backend/spec.md`, `specs/web-data-port/spec.md`, `specs/deployment-and-health/spec.md`를 따른다.
- 1~4단계 결과: Spring(Boot 4.1, Java 21, MySQL 8.4, Flyway V1~V3)에 읽기·쓰기·화면용 API, 수집·사진 워커(기본 꺼짐 두 겹, `GET_LOCK` 단일 실행, 1회 실행 모드 `auctionboss.run-once`), 계약 골든(읽기 90, 시나리오 9개, 어댑터·저장 골든)이 있다. 웹은 데이터 포트(`AUCTIONBOSS_DATA_SOURCE=sqlite|spring`, 기본 `sqlite`)로 두 원천을 고른다. 분석 워커는 `AUCTIONBOSS_API_BASE` 하나로 서버를 고르고 2단계에서 코드 변경 0줄로 Spring에 붙는 것을 확인했다. 4단계(`port-collector-to-spring`)는 8장(개발 환경 검증, 실제 사이트 최소 1회) 진행 중이다.
- 운영 데이터 실측(2026-10-09, `data/auctionboss.db`, 값은 보지 않고 행 수·스키마만)

  | 테이블 | 행 수 | 비고 |
  | --- | --- | --- |
  | `items` | 809 | 최대 id 1393, `sqlite_sequence` 1393 — id에 빈 번호가 많다(보존 필수) |
  | `item_changes` | 4,008 | 최대 id = 시퀀스 = 4008 |
  | `analyses` | 12 | |
  | `worker_runs` | 10 | `detail`은 JSON 텍스트, MySQL은 `JSON` 컬럼(표기가 정규화된다) |
  | `bookmarks`, `feed_reads` | 0, 0 | |
  | `collector_state` | 1 | 로테이션 키만 있음(백오프 키 없음) |
  | `item_photos` | 16 | 물건 1건. `file_path`는 전부 `{itemId}/{seq}.{ext}` 상대 경로 |
  | 사진 디렉터리 | 파일 17개, 물건 디렉터리 2개 | 기록 없는 파일 1개(고아) |

  SQLite 스키마는 Flyway V1~V3와 같은 컬럼 이름을 가진다(1단계 요구사항). 시각은 ISO 문자열 TEXT, 금액은 INTEGER, `auction_date`·`auction_decision_date`는 `YYYY-MM-DD` TEXT, `coordinate_*`는 TEXT다. MySQL은 `DATETIME(3)` UTC, `BIGINT`, `DATE`, `JSON`, 길이 제한이 있는 `VARCHAR`다.
- "운영"의 실체: 상시 운영 환경은 아직 없다(ROADMAP). 운영 데이터는 개발 머신의 `data/auctionboss.db`(시드 원본)와 compose 볼륨 `auctionboss_auctionboss-data` 두 곳에 있을 수 있다. 어느 쪽이 이전 원본인지는 1장에서 확인하고 사용자에게 묻는다(Open Questions 아님 — 1.2에서 정한다).
- 배포 구성 현황: compose는 `web`·`collector`·`photos`(같은 SQLite 볼륨), `analyzer`(→ `http://web:3000`), `mysql`, `backend`(`local,seed` 프로필, 루프백 8080, 사진 볼륨 없음). K8s는 웹·수집·사진 다중 컨테이너 Pod + 분석 워커만 있고 **백엔드와 MySQL이 없다**. `scripts/docker-smoke.sh`는 compose의 `mysql backend`를 시드로 띄워 809건을 기대하고 끝에 `docker compose down -v`를 한다(CI에는 없음). 백엔드의 데이터소스 URL은 `local` 프로필에만 있다.
- 시드 도구: `scripts/seed/sql.ts`(ISO → `DATETIME(3)` 리터럴, 날짜 검증, 정수 검증, JSON 검증, 이스케이프, `buildInserts`)가 SQLite 값을 MySQL INSERT로 바꾸는 검증된 경로다. `export-seed.ts`는 여기에 가림을 더한다. Spring `SeedLoader`는 `ResourceDatabasePopulator`로 SQL을 실행한다.

## Goals / Non-Goals

**Goals:**
- 운영 데이터를 값 하나 바뀌지 않고, id 그대로, 원자적으로 옮기고, 그 사실을 두 독립 구현의 해시와 API·화면 비교로 증명한다.
- 전환 절차를 리허설로 먼저 재고(시간·다운타임), 실제 전환은 그 절차를 그대로 따른다.
- 이전 전에 운영 구성을 띄우는 실수, 두 수집기 동시 운영, 롤백 뒤 차단 무시가 구조적으로 일어나지 않게 한다.
- 롤백 창이 끝난 뒤 SQLite 경로를 코드에서 지우고 린트로 되돌아오지 못하게 한다.

**Non-Goals:**
- 역이전 도구, 이중 쓰기, 무중단 전환(단일 사용자 서비스라 분 단위 다운타임을 받아들인다).
- 스키마 정리(이전과 동시에 컬럼을 바꾸면 검증 기준이 흔들린다), 분석 워커 코드 변경, 상시 환경·백업 체계(6단계).

## Decisions

### D1. 이전 도구: TS 내보내기 + Spring 1회 실행 가져오기로 나눈다
- **선택**: (1) `scripts/migrate/export.ts`(TS)가 SQLite 백업을 읽어 MySQL INSERT SQL과 매니페스트를 쓴다. (2) 백엔드 1회 실행 모드 `auctionboss.run-once=import`(`auctionboss.import.dir`)가 그 SQL을 MySQL에 적재하고 검증한다.
- **근거**: (a) SQLite를 읽는 코드는 이미 TS에 있고 백엔드는 SQLite를 몰라야 한다(백엔드 운영 의존성에 SQLite 드라이버를 넣지 않는다). (b) MySQL에 쓰는 코드는 이미 Spring에 있다(데이터소스, Flyway, `SeedLoader`의 SQL 실행, `GET_LOCK`). TS에 MySQL 드라이버를 들이지 않는다. (c) 값 변환은 시드에서 검증된 `sql.ts`를 그대로 쓴다 — 시드는 같은 원본으로 만들어 계약 골든 90개·시나리오를 통과했으므로, 변환 경로의 동등성은 이미 증명돼 있다. 이번에 빠지는 것은 가림뿐이다. (d) 원본 쪽 해시는 TS가 SQLite에서, 대상 쪽 해시는 Java가 MySQL에서 각자 계산하므로 적재 코드가 스스로를 검증하지 않는다(spec "이전 결과 검증").
- **버린 대안**: TS 스크립트가 `mysql2`로 직접 적재. 한 언어로 끝나지만 운영 의존성은 아니어도 새 드라이버가 들어오고, 원자성·Flyway 확인·잠금을 TS에서 다시 만들어야 하며, 해시 검증이 같은 코드 안에서 이뤄진다. Spring 쪽 도구가 SQLite를 직접 읽는 안: 백엔드에 SQLite 드라이버가 들어오고, CLAUDE.md의 "백엔드가 DB의 유일한 주인" 방향과 반대로 두 번째 DB를 백엔드가 알게 된다. `mysqldump` 형식으로 변환하는 셸 파이프라인: 시각·JSON 변환을 다시 만들어야 하고 테스트하기 어렵다. 모두 기각.

### D2. 원본 고정: SQLite 백업 API로 스냅숏을 뜨고 그 파일만 읽는다
- 내보내기는 살아 있는 DB 파일을 읽지 않는다. 먼저 `better-sqlite3`의 `backup()`(WAL 포함 일관 스냅숏)으로 `data/migration/<시각>/source.db`를 만들고, 그 파일의 SHA-256을 매니페스트에 적는다. 이 백업이 롤백 기준이기도 하다(D10).
- 사전 조건(어기면 중단, `--force` 없음): 원본 DB를 다른 프로세스가 쓰고 있지 않음(백업 직전·직후 `PRAGMA data_version`과 파일 수정 시각 동일), 워커마다 가장 최근 회차가 `running`이 아님, 원본 스키마의 컬럼 집합이 예상(Flyway 컬럼 목록 스냅숏)과 같음.
- **출력 위치**: `data/migration/<UTC 시각>/`만 허용한다(`/data/`는 git 제외). 다른 경로를 주면 거부한다. 표준 출력에는 테이블 이름, 건수, 해시, 시간만 쓴다.

### D3. 내보내기 형식과 id·시퀀스
- 테이블 8개를 FK 순서(`items` → `item_changes` → `analyses` → `worker_runs` → `bookmarks` → `feed_reads` → `collector_state` → `item_photos`)로 `NN_<table>.sql`에 쓴다. `buildInserts`에 **id 컬럼을 포함**해 원본 id를 그대로 넣는다. 빈 테이블도 파일 없이 매니페스트에 0건으로 남긴다.
- 컬럼 종류는 `export-seed.ts`의 판정을 공용 모듈로 옮겨 함께 쓴다(시각 9개, 날짜 2개, JSON 1개, 나머지 INTEGER/TEXT). 정수가 아닌 숫자, 형식이 다른 시각·날짜, 깨진 JSON은 내보내기 단계에서 테이블·id·컬럼 이름과 함께 실패한다(값은 출력하지 않음).
- 매니페스트(`manifest.json`): 원본 백업 해시, 내보낸 시각, 도구 커밋, 테이블별 `{ rows, sha256, maxId, sqliteSeq }`, 사진 `{ files: [{ path, size, sha256 }], orphans: n }`, 정규화 규칙 버전.
- **`AUTO_INCREMENT`**: 가져오기 커밋 뒤 테이블마다 `ALTER TABLE … AUTO_INCREMENT = max(sqliteSeq, maxId) + 1`. InnoDB는 명시 id 삽입 뒤 카운터를 `max(id)+1`로 맞추지만, SQLite `AUTOINCREMENT`는 삭제된 최대 id도 다시 쓰지 않으므로 시퀀스가 더 크면 그 값을 따른다(spec "이전 뒤 새 행"). 확인은 `information_schema_stats_expiry = 0` 세션에서 읽는다.

### D4. 정규화 해시 규칙(두 언어 공통)
- 행 직렬화: 원본 SQLite 컬럼 순서의 값 배열을 JSON 배열로 쓴 한 줄. 값 규칙 — NULL은 `null`, 정수는 10진 문자열, 시각은 `YYYY-MM-DDTHH:mm:ss.SSSZ`, 날짜는 `YYYY-MM-DD`, JSON 컬럼은 파싱 뒤 키를 재귀 정렬해 다시 쓴 문자열, 그 밖 문자열은 그대로(NFC 정규화도 하지 않음). 줄 정렬은 기본 키 오름차순(정수 키는 숫자로, `collector_state.key`는 UTF-8 바이트 순으로 — MySQL 콜레이션 정렬을 쓰지 않는다).
- 테이블 해시 = SHA-256(줄들을 `\n`으로 이은 UTF-8 바이트). 이전 완료 표식 키(D7)는 대상 쪽에서 제외한다.
- 두 구현의 일치는 **교차 언어 골든**으로 고정한다: 작은 합성 SQLite 픽스처(빈 번호 id, 큰 금액, 밀리초 없는 시각·`+09:00` 시각, 키 순서가 다른 JSON, 이모지·뒤쪽 공백·백슬래시 문자열, NULL)로 TS가 만든 매니페스트와 SQL을 `backend/src/test/resources/migration/`에 커밋하고, Java 테스트가 그 SQL을 Testcontainers MySQL에 적재해 같은 해시를 계산하는지 본다. 픽스처는 합성값만 쓴다(실명 없음).
- **버린 대안**: `CHECKSUM TABLE`이나 `mysqldump` 비교 — SQLite 쪽에 대응이 없고 표기 차이(JSON, 시각)를 흡수하지 못한다. 표본 값 비교만 하는 안(ROADMAP 완료 기준 "표본 값") — 전수 해시가 더 강하고 데이터가 작아(약 5천 행) 비용이 없다. 표본 비교는 API 비교(D6)가 맡는다.

### D5. 가져오기: 한 트랜잭션, 거부 기본, 교체는 명시, 드라이런은 롤백
- 순서: Flyway 마이그레이션(기동 시 자동) → 적용 이력에 실패가 없고 최신 버전이 저장소의 마지막 파일과 같은지 확인 → 8개 테이블 컬럼 집합이 매니페스트와 같은지(`information_schema`) → `GET_LOCK`(수집·사진 워커와 같은 이름 두 개, 0초 대기, 못 얻으면 중단) → 트랜잭션 시작 → 대상 비어 있음 확인(아니면 `auctionboss.import.replace=true`일 때만 FK 역순 `DELETE`, 아니면 테이블별 건수를 알리고 중단) → SQL 실행 → 행 수·해시 재계산과 매니페스트 대조 → 사진 파일 복사·대조(D8) → 이전 완료 표식 쓰기(D7) → 커밋 → `AUTO_INCREMENT` 설정·확인.
- `TRUNCATE`가 아니라 `DELETE`를 쓰는 이유: `TRUNCATE`는 암묵적 커밋이라 실패 시 "대상이 이전 전 상태"(spec "중간 실패")를 지킬 수 없다. 데이터가 작아 비용 차이가 없다.
- **드라이런**(`auctionboss.import.dry-run=true`): 위 순서를 표식 쓰기까지 똑같이 하고 커밋 대신 롤백한다. 사진은 임시 디렉터리에 복사해 대조한 뒤 지운다. 운영 대상에 그대로 돌려 볼 수 있는 유일한 무해한 방법이다.
- 1회 실행 모드는 웹 서버를 띄우지 않고 수집·사진 스케줄러를 만들지 않는다(4단계 D11과 같은 실행기). 종료 코드 0/1. 출력은 건수·해시·시간·컬럼 이름만.
- 패키지는 `com.auctionboss.migration`. SQL 실행은 `ScriptUtils`(문자열 리터럴 안의 `;` 처리 확인 — 시드와 같은 생성기라 같은 방식으로 이미 적재된다).

### D6. 이전 뒤 동등성: 기존 도구 재사용, 결과는 건수만
- **API 비교** `scripts/migrate/compare-api.ts`: `generate-contracts.ts`의 요청 목록(시각 의존 요청 제외 규칙 포함)에 더해, 원본의 모든 물건 id에 대해 상세·변경 이력·분석 이력(`limit=50`)·사진 목록을 만든다. 기존 Next 라우트 핸들러를 백업 SQLite(`AUCTIONBOSS_DB`)로 직접 호출하고, 같은 요청을 이전된 MySQL에 붙은 Spring(운영 프로필, 스케줄러 꺼짐)에 보내 `ContractTest.diff`와 같은 엄격 비교를 한다. 출력은 요청 수, 불일치 수, 불일치한 요청 이름과 JSON 경로뿐이다. 워커 상태 판정처럼 "지금"에 따라 바뀌는 요청은 제외한다(시나리오 골든이 이미 고정 시계로 덮는다).
- **화면 비교**: `scripts/dev/compare-screens.sh`에 원천을 바꿔 끼우는 환경 변수(`SQLITE_DB`, `SPRING_BASE`, 시드 단계 건너뛰기)를 더해, 백업 SQLite와 이전된 MySQL로 화면 5개와 변형을 비교한다. HTML·스크린숏은 `docs/untracked/`에만 쓰고 리허설·전환 뒤 지운다(실명 포함). 폼 쓰기 단계는 운영 대상에서는 건너뛴다(관심·읽음 상태를 바꾸지 않기 위해).

### D7. 이전 완료 표식과 기동 조건
- 표식: `collector_state`의 키 `migration.completed`(값: 매니페스트 해시 요약 JSON, `updated_at`: 완료 시각). 새 테이블을 만들지 않는 이유는 8개 테이블 1:1 요구사항과 Flyway 무변경을 지키기 위해서다. 화면의 로테이션·백오프 조회는 자기 키만 읽으므로 영향이 없다(테스트로 확인).
- 기동 조건: `prod` 프로필에서 `auctionboss.collector.enabled` 또는 `auctionboss.photos.enabled`가 참이면, 기동 시 표식이 없을 때 `ApplicationContext` 시작을 실패시킨다(오류 메시지에 이유와 런북 위치). 프로필 조건이라 테스트·시드·개발 실행에는 영향이 없다.
- **근거**: 5장 커밋 뒤에는 `docker compose up` 한 번이 곧 운영 전환이다. 이전 전에 누가 그것을 하면 빈 MySQL로 실제 사이트에 요청하고(TS 수집기는 이미 compose에서 빠짐) 데이터가 두 DB로 갈라진다. 기동 실패가 가장 시끄럽고 안전한 실패다.
- **버린 대안**: 5장 구성 변경을 전환 날까지 브랜치에 두는 안 — 커밋·푸시 단위로 일하는 이 저장소 방식과 맞지 않고, 실수 방지가 사람 기억에 달린다. 새 건너뜀 사유(`not-migrated`)로 회차를 기록하는 안 — `run-observability` 의미가 바뀌고 회차 기록이 쌓인다. 기각.

### D8. 사진 파일: 백엔드 전용 볼륨으로 복사
- 운영 구성에서 백엔드는 사진 볼륨 `photos-data`를 `/app/photos`에 마운트하고 `AUCTIONBOSS_PHOTOS_DIR=/app/photos`(→ `auctionboss.photos.dir`)를 쓴다. `backend/Dockerfile`에서 `/app/photos`를 만들고 소유자를 `app`(uid 10001)으로 둔다(빈 named volume은 이미지 디렉터리 소유권을 물려받는다).
- 내보내기는 `item_photos`가 가리키는 파일만 `data/migration/<시각>/photos/`에 같은 상대 경로로 복사하고 크기·해시를 매니페스트에 적는다. 가져오기는 그 디렉터리를 읽기 전용으로 받아 사진 디렉터리에 쓰고(기존 `PhotoFileStore` 경계 검사와 같은 규칙), 해시를 다시 확인한다. 대상 사진 디렉터리에 같은 경로의 다른 파일이 있으면 교체 모드에서만 덮어쓴다.
- **버린 대안**: 기존 SQLite 볼륨을 백엔드에도 마운트(`/app/data/photos`). 복사가 없어 빠르지만 롤백 기준 볼륨을 새 쓰기 주체(Spring 사진 워커)가 바꾸게 되어 롤백 창의 "기존 볼륨 무변경"(spec "롤백 창")을 깨고, SQLite 은퇴 뒤에도 옛 볼륨을 계속 끌고 간다. 기각.
- 고아 파일(기록 없는 파일, 실측 1개)은 옮기지 않고 건수만 보고한다. 기존 볼륨에 남으므로 잃지 않는다.

### D9. 배포 구성
- **백엔드 운영 프로필** `application-prod.yml`: 데이터소스 URL·사용자·비밀번호를 환경 변수에서 **기본값 없이** 읽는다(`${DB_PASSWORD}` — 없으면 기동 실패. `local` 프로필처럼 `auctionboss/auctionboss`로 대신 접속하지 않음). `.env` import 없음, 시드 없음.
- **compose(운영 구성)**: `collector`·`photos` 서비스 삭제. `backend`: `SPRING_PROFILES_ACTIVE=prod`, `AUCTIONBOSS_COLLECTOR_ENABLED=true`, `AUCTIONBOSS_PHOTOS_ENABLED=true`, `AUCTIONBOSS_SOURCE_EXTERNAL_REQUESTS_ALLOWED=true`, `AUCTIONBOSS_PHOTOS_DIR=/app/photos`, `photos-data` 볼륨, `config/collector.json` 읽기 전용, 포트 루프백 유지. `web`: `AUCTIONBOSS_DATA_SOURCE=spring`, `AUCTIONBOSS_SPRING_BASE=http://backend:8080`, `depends_on: backend: service_healthy`, 데이터 볼륨·`AUCTIONBOSS_DB` 삭제. `analyzer`: `AUCTIONBOSS_API_BASE=http://backend:8080`, `depends_on: backend`. DB 변수는 `${DB_PASSWORD:?…}` 필수 검사로 바꾼다 — 1단계에서 `:?`를 피한 이유("`.env`가 없으면 기존 web/collector까지 못 띄움")가 사라졌다(이제 모든 서비스가 MySQL을 필요로 한다). 기존 SQLite 볼륨 `auctionboss-data`는 **선언을 남기되 어느 서비스도 마운트하지 않는다**(롤백 창 동안 `docker compose down -v` 외에는 지워지지 않게 이름 유지, 은퇴 때 선언 삭제).
- **스모크·개발 구성** `docker-compose.smoke.yml`: 독립 프로젝트 이름(`name: auctionboss-smoke`)으로 `mysql`·`backend`만, `local,seed` 프로필, 세 설정 없음, 별도 볼륨. `docker-smoke.sh`는 이 파일과 `-p auctionboss-smoke`만 쓴다 — 지금 스크립트의 `docker compose down -v`가 운영 MySQL 볼륨을 지우는 위험을 없앤다(spec "기존 경로 무영향").
- **K8s**: `deployment.yaml`을 웹 컨테이너 하나로 줄이고(볼륨 제거, `AUCTIONBOSS_DATA_SOURCE=spring`, `AUCTIONBOSS_SPRING_BASE=http://auctionboss-backend:8080`, readiness `/api/health`, liveness는 `tcpSocket` 3000), `deployment-backend.yaml`(replicas 1, `strategy: Recreate`, 사진 PVC, 세 설정 켬, readiness·liveness `/api/health`, Secret에서 DB 변수), `service-backend.yaml`(ClusterIP, Ingress 없음), `statefulset-mysql.yaml`(mysql:8.4, `volumeClaimTemplates`, 헤드리스 서비스, 문자셋·콜레이션 인자), `secret.yaml`에 키 이름만(값 없음, `kubectl create secret` 안내 주석), 분석 워커 `AUCTIONBOSS_API_BASE=http://auctionboss-backend:8080`. `configmap.yaml`에서 `AUCTIONBOSS_DB` 삭제. `pvc.yaml`의 SQLite PVC는 compose와 같은 이유로 롤백 창 동안 남긴다. 검증은 `deploy-config.test.ts`의 정적 검사와 `kubectl kustomize`(있을 때만, 없으면 건너뛰고 메모)뿐이다(ROADMAP: 실제 클러스터 운영 안 함).
- **`deploy-config.test.ts` 반전**: "백엔드 수집·사진 워커 기본 꺼짐 유지" 묶음을 "운영 구성에서만 켬"으로 바꾼다 — (a) compose `backend`와 K8s 백엔드 컨테이너는 세 설정이 참, (b) `docker-compose.smoke.yml`과 리허설 덮어쓰기는 외부 요청 허용을 켜지 않음(리허설은 주기 실행만 켬), 스모크는 셋 다 켜지 않음, (c) compose·K8s 파일 어디에도 `run-once` 없음(실제 소스 최소 확인 스크립트 `live-check-collector.sh`는 4단계 D13대로 1회 실행에만 허용을 켜며 배포 파일이 아니다), (d) TS `collector`·`photos` 서비스·컨테이너 없음, (e) `npm run collector|photos` 명령이 배포 파일에 없음. "운영 데이터 원천 유지" 묶음은 "웹은 spring 원천, 백엔드 서비스 주소"로 뒤집는다. 분석 워커 주소 단언은 백엔드 서비스로 바꾼다. 비밀: compose·K8s 파일에 비밀번호 리터럴이 없음, `secret.yaml` `data`에 값 없음.
- **웹 헬스체크**: `/api/health`는 데이터 포트에 `health()`를 더해 원천에 묻는다. Spring 원천은 백엔드 `/api/health`를 5초 제한으로 부르고 200이면 `connected`, 그 밖은 503. SQLite 원천(롤백 창 동안만 존재)은 지금 그대로. 응답 형태는 같다.

### D10. 전환 절차(런북)와 다운타임 측정
`docs/REFERENCE.md` "운영 전환 런북"에 쓰고, 리허설·실제 전환이 같은 문서를 따른다. 시각마다 `date -u`를 메모한다.
1. **사전 확인**: 4단계 아카이브, 게이트 5종, `docker compose config`가 오류 없이 해석, `.env`에 DB 변수 존재(값 출력 금지), SQLite `backoff_until`이 과거 또는 없음, TS 수집 마지막 회차 종료 시각 기록.
2. **쓰기 정지(T0, 다운타임 시작)**: `docker compose stop collector photos analyzer web`(전환 전 구성). 진행 중 회차 없음 확인.
3. **백업·내보내기**: `npx tsx scripts/migrate/export.ts --source <원본>` → `data/migration/<시각>/`. 원본이 compose 볼륨이면 먼저 `docker run --rm -v …:/data` 로 파일을 복사해 온다(1.2에서 정함).
4. **구성 전환**: 전환 커밋을 체크아웃한 상태에서 `docker compose up -d mysql`(운영 프로필 MySQL 볼륨이 시드로 차 있으면 5에서 교체).
5. **가져오기**: 드라이런 1회 → 본 실행(`replace`는 대상이 시드뿐임을 드라이런 보고로 확인한 경우만). 백엔드 이미지로 `docker compose run --rm -e AUCTIONBOSS_RUN_ONCE=import … backend`.
6. **검증**: 백엔드를 스케줄러 끈 채 띄워(`AUCTIONBOSS_COLLECTOR_ENABLED=false` 덮어쓰기) API 비교(D6). 불일치가 1건이라도 있으면 7로 가지 않고 롤백.
7. **켬(T1)**: `docker compose up -d backend web analyzer`. 백엔드 첫 수집 틱이 TS 마지막 회차 종료 + 수집 주기 이후인지 확인(아니면 백엔드 기동을 그만큼 늦춘다).
8. **확인(T2, 다운타임 끝)**: 웹 헬스 200, 화면 5개 200, 첫 수집·사진 회차 결과, 분석 워커 첫 회차 성공, `git diff --stat <시작 커밋> -- workers/analyzer.ts workers/lib workers/prompts` 0줄.
- 수치: 다운타임 = T2 − T0, 수집 공백 = (Spring 첫 수집 회차 시작) − (TS 마지막 수집 회차 종료) — 두 값 모두 이전된 `worker_runs`에 있어 MySQL 쿼리 하나로 잰다. 내보내기·가져오기 시간, 행 수·해시 일치, API 비교 건수.

### D11. 롤백: 역이전 없음, 롤백 창 + 상태 되쓰기
- **결정**: MySQL → SQLite 역이전 도구를 만들지 않는다. 롤백 창 안에서는 전환 직전 백업과 손대지 않은 SQLite 볼륨으로 되돌리고, 그 사이 MySQL에 생긴 데이터는 버린다.
- **근거**: 단일 사용자이고, 롤백 창 동안 생기는 데이터 대부분은 재생성된다 — 물건·변경 이력은 TS 수집기가 다음 로테이션에서 다시 가져와 변경을 다시 감지한다(감지 시각만 늦어짐), 사진은 대기열이 다시 가져온다, 관심·읽음은 0건에서 시작했다. 다시 만들 수 없는 것은 그 사이의 분석(Claude 호출 비용)과 회차 기록뿐이다. 역이전 도구는 두 번째 이전 경로(시각·JSON 역변환, id 충돌, 해시 검증)를 한 번 쓰고 버릴 코드로 새로 증명해야 한다.
- **잃으면 안 되는 것**: 차단 백오프. Spring이 롤백 창 중 차단을 받았는데 TS 수집기가 SQLite의 옛 백오프로 돌아가면 차단 중인 사이트에 바로 요청한다. 그래서 (1) 백엔드 1회 실행 모드 `auctionboss.run-once=export-state`가 MySQL의 `backoff_until`과 로테이션 위치를 JSON으로 출력하고(값은 시각과 법원 코드뿐, 실명 없음), (2) `scripts/migrate/rollback-state.ts`가 그 JSON을 받아 MySQL 백오프가 SQLite 값보다 늦을 때만 쓰고(TS `collector-state.ts`의 "짧아지지 않음" 규칙 재사용), 로테이션 위치는 MySQL 값으로 쓴다. TS에 MySQL 드라이버를 들이지 않는다(D1).
- **기록**: 백엔드 1회 실행 모드 `auctionboss.run-once=delta-report`(`auctionboss.delta.since=<전환 시각>`)가 그 시각 이후 생긴 회차·분석·관심, 처음 본 물건, 변경 이력, 사진 기록 건수를 테이블별로 출력한다. 값은 출력하지 않는다.
- **롤백 절차**: 백엔드 스케줄러 끄기(`AUCTIONBOSS_COLLECTOR_ENABLED=false` 등으로 재기동) → 분석 워커·웹 정지 → 델타 보고 → 상태 되쓰기 → 전환 직전 커밋의 compose로 `web`·`collector`·`photos`·`analyzer` 기동(SQLite 볼륨). 백업 파일은 볼륨이 손상됐을 때만 복원한다.
- **롤백 창**: 전환 뒤 최소 72시간이면서, 그 동안 Spring 수집 성공 회차 30회 이상·사진 성공 회차 3회 이상·분석 성공 회차 1회 이상, 차단·실패 회차가 TS 시절 비율(1장 실측) 이하일 것. 창이 끝나면 사람이 확인하고(8.1) 은퇴를 시작한다. 창이 끝난 뒤의 롤백은 git 되돌리기 + 6단계 백업 체계의 몫이다.

### D12. 은퇴 범위와 순서(8장)
- **지우는 것**: `src/lib/data-port/sqlite.ts`와 원천 선택의 `sqlite` 분기(값 `sqlite`는 은퇴 오류), `src/lib/db/**`, `src/lib/storage/photos.ts`의 SQLite 경로 의존, `src/lib/sources/**`(TS 어댑터), `workers/collector.ts`·`workers/photos.ts`와 테스트·`package.json` 스크립트, Next JSON API 라우트 17개(남김: `health`, `bookmarks/toggle`, `feed/mark-read`, `photos/[itemId]/[seq]`), SQLite를 여는 생성기(`scripts/seed/export-seed.ts`·`generate-contracts.ts`·`generate-scenarios.ts`·`seed-to-sqlite.ts`, `scripts/collector-golden/` 생성기, `scripts/dev/` 중 SQLite 의존 스크립트), `scripts/migrate/`, `better-sqlite3`·`@types/better-sqlite3`, Dockerfile의 `python3 make g++ gcc`와 `/app/data` 볼륨, CI의 `build-essential` 설치 단계, compose·K8s의 SQLite 볼륨·PVC 선언.
- **남기는 것**: 커밋된 골든 전부(`backend/src/test/resources/contracts/**`, 이전 교차 언어 골든 포함) — spec "계약 골든 동결". 시드 SQL(`backend/src/main/resources/db/seed/`)과 `masking.ts`·`sql.ts`의 순수 함수 테스트(시드 재생성은 하지 않지만 시드 SQL의 가림 검사 테스트는 SQL 파일만 읽으므로 유지 여부를 8장에서 판정). 화면 렌더 테스트는 가짜 `DataPort`(메모리 구현)로 돈다 — 지금 SQLite로 데이터를 넣던 렌더 테스트는 메모리 포트로 옮긴다.
- **순서**: 렌더·포트 테스트를 메모리 포트로 이전 → 라우트·워커·저장소 삭제 → 의존성·이미지·CI 정리 → 린트 경계 재작성 → 게이트. 지울 파일 목록은 `tsc`·import 그래프로 확정하고(`src/lib/domain/**`처럼 화면이 쓰는 순수 타입은 남김), 남은 파일이 `better-sqlite3`·`@/lib/db`를 가져오지 않음을 `grep`으로 확인한다.
- **린트 경계 재작성**: (1) `src/**`, `workers/**`, `scripts/**`(테스트 포함) 전체에서 `better-sqlite3`, `mysql2`, `mysql`, `@/lib/db*` 가져오기 금지(예외 없음). (2) `workers/**`에서 `@/lib/data-port*`, `next`, `next/*`, `@/app/*` 금지(분석 워커는 HTTP만). (3) `src/app/**`에서 `@/lib/data-port/spring/*` 직접 가져오기 금지(포트 인터페이스만). 각 규칙을 위반 픽스처로 확인한다(`eslint` API로 가상 파일 검사하는 테스트).
- **테스트 수 감소**: TS 테스트는 크게 줄어든다(저장소·SQLite 포트·수집기·사진 워커·어댑터·골든 생성기·JSON 라우트 테스트). 줄어든 개수를 지운 묶음별로 표로 보고하고, 각 묶음의 동작을 지금 어느 Java 테스트가 덮는지 짝을 적는다(덮는 테스트가 없는 동작이 있으면 Java 쪽에 먼저 더한 뒤 지운다).
- **버린 대안**: 은퇴를 별도 후속 change로 미루는 안 — 롤백 창과 맞물린 건 맞지만, ROADMAP 5단계 정의가 은퇴를 포함하고 사용자 지시가 "5단계까지"다. 8장 첫 task를 사람 확인 관문으로 두어 같은 효과를 낸다. 은퇴를 전환과 같은 날 하는 안 — 롤백할 길이 사라진다. 기각.

### D13. 리허설(6장): 운영 복사본 + 가짜 소스, 실제 사이트 0요청
- 별도 compose 프로젝트(`-p auctionboss-rehearsal`, 별도 볼륨, 다른 호스트 포트)에 운영 구성 파일을 쓰되 덮어쓰기 파일 `scripts/dev/rehearsal.override.yml`로 `AUCTIONBOSS_SOURCE_EXTERNAL_REQUESTS_ALLOWED=false`, 소스 주소 = `http://127.0.0.1:<포트>`, 수집 주기 1분을 준다. 가짜 소스 서버(4단계 `scripts/dev/fake-source-server.ts`)는 `network_mode: "service:backend"` 사이드카 컨테이너로 띄워 백엔드와 같은 네트워크 네임스페이스의 **루프백**에서 받게 한다 — 외부 요청 허용을 끈 채로(루프백만 허용, 4단계 D4) 전 경로를 돌릴 수 있는 유일한 배치다(같은 compose 네트워크의 다른 컨테이너 이름이나 `host.docker.internal`은 루프백이 아니라서 거절된다). 원본은 운영 SQLite의 백업 복사본, 사진도 복사본.
- 절차는 D10 런북 그대로, 두 번 돈다(두 번째는 `replace`로 재실행 → 같은 해시 확인 = 멱등). 이어 롤백 리허설(D11)을 하고 TS 경로가 복사본으로 다시 뜨는지 확인한다(이때 TS 수집기·사진 워커는 가짜 소스로 향하게 `AUCTIONBOSS_*` 개발용 변수로 돌리거나 띄우지 않고 기동만 확인).
- 리허설 산출물은 `docs/untracked/`, `data/migration/`에만. 끝나면 지운다.

### D14. 실명 보호
- 이전 산출물(SQL, 매니페스트의 경로 목록, 사진)과 비교 산출물(HTML)은 실명을 포함한다. 위치는 git 제외 경로만, 도구는 다른 경로를 거부한다.
- 도구 출력·오류 메시지에 값을 넣지 않는 것을 테스트로 고정한다: 합성 픽스처의 표식 문자열(예: `__REAL_NAME_SENTINEL__`)이 어떤 실패 경로의 출력에도 나오지 않는지 확인한다.
- 문서·커밋에는 건수·시간·해시 일치 여부만 쓴다. 9장 마지막에 `git ls-files` 전체에서 이번 전환으로 생긴 파일에 원본 실명이 없음을 확인한다(이름 목록은 `masking.ts`의 추출 함수로 원본에서 뽑아 메모리에서만 쓴다).

## Risks / Trade-offs

- [5장 커밋 뒤 이전 전에 `docker compose up`] → 운영 프로필 기동 조건(D7)으로 백엔드가 뜨지 않고, 웹·분석 워커도 백엔드 헬스에 묶여 뜨지 않는다. 런북 첫 줄에 적는다.
- [스모크 스크립트가 운영 MySQL 볼륨을 지움] → 별도 프로젝트 이름과 파일(D9). deploy-config 테스트가 `docker-smoke.sh`에 `-p auctionboss-smoke`가 있는지 본다.
- [MySQL `VARCHAR` 길이를 넘는 운영 값] → 1장에서 컬럼별 최대 길이를 실측한다(시드는 가림으로 값이 줄었을 수 있어 운영 원본으로 다시 잰다). 넘으면 이전 전에 Flyway 마이그레이션으로 넓히는 결정이 필요하므로 사용자에게 보고한다(이 change는 스키마 무변경이 기본). 넘는 값이 있어도 한 트랜잭션이라 부분 적재는 없다.
- [자연 키 콜레이션 충돌(`utf8mb4_0900_ai_ci`)] → 4단계 1장이 시드 809건에서 0건을 확인했다. 운영 원본으로 1장에서 다시 확인한다. 충돌하면 UNIQUE 위반으로 트랜잭션 전체가 실패한다.
- [JSON 컬럼 정규화로 화면 값이 달라짐] → MySQL `JSON`은 키 순서·공백을 바꾸지만 API는 파싱된 값을 내보낸다. D6 API 비교가 확인하고, 해시는 D4 규칙으로 흡수한다. 숫자 표기(`1.0` → `1.0`)가 바뀌는 경우는 1장에서 `detail`의 실수 값 존재 여부로 확인한다.
- [전환 직후 Spring 첫 회차가 TS 마지막 회차와 너무 가까워 요청 예산 초과] → 런북 7의 시각 확인, 이전된 백오프, 1회 실행 확인(4단계)의 결과. 첫 회차를 사람이 지켜본다.
- [롤백 창 동안 분석 결과 손실] → 롤백 시 델타 보고로 건수를 남긴다. 분석 워커 주기상 창 동안의 분석은 많지 않다(신규 물건 수에 비례). 받아들인다.
- [은퇴로 TS 테스트 수 급감 → 회귀 보호 약화로 보임] → 묶음별 Java 대응 테스트 짝 표(D12). 짝이 없으면 지우기 전에 Java 테스트를 더한다.
- [K8s 매니페스트가 실제 클러스터에서 검증되지 않음] → ROADMAP 범위(클러스터 운영 안 함). 정적 테스트와 `kubectl kustomize`로 문법만 확인한다고 문서에 적는다.
- [가짜 소스 서버(4단계 8장 산출물)가 아직 미완] → 6장은 4단계 아카이브 뒤에 시작한다(1.1 관문).

## Migration Plan

1. 1~4장: 도구와 테스트만 더한다. 운영 구성·데이터는 그대로.
2. 5장: 배포 구성을 전환 상태로 바꾸는 커밋. 이 커밋부터 `docker compose up`은 이전 완료 표식이 있어야 뜬다(D7). 롤백 창 동안 쓸 "전환 직전 구성"은 5장 직전 커밋 해시로 런북에 적는다.
3. 6장: 리허설(전환·재실행·롤백) 수치 기록. 실패하면 2~5장으로 돌아간다.
4. 7장: 사람 확인 뒤 실제 전환(D10). 실패 시 D11 롤백.
5. 롤백 창(D11) 관찰. 문제 시 롤백하고 원인을 고친 뒤 7장을 다시 한다.
6. 8장: 사람 확인 뒤 은퇴. 이후의 되돌리기는 git revert(코드)와 6단계 백업(데이터)의 몫이다.

## 결정 기록 (2026-10-09, 오케스트레이터)

사용자 지시는 "5단계까지 쭉 진행"이다. 계획 단계에서 열린 결정을 아래처럼 정한다. 실제 사이트 요청과 Claude 호출을 최소로 하는 쪽을 고른다.

1. **이전 원본은 `data/auctionboss.db`다.** compose 볼륨 `auctionboss_auctionboss-data`의 DB는 물건 0건·분석 0건으로, 이전의 compose 연기 시험이 남긴 빈 DB다(행 수만 확인). 1.2는 이 확인을 다시 하고 메모로 남긴다.
2. **상시 운영 환경이 없으므로 롤백 창을 시간이 아니라 회차로 정의한다.** 72시간 연속 수집은 개발 머신을 3일 켜 두고 실제 사이트에 수백 번 요청하는 일이라, 이 change 안에서 하지 않는다. 대신 전환 뒤 아래가 모두 성립하면 창을 닫는다.
   - Spring 수집 성공 회차 1회 이상(실제 사이트, 회차당 요청 상한 13), 사진 성공 회차 1회 이상, 차단·실패 0.
   - 분석 워커가 Spring에 붙어 회차를 성공으로 남긴다. Claude 호출은 가짜 CLI로 대신한다(2단계 방식). 실제 분석 비용을 쓰지 않는다.
   - 화면 5개가 `spring` 모드로 열리고, 이전 직후 API·화면 동등성 결과가 차이 0이다.
   - 회차 수가 72시간 기준에 못 미친다는 사실과, 장기 관찰은 상시 운영(6단계 백업 이후)의 몫이라는 점을 메모와 ROADMAP에 적는다.
3. **롤백 창 동안 생긴 분석을 버리는 것을 받아들인다.** 위 2에 따라 창 동안 실제 Claude 분석은 생기지 않는다. 역이전 도구는 만들지 않는다(D11 유지).
4. **은퇴(8장)는 이 change에 포함한다.** 8.1 관문은 위 2의 기준 충족 확인으로 대신한다. 은퇴 직전 커밋에 태그 `pre-retire-sqlite`를 남기고, 전환 직전 SQLite 백업 파일을 `docs/untracked/`가 아닌 `backups/`(git 무시)에 보존해 은퇴 뒤에도 되돌릴 길을 남긴다.
5. **컬럼 길이 초과나 자연 키 충돌이 나오면 멈추지 않고 Flyway V4로 넓힌다.** 1.3 실측 결과와 마이그레이션 내용을 메모에 남긴다. 키 충돌은 데이터 손실이 생기므로 그때만 멈추고 보고한다.
6. **K8s 매니페스트는 정적 검증만 한다.** 백엔드·MySQL 매니페스트를 더하고 deploy-config 테스트로 고정한다(실제 클러스터 없음, ROADMAP과 같음).
7. **전환 뒤 운영 스택은 확인이 끝나면 내린다.** 상시 수집을 개발 머신에서 계속 돌릴지는 사용자가 정한다. 구성은 `docker compose up` 한 번으로 전환 상태가 뜨게 남긴다.

## Open Questions

- 수집 공백을 줄이기 위해 전환 시각을 TS 회차 직후로 맞출지: 다운타임·공백 수치에만 영향이 있고 절차는 같다. 7장 당일 정한다.
- 롤백 창의 회차 기준 숫자(30·3·1)의 미세 조정: 1장 실측 회차 주기로 72시간 동안 나오는 회차 수를 계산해 맞춘다. 구조는 바뀌지 않는다.
