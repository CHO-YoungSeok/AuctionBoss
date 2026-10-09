## Why

1~4단계로 Spring은 읽기·쓰기 API, 화면용 API, 수집·사진 워커를 기존과 같은 계약으로 갖췄지만, 운영 데이터는 여전히 SQLite 파일 하나에 있고 화면·분석 워커·수집 워커는 모두 그 파일 쪽 경로로 돈다. Spring이 "DB의 유일한 주인"이 되려면 운영 데이터를 MySQL로 옮기고, 세 쓰기 주체를 한 번에 Spring으로 돌려야 한다. 수집기는 두 구현이 동시에 돌면 같은 IP의 요청 예산을 두 배로 쓰고 서로의 백오프를 못 보므로(4단계 D14), 전환은 "멈춤 → 이전 → 검증 → 켬"의 한 번짜리 절차여야 한다.
전환 뒤에는 SQLite 구현체, 기존 Next JSON API, TS 수집·사진 워커가 두 번째 진실 원천으로 남아 다시 쓰일 위험만 만든다. 롤백 창이 끝나면 이들을 은퇴시켜 ROADMAP 5단계를 닫는다.

## What Changes

- **운영 데이터 이전 도구**: (a) TS 내보내기 — 쓰기 주체를 멈춘 SQLite를 백업 API로 복사하고, 그 백업에서 8개 테이블 전체를 MySQL INSERT SQL로 쓴다. 1단계 시드 생성기(`scripts/seed/sql.ts`)의 값 변환을 그대로 쓰되 **가림은 하지 않는다**(운영 데이터). 테이블별 행 수, 정규화한 행 직렬화의 SHA-256, `sqlite_sequence`, 사진 파일 해시를 매니페스트로 남긴다. 결과물은 git이 추적하지 않는 `data/migration/` 아래에만 쓴다. (b) Spring 가져오기 — 1회 실행 모드(`auctionboss.run-once=import`)가 Flyway 최신 확인, 컬럼 집합 비교, 대상 비어 있음(또는 명시한 교체) 확인 뒤 **한 트랜잭션**으로 적재하고, MySQL에서 같은 규칙으로 해시를 다시 계산해 매니페스트와 대조한다. 어긋나면 롤백한다. 드라이런은 같은 트랜잭션을 끝까지 돌린 뒤 롤백한다. id는 원본 그대로 보존하고 `AUTO_INCREMENT`는 원본 시퀀스 이상으로 맞춘다. 사진 파일은 백엔드 사진 디렉터리로 복사하고 해시로 확인한다.
- **이전 후 동등성 확인**: 3단계 도구를 재사용해 같은 요청을 기존 Next 핸들러(백업 SQLite)와 Spring(이전된 MySQL)에 보내 상태 코드·본문을 비교하고, 화면 5개와 변형의 HTML을 두 모드로 비교한다. 결과는 불일치 건수만 남긴다.
- **이전 완료 표식과 스케줄러 기동 조건**: 가져오기가 성공하면 같은 트랜잭션에서 `collector_state`에 이전 완료 표식을 쓴다. 운영 프로필에서 수집·사진 스케줄러가 켜져 있는데 표식이 없으면 백엔드는 기동을 거부한다 — 이전 전에 `docker compose up`을 해도 빈 DB로 실제 사이트에 요청하지 않게 한다.
- **배포 구성 전환** (**BREAKING**: 운영 구성이 SQLite 경로를 더 이상 띄우지 않는다): compose·K8s에서 TS `collector`·`photos`를 지우고, 백엔드를 운영 프로필(시드 없음, `.env`·Secret에서 접속 정보)로 띄우며 수집·사진 스케줄러와 외부 요청 허용을 켠다. 웹은 `AUCTIONBOSS_DATA_SOURCE=spring`, 분석 워커는 `AUCTIONBOSS_API_BASE`를 백엔드로 바꾼다. 사진은 백엔드 전용 볼륨으로 옮긴다. K8s에 백엔드 Deployment와 MySQL StatefulSet·Secret을 더한다. `deploy-config.test.ts`의 "켜지 않음" 단언을 "운영 구성에서만 켜짐, 테스트·스모크·리허설 구성에서는 외부 요청 허용 꺼짐"으로 뒤집는다. 웹 헬스체크는 Spring 모드에서 백엔드 헬스를 본다.
- **전환 절차와 롤백**: 쓰기 주체 정지 → 백업·내보내기 → 가져오기·검증 → 백엔드 스케줄러 켬 → 분석 워커·웹 전환 → 첫 회차 확인. 개발 환경에서 운영 복사본과 가짜 소스 서버로 전환·롤백을 먼저 리허설한다. 실제 운영 전환은 실제 사이트 요청이 생기므로 사람이 확인하고 실행한다. 롤백은 역이전 도구 없이 **롤백 창** 안에서만 한다: 전환 직전 SQLite 백업과 손대지 않은 기존 볼륨으로 돌아가고, 그 사이 MySQL에 생긴 데이터는 건수만 기록하고 버린다. 단, MySQL의 차단 백오프가 더 늦으면 그 값과 로테이션 위치는 SQLite로 되돌려 쓴다(차단 위험 때문).
- **은퇴(롤백 창 종료 뒤, 사람 확인)**: 데이터 포트의 SQLite 구현체, `src/lib/db/**`, `better-sqlite3`, 기존 Next JSON API 라우트 17개(화면용 4개 — 헬스체크, 관심 토글 폼, 읽음 처리 폼, 사진 파일 — 는 남김), TS 수집·사진 워커와 TS 소스 어댑터, SQLite에 의존하는 골든 생성기·이전 도구를 지운다. 커밋된 계약·시나리오·수집 골든은 **동결**해 Spring 테스트의 기준으로 남긴다. `AUCTIONBOSS_DATA_SOURCE=sqlite`는 은퇴를 알리는 오류가 된다. 린트 경계를 다시 짠다: 화면은 데이터 포트만, `src/**`·`workers/**`는 DB 드라이버 금지, 분석 워커는 Next·데이터 포트 금지.

