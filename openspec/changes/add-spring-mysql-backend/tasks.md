## 1. 백엔드 골격과 버전 확인

- [ ] 1.1 `backend/`에 Gradle Wrapper(Kotlin DSL), Java 21, Spring Boot 4.x 프로젝트를 만들고 `./gradlew build`가 통과하는지 확인한다
- [ ] 1.2 QueryDSL 포크(`io.github.openfeign.querydsl`) APT를 설정하고, 임시 엔티티 하나로 Q클래스 생성과 조회 쿼리 실행이 되는지 확인한다. 실패하면 Spring Boot 3.5.x로 고정하고 그 결정을 design.md D1에 기록한다
- [ ] 1.3 프로필(`local`, `seed`, `test`)과 MySQL 접속 설정을 환경 변수 기반으로 구성하고, 시간대를 UTC로 고정한다. `local` 프로필로 로컬 MySQL에 접속해 기동되는지 확인한다

## 2. MySQL 스키마 (Flyway)

- [ ] 2.1 `db/migration/V1__baseline.sql`에 테이블 8개를 design.md D3의 타입 매핑대로 작성한다(고유 제약, 외래 키 CASCADE, CHECK, 인덱스 6개 포함). 빈 MySQL에서 기동해 테이블과 `flyway_schema_history`가 생기는지 Testcontainers 테스트로 확인한다
- [ ] 2.2 적용된 마이그레이션 파일을 바꾸면 기동이 실패하는지(checksum 불일치) 테스트로 확인한다
- [ ] 2.3 같은 법원·사건번호·물건번호 중복 저장이 거부되는지, 물건 삭제 시 하위 행이 삭제되는지 테스트로 확인한다

## 3. 엔티티와 저장소

- [ ] 3.1 테이블 8개의 JPA 엔티티를 만든다. `Item`은 `@Embedded` 값 객체로 컬럼을 묶는다. `ddl-auto=validate`로 기동해 스키마와 엔티티가 일치하는지 확인한다
- [ ] 3.2 시각 컬럼(`DATETIME(3)` UTC)과 금액 컬럼(`BIGINT`) 매핑을 검증한다. 51,005,255,120원 저장·조회 테스트와, JVM 시간대를 바꿔도 같은 시각 문자열이 나오는 테스트를 추가한다
- [ ] 3.3 물건 단건, 최신 분석, 변경 이력, 용도 목록 조회를 Spring Data JPA로 구현하고 저장소 테스트로 확인한다

## 4. 시드 데이터

- [ ] 4.1 개인 이름 가림 함수를 `scripts/seed/`에 TS로 만들고 vitest 단위 테스트로 고정한다(이름 패턴 가림, 기관명 보존, 비고를 인용한 분석 본문 가림)
- [ ] 4.2 `scripts/seed/export-seed.ts`를 만든다. `data/auctionboss.db`를 읽어 가림 처리 후 MySQL `INSERT` SQL을 `backend/src/main/resources/db/seed/`에 쓰고, 바꾼 건수와 남은 의심 문구 보고서를 출력한다. 실행 결과 물건 809건, 변경 이력 4,008건, 분석 12건이 SQL에 들어갔는지 확인한다
- [ ] 4.3 보고서를 사람이 검토해 남은 실명이 없음을 확인한 뒤 시드 생성물을 커밋한다. 검토 결과(가림 건수, 예외)를 tasks 하단 메모에 남긴다
- [ ] 4.4 `seed` 프로필에서만 동작하고 `items`가 비어 있을 때만 시드를 적재하는 로더를 만든다. 첫 기동 적재, 재기동 시 중복 없음, `seed` 없는 프로필에서 0건을 테스트로 확인한다

## 5. 읽기 API

