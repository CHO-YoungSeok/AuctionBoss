## Why

AuctionBoss의 백엔드는 Next.js API 라우트와 SQLite(better-sqlite3)로만 이뤄져 있다. 단일 프로세스·단일 파일 DB라서 서버를 늘리거나 워커를 분리 배포하기 어렵고, 백엔드 표준 스택(Spring Boot, RDBMS, 스키마 마이그레이션)으로 설계·운영한 경험을 보여 줄 수 없다.
수집 범위를 넓히기 전에, 백엔드와 데이터 계층을 먼저 Spring Boot + MySQL로 옮길 토대를 만든다. 지금 쌓인 실제 수집 데이터를 더미 데이터로 쓰므로 외부 사이트에 추가 요청을 보내지 않고도 개발과 시연이 가능하다.

## What Changes

- **Spring Boot 백엔드 신설 (`backend/`)**: 같은 저장소 안에 Gradle 기반 Spring Boot 애플리케이션을 추가한다. JPA + QueryDSL로 데이터에 접근한다.
- **MySQL 8 도입과 스키마 1:1 이식**: 현재 SQLite 테이블 8개(`items`, `analyses`, `item_changes`, `worker_runs`, `bookmarks`, `feed_reads`, `collector_state`, `item_photos`)를 컬럼 구성 그대로 MySQL로 옮긴다. 스키마는 Flyway 마이그레이션으로 관리한다.
- **더미 시드 데이터**: 현재 SQLite 데이터(물건 809건, 변경 이력 4,008건, 분석 12건 등)를 내보내 시드로 만든다. 사건 비고와 분석 본문 속 개인 이름은 가린다. 시드는 개발·시연용 프로필에서만 적재한다.
- **읽기 API 이식**: 기존 Next.js API와 같은 경로·파라미터·응답 형태로 다음을 제공한다. `GET /api/items`, `GET /api/items/{id}`, `GET /api/items/{id}/changes`, `GET /api/items/usage-types`, `GET /api/health`.
- **Docker 구성**: `docker compose`로 MySQL과 Spring 백엔드를 함께 띄운다. 헬스체크와 데이터 볼륨을 갖춘다.
- **CI**: Spring 백엔드 빌드·테스트(Testcontainers MySQL) 잡을 추가한다.

이 change에서 하지 않는 것(후속 change로 분리):
- 쓰기 API(`POST /api/analyses`, 관심 물건, 피드 읽음, 워커 회차 기록) 이식과 analyzer 연결
- Next.js 화면이 Spring API를 쓰도록 전환
- 수집기·사진 워커의 Spring 이식과 수집 범위 확대

기존 Next.js 앱과 SQLite 운영 경로는 이 change에서 바뀌지 않는다. 두 DB는 서로 쓰지 않으며, MySQL은 시드 데이터만 가진다.

## Capabilities

### New Capabilities
- `spring-backend`: Spring Boot 백엔드의 런타임 구성, MySQL 스키마 관리(Flyway), 더미 시드 데이터 적재와 개인정보 가림, 기존 읽기 API와의 계약 호환, Docker 기반 실행

### Modified Capabilities
<!-- 기존 capability의 요구사항 변경 없음. 기존 Next.js/SQLite 경로는 그대로 유지된다. -->

## Impact

- **신규 코드**: `backend/` (Gradle 프로젝트, 엔티티 8개, 읽기 API 컨트롤러, QueryDSL 검색 저장소, Flyway 마이그레이션, 시드 SQL)
- **신규 스크립트**: SQLite → MySQL 시드 내보내기 스크립트(`scripts/`), 개인 이름 가림 처리 포함
- **배포 설정**: `docker-compose.yml`에 `mysql`, `backend` 서비스 추가. 기존 `web`, `collector`, `analyzer` 서비스는 그대로
- **CI**: `.github/workflows/ci.yml`에 JDK 21 + Gradle 잡 추가
- **게이트**: 기존 `tsc`, `npm test`, `npm run build`, `npm run lint`에 `./gradlew check`가 더해진다. 기존 TS 테스트 766개는 그대로 유지된다
- **문서**: `CLAUDE.md` 게이트 목록, README 실행 방법과 아키텍처