이 change에서 하지 않는 것:
- 분석 워커 코드 변경(주소 환경 변수만 바꾼다. ROADMAP 핵심 검증), 수집 범위·주기·상한 변경, 스키마 변경(Flyway 마이그레이션 추가 없음).
- 역이전 도구(MySQL → SQLite), 상시 운영 환경·지표·알림·`mysqldump` 백업 체계(6단계), 인증(7단계).
- 실제 Kubernetes 클러스터 배포(ROADMAP "하지 않는 것"). 매니페스트는 맞추되 정적 검사로만 확인한다.

## Capabilities

### New Capabilities
<!-- 없음 -->

### Modified Capabilities
- `spring-backend`: 운영 데이터 이전(id 보존, 행 수·해시 검증, 원자성·멱등·드라이런, 사진 파일), 이전 완료 표식과 스케줄러 기동 조건, 전환 순서·롤백 창, 계약 골든 동결을 더한다(ADDED). 컨테이너 기반 실행(운영 프로필, 기존 경로 무영향 조항 삭제)과 분석 워커 연결(운영 경로를 백엔드로)을 고친다(MODIFIED). 4단계가 더한 스케줄러 기본 꺼짐 요구사항을 "코드 기본값은 꺼짐, 운영 구성만 켬"으로 고치고, "수집 운영 전환 보류와 동시 운영 금지"를 "수집 운영 전환과 동시 운영 금지"로 바꾼다(REMOVED + ADDED).
- `web-data-port`: 원천 선택을 Spring 하나로 줄이고 SQLite 값을 은퇴 오류로 만든다. 폼·사진 경로의 "두 원천" 시나리오를 하나로 고친다(MODIFIED). 기존 JSON API를 예외로 두던 "화면 데이터 접근 경계"를 예외 없는 "웹 앱과 분석 워커의 데이터 접근 경계"로 바꾼다(REMOVED + ADDED). 원천 간 동등성, 화면용 읽기 API의 계약 원본, 운영 데이터 원천 유지를 없앤다(REMOVED).
- `deployment-and-health`: 헬스체크(데이터베이스 상태를 백엔드 헬스로 판정)와 볼륨(MySQL·사진, 웹 앱은 볼륨 없음)을 고친다(MODIFIED). SQLite 공유를 전제로 한 "쿠버네티스 워크로드 구성"과 "Docker Compose 구성"을 "쿠버네티스 백엔드 중심 워크로드 구성"(백엔드·MySQL, 웹 Pod에서 워커 제거, 분석 워커 → 백엔드)과 "Docker Compose 운영 구성"(TS 워커 제거, 백엔드 운영 설정, 접속 정보 필수)으로 바꾼다(REMOVED + ADDED). 기존 시나리오 이름을 그대로 둘 수 없을 만큼 뜻이 바뀌어 교체로 다룬다.