- [ ] 5.1 공통 JSON 설정(밀리초 3자리 `Z` 시각 직렬화, NULL 필드 출력 규칙)과 오류 응답(`{ error, details }`, 404 메시지)을 구현하고 단위 테스트로 확인한다
- [ ] 5.2 `src/lib/domain/item-query.ts`의 strict 파서 규칙을 Java 파서로 옮긴다. 원본 테스트(`src/lib/domain/__tests__/item-query.test.ts`)의 거절·허용 사례를 Java 테스트로 옮겨 같은 `field`가 나오는지 확인한다
- [ ] 5.3 QueryDSL로 목록 검색을 구현한다. 필터 전체, 정렬 5종(실수 나눗셈 캐스팅, NULL 뒤로, `id` 보조 정렬), LIKE 이스케이프, `lastChangedAt`·`bookmarked` 서브쿼리 식을 포함한다. 저장소 테스트로 각 필터와 정렬을 확인한다
- [ ] 5.4 재분석 대상 조회(`needsAnalysis`, `promptVersion`, 설정의 재분석 최소 간격, 오래된 분석 우선 정렬)를 구현한다. 고정 `Clock`으로 변경 있음·없음·간격 안·미분석 물건 사례를 테스트한다
- [ ] 5.5 `GET /api/items`, `GET /api/items/{id}`, `GET /api/items/{id}/changes`, `GET /api/items/usage-types` 컨트롤러를 만들고 MockMvc로 정상·400·404 응답을 확인한다
- [ ] 5.6 `GET /api/health`를 구현한다. DB 정상 시 200, DB 중단 시 503이 나오는지 Testcontainers 컨테이너를 멈춰 확인한다

## 6. 기존 API와의 계약 비교

- [ ] 6.1 `export-seed.ts`에 골든 생성 단계를 추가한다. 가림 처리된 같은 데이터로 임시 SQLite를 만들고, 기존 Next 라우트 핸들러를 직접 호출해 요청 목록(기본 목록, 정렬 5종 × 방향 2종, 주요 필터 조합, 페이지 경계, 상세·이력·용도, 400·404 사례)의 응답을 `backend/src/test/resources/contracts/`에 저장한다. 시각에 의존하는 요청은 제외한다
- [ ] 6.2 Spring 계약 테스트가 시드를 적재한 MySQL에 같은 요청을 보내 골든과 JSON을 엄격 비교한다(400은 `error`와 `details[].field`만). 모든 골든이 일치할 때까지 차이를 수정한다

## 7. Docker와 CI

- [ ] 7.1 `backend/Dockerfile` 멀티 스테이지 이미지를 만들고 `docker build`가 성공하는지 확인한다
- [ ] 7.2 `docker-compose.yml`에 `mysql`(볼륨, 헬스체크)과 `backend`(헬스체크, `depends_on: service_healthy`, `config/collector.json` 읽기 전용 마운트, `.env` 주입) 서비스를 추가하고 `.env.example`을 커밋한다. 빈 상태에서 `docker compose up mysql backend`로 헬스체크 200과 시드 목록 응답을 확인한다
- [ ] 7.3 컨테이너를 내렸다 다시 올려 데이터가 유지되고 시드가 중복 적재되지 않는지 확인한다
- [ ] 7.4 `.github/workflows/ci.yml`에 `backend` 잡(Temurin 21, Gradle 캐시, `./gradlew check`)을 추가하고 GitHub Actions에서 통과하는지 확인한다

## 8. 마무리

- [ ] 8.1 기존 게이트(`npx tsc --noEmit`, `npm test`, `npm run build`, `npm run lint`)와 `./gradlew check`가 모두 통과하는지 확인한다. 기존 TS 테스트 766개가 그대로이고 가림 함수 테스트만큼 늘었는지 확인한다
- [ ] 8.2 목록 조회 1회에 실행되는 SQL 문 수를 세는 테스트를 추가해 N+1이 없음을 확인한다(기준: 목록 1개 + 전체 건수 1개)
- [ ] 8.3 전후 수치를 `docs/DEVELOPMENT_NOTES.md`에 기록한다: 계약 테스트 개수, 골든 불일치 건수와 원인, 목록 쿼리 `EXPLAIN` 결과, 시드 데이터 기준 목록 API 응답 시간
- [ ] 8.4 `CLAUDE.md` 게이트 목록, README 아키텍처와 실행 방법(수집 법원 수 문구를 실제 데이터 기준으로 정정), `docs/REFERENCE.md`에 백엔드 구성을 반영한다
- [ ] 8.5 `regression-verifier` 서브에이전트로 회귀 검증을 받은 뒤 커밋한다