`auction-collection`, `item-photos`, `run-observability`, `auction-history`, `auction-analysis`, `bookmarks`, `auction-viewing`의 요구사항은 바뀌지 않는다(저장소·구현 언어를 언급하지 않는다). 같은 동작을 Spring이 맡을 뿐이다.
`spring-backend`의 일부 요구사항(스케줄러 기본 꺼짐, 수집 운영 전환 보류)은 진행 중인 `port-collector-to-spring`이 더한다. 이 change는 그 change가 아카이브된 뒤에 아카이브한다. `web-data-port`·`deployment-and-health`의 Purpose 문장은 아카이브 뒤 메인 스펙에서 직접 고친다(델타로 바꿀 수 없음).

## Impact

- **신규 코드**: `scripts/migrate/`(백업·내보내기·매니페스트·정규화 해시, API 비교, 롤백 상태 되쓰기), `backend`의 `migration` 패키지(1회 실행 모드 `import`·`export-state`·`delta-report`, 검증·사진 복사·표식, 기동 조건 검사), `application-prod.yml`, `docker-compose.smoke.yml`(스모크·개발용, 수집 꺼짐), `scripts/dev/rehearsal.override.yml`, K8s `deployment-backend.yaml`·`statefulset-mysql.yaml`·Secret 키
- **바뀌는 코드**: `docker-compose.yml`, `k8s/**`, `deploy/k8s/README.md`, `backend/Dockerfile`(사진 디렉터리), `src/app/api/health/route.ts`, `scripts/docker-smoke.sh`, `src/__tests__/deploy-config.test.ts`(단언 반전), `.env.example`(키만)
- **은퇴(8장)**: `src/lib/db/**`, `src/lib/data-port/sqlite.ts`, `src/lib/sources/**`, `src/lib/storage/**`의 SQLite 의존 부분, `workers/collector.ts`·`workers/photos.ts`, Next JSON API 라우트 17개, `scripts/seed/` 생성기·`scripts/collector-golden/` 생성기·`scripts/migrate/`, `better-sqlite3`, Dockerfile·CI의 네이티브 빌드 도구. TS 테스트 수가 크게 준다(이유를 표로 보고)
- **바뀌지 않는 것**: `workers/analyzer.ts`·`workers/lib/**`(diff 0줄), Flyway V1~V3, Spring API 계약과 커밋된 골든, `config/collector.json`
- **운영 영향**: 전환 동안 수집·화면·분석이 멈추는 다운타임(분 단위)과 수집 공백. 전환 뒤 실제 사이트 요청은 Spring만 보낸다
- **개인 정보**: 이전 결과물·비교 산출물은 실명을 포함하므로 git 제외 경로(`data/migration/`, `docs/untracked/`)에만 두고 문서에는 건수·시간만 남긴다
- **문서**: `docs/REFERENCE.md` 운영 런북(전환·롤백), `docs/DEVELOPMENT_NOTES.md` 17절 수치, `docs/ROADMAP.md` 5단계, README 실행 방법
