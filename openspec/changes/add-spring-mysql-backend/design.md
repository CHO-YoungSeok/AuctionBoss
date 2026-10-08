## Context

- 동기와 범위는 proposal.md, 지켜야 할 동작은 `specs/spring-backend/spec.md`를 따른다.
- 현재 백엔드는 Next.js API 라우트가 `src/lib/db/repository.ts`(better-sqlite3, 동기)를 직접 호출한다. 스키마는 `src/lib/db/schema.ts`의 `CREATE TABLE IF NOT EXISTS`와 `src/lib/db/client.ts`의 `ALTER TABLE ... ADD COLUMN` 보정 4개로 관리된다.
- 데이터: 물건 809건(서울중앙지방법원 1곳), 변경 이력 4,008건, 분석 12건, 워커 회차 7건, 수집 상태 1건. 관심·피드·사진은 0건이다. 사건 비고 15건에 개인 이름이 있고, 분석 본문 1건이 그 비고를 인용한다(처음 느슨한 검색으로는 45건이 잡혔지만, 가림 규칙으로 확인한 실제 이름은 15건이다).
- 시각은 ISO 문자열(`2026-09-08T11:48:38.617Z`), 매각기일과 매각결정기일은 `YYYY-MM-DD` 문자열, `worker_runs.detail`은 JSON 문자열로 저장되어 있다. 최대 감정가는 51,005,255,120원으로 32비트 정수 범위를 넘는다.
- 사용자가 정한 것: MySQL 8, JPA + QueryDSL, 스키마 1:1 이식, 같은 저장소의 `backend/`. 수집 확대는 하지 않고 기존 데이터를 더미로 쓴다.
- 지켜야 할 기존 원칙: 수집 소스는 `AuctionSource` 어댑터 뒤에 격리, analyzer는 HTTP API로만 통신. 이 change는 둘 다 건드리지 않는다.

## Goals / Non-Goals

**Goals:**
- Spring 백엔드가 기존 읽기 API 5개를 같은 JSON으로 돌려준다. 기존 API와 응답을 기계적으로 비교해 증명한다.
- MySQL 스키마를 Flyway로 재현 가능하게 만들고, `docker compose up` 한 번으로 시드 데이터까지 올라온다.
- 다음 change(쓰기 API, 프론트 전환)가 이 위에서 엔티티와 저장소를 그대로 쓸 수 있게 8개 테이블 전부를 엔티티로 매핑한다.

**Non-Goals:**
- 스키마 정규화. 테이블과 컬럼은 1:1로 옮기고, 코드 쪽 가독성은 JPA 값 객체로 해결한다.
- 쓰기 API, 인증, 화면 전환, 수집기 이식, 운영 배포(K8s) 변경.
- SQLite 운영 데이터를 MySQL로 계속 동기화하는 것. 시드는 한 시점의 스냅샷이다.

## Decisions

### D1. 프로젝트 구성: Java 21 + Spring Boot 4 + Gradle(Kotlin DSL), `backend/` 단일 모듈
- **선택**: Java 21 LTS, 착수 시점의 최신 안정 Spring Boot 4.x, Gradle Wrapper(Kotlin DSL). 로컬에 JDK 21과 Gradle이 이미 있다.
- **QueryDSL 호환성 확인을 첫 작업으로 둔다**: 원래 `com.querydsl`은 관리가 멈췄으므로 관리 중인 포크(`io.github.openfeign.querydsl`)를 쓴다. 첫 작업에서 Q클래스 생성과 쿼리 실행이 Boot 4(Hibernate 7)에서 되는지 확인하고, 안 되면 Spring Boot 3.5.x로 고정한다. 나머지 설계는 두 버전에서 같다.
- **대안**: Kotlin은 채용 범위가 좁고, Maven은 QueryDSL APT 설정이 더 장황하다. 멀티 모듈은 지금 규모에서 이득이 없다.

### D2. 패키지: 기능별 패키지 + 계층
```
com.auctionboss
├── item/        Item 엔티티, ItemController, ItemQueryService, ItemSearchRepository(QueryDSL), dto/
├── analysis/    Analysis 엔티티와 저장소 (상세 API의 최신 분석)
├── history/     ItemChange 엔티티와 저장소 (변경 이력 API)
├── bookmark/    Bookmark, FeedRead 엔티티 (목록의 bookmarked 표시·필터에 필요)
├── worker/      WorkerRun, CollectorState 엔티티 (이번에는 매핑만)
├── photo/       ItemPhoto 엔티티 (매핑만)
├── health/      HealthController
└── common/      JSON 직렬화, 오류 응답, 시간(Clock), 시드 로더, 설정
```
- 기능별로 묶어야 다음 change에서 쓰기 API를 같은 패키지에 더할 때 흩어지지 않는다.

### D3. 스키마 1:1 이식과 타입 매핑 (Flyway `V1__baseline.sql`)
| SQLite | MySQL | 이유 |
| --- | --- | --- |
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `BIGINT NOT NULL AUTO_INCREMENT` | id 보존. 시드가 명시 id로 넣어도 다음 값은 최대값 다음부터 이어진다 |
| 금액(`appraisal_price`, `min_bid_price`, `min_bid_price_round1~4`) | `BIGINT` | 510억 원 값이 INT 범위를 넘는다 |
| 그 밖의 정수(면적, 유찰횟수, 비율, 회차, 사진 수, `seq`, `items_changed`) | `INT` (`file_size`는 `BIGINT`) | |
| 시각(`*_at`) | `DATETIME(3)`, 항상 UTC로 저장 | `TIMESTAMP`는 2038년 한계와 세션 시간대 변환이 있다. JDBC와 Hibernate의 시간대를 UTC로 고정한다 |
| `auction_date`, `auction_decision_date` | `DATE` | 날짜만 의미가 있다 |
| 고유 제약에 쓰이는 문자열(`court`, `case_no`, `item_no`), 코드값, 짧은 문자열 | `VARCHAR(n)` | MySQL은 `TEXT`에 길이 없는 인덱스를 못 만든다. 길이는 현재 최대 길이의 여유분으로 정한다 |
| 긴 본문(`note`, `building_description`, `analyses.body`, `error_message`, 변경 전후 값) | `TEXT` | |
| `worker_runs.detail` | `JSON` | 응답에서 객체로 내보낸다 |
| `kind`, `outcome`, `photo_status` | `VARCHAR` + `CHECK (... IN ...)` | MySQL `ENUM`은 값 추가 때 테이블 변경이 필요하다. `CHECK`는 8.0.16부터 실제로 검사한다 |
| `feed_reads CHECK (id = 1)` | 그대로 | 단일 행 보장 |
| 외래 키 `ON DELETE CASCADE`, 고유 제약, 인덱스 6개 | 그대로 | `(item_id, analyzed_at DESC)` 같은 내림차순 인덱스도 MySQL 8에서 지원 |
- 문자셋은 `utf8mb4`, 정렬 규칙은 `utf8mb4_0900_ai_ci`. SQLite의 `LIKE`처럼 영문 대소문자를 구분하지 않는다. 비교 결과 차이는 D7의 계약 테스트가 잡는다.
- `client.ts`의 ALTER 보정 4개는 기준 스키마에 이미 반영된 최종 형태로 합친다.
- **엔티티**: 테이블은 1:1이지만 `Item`의 컬럼 50개 중 33개는 record `@Embeddable` 값 객체 7개(소재지, 매각 일정, 차수별 최저가, 용도 코드, 법원 연락처, 소스 식별자, 사진 상태)로 묶고, 식별·가격·상태 같은 핵심 17개는 `Item`에 직접 둔다. 테이블 구조를 바꾸지 않고 코드 가독성을 얻는다. 값 객체의 컬럼이 모두 NULL이면 Hibernate가 값 객체 자체를 null로 읽으므로 응답 변환에서 처리한다.
- `ddl-auto`는 `validate`로 둔다. 엔티티와 Flyway 스키마가 어긋나면 시작 시점에 실패한다.

### D4. 데이터 접근: JPA + QueryDSL, 목록 검색은 DTO 프로젝션
- 단건 조회와 이력은 Spring Data JPA, 목록 검색은 QueryDSL `JPAQueryFactory`로 동적 조건을 조립한다. 읽기 서비스는 `@Transactional(readOnly = true)`, OSIV는 끈다.
- 목록 행의 `lastChangedAt`과 `bookmarked`는 스칼라 서브쿼리 식으로 한 번에 가져온다. 행마다 추가 쿼리를 날리는 N+1을 만들지 않는다.
- **MySQL에서 결과가 달라질 수 있는 지점과 대응**
  - 비율 정렬(`bidRatio`, `pricePerArea`): MySQL의 정수 나눗셈은 소수 4자리 `DECIMAL`이라 SQLite의 실수 나눗셈과 순서가 달라질 수 있다. `cast(... as double)`로 실수 나눗셈을 강제한다.
  - NULL 정렬: SQLite는 `(expr) IS NULL, expr`로 NULL을 항상 뒤로 보낸다. MySQL에는 `NULLS LAST` 문법이 없어 Hibernate 렌더링에 기대지 않고, `CASE WHEN expr IS NULL THEN 1 ELSE 0 END ASC, expr <방향>, id ASC`를 QueryDSL로 명시한다.
  - "최신 분석" 서브쿼리: 원본은 `ORDER BY analyzed_at DESC, id DESC LIMIT 1`이다. JPQL 서브쿼리의 LIMIT 지원이 불확실하므로 `MAX` 서브쿼리 두 단계(최신 시각 → 그 시각의 최대 id)로 같은 행을 고른다. 재분석 대상 조회(`needsAnalysis`)가 이 식에 의존하며, 끝내 표현이 안 되면 이 쿼리 하나만 네이티브 SQL로 둔다.
  - 키워드 검색: `%`, `_`, `\`를 이스케이프하는 원본 규칙(`escapeLikePattern`)을 그대로 옮기고 `ESCAPE`를 명시한다.

### D5. 계약 호환: 응답 DTO와 JSON 형식을 기존 TS 타입에 맞춘다
- 응답 필드는 `src/lib/domain/types.ts`의 `AuctionItem`과 각 라우트의 응답 객체를 기준으로 한다. 엔티티를 그대로 직렬화하지 않고 응답 전용 record를 둔다.
- 시각은 항상 밀리초 3자리 `Z` 형식(`2026-09-08T11:48:38.617Z`)으로 직렬화한다. Java `Instant.toString()`은 밀리초가 0이면 자릿수를 생략하므로 전용 직렬화기를 둔다.
- 쿼리 파라미터 검증은 `src/lib/domain/item-query.ts`의 `parseItemQuery`(strict) 규칙을 Java로 옮긴 파서 하나에 둔다. 교차 검증(가격 하한 ≤ 상한, 억·만원 조합)이 있어 Bean Validation 애너테이션만으로는 표현할 수 없다. 오류는 `@RestControllerAdvice`가 `{ error, details: [{ field, message }] }`로 만든다.
- 재분석 최소 간격은 원본처럼 서버 설정에서만 읽는다. 단일 원천을 위해 `config/collector.json`을 그대로 읽고(경로는 설정으로 지정), compose에서는 읽기 전용으로 마운트한다.
- "지금" 시각이 필요한 곳(지난 기일 제외, 재분석 간격)은 주입된 `Clock`을 쓴다. 테스트에서 시각을 고정하기 위해서다.

### D6. 시드: 내보내기 스크립트 + 가림 처리 + 프로필 기반 적재
- **내보내기**: `scripts/seed/export-seed.ts`(TS, 기존 better-sqlite3 사용)가 `data/auctionboss.db`를 읽어 가림 처리 후 MySQL용 `INSERT` SQL을 `backend/src/main/resources/db/seed/`에 쓴다. 생성물은 저장소에 커밋해서, 클론만 하면 누구나 같은 데이터로 띄울 수 있게 한다.
- **가림 처리**: 비고에서 개인 이름 후보를 패턴(예: `<이름>의 임차보증금`, `임차인 <이름>`, `채무자 <이름>`, `소유자 <이름>`)으로 뽑고, 기관명 허용 목록(주택도시보증공사, 은행·공사·공단 등)을 제외한다. 뽑힌 이름은 비고와 분석 본문 전체에서 `○○○`로 바꾼다. 스크립트는 바꾼 건수와 남은 의심 문구를 보고서로 출력하고, 사람이 한 번 검토한 뒤 커밋한다. 가림 함수는 vitest 단위 테스트로 고정한다.
- **적재**: Flyway 버전에 섞지 않는다. 시드를 V 마이그레이션으로 넣으면 이후 스키마 마이그레이션과 버전 순서가 꼬인다. 대신 `seed` 프로필에서만 켜지는 시드 로더가 `items`가 비어 있을 때만 시드 SQL을 실행한다. 재기동해도 중복 적재되지 않고, 운영 프로필에는 로더 자체가 없다.

### D7. 테스트: Testcontainers + 기존 API와의 골든 비교
- **골든 생성**: 별도 스크립트 `scripts/seed/generate-contracts.ts`가 원본 SQLite를 `VACUUM INTO`로 스냅샷하고, 시드와 같은 가림 함수로 note와 body를 가린 뒤, 기존 Next 라우트 핸들러를 직접 호출해 정해진 요청 목록의 응답을 `backend/src/test/resources/contracts/*.json`으로 저장한다. 처음에는 시드 내보내기 스크립트에 단계를 더할 계획이었지만, 요청 목록 관리와 핸들러 호출은 책임이 달라 파일을 나눴다. 가림 함수는 같은 모듈을 import해 규칙이 갈라지지 않는다. 기존 라우트 테스트(`src/app/api/**/__tests__`)도 핸들러를 직접 호출하는 방식이라 같은 방법을 쓴다.
- **골든 비교**: Spring 테스트가 Testcontainers MySQL에 시드를 적재하고 같은 요청을 MockMvc로 보내 JSON을 엄격 비교한다. 400 응답은 `error`와 `details[].field`만 비교한다(메시지 문구는 비교하지 않음).
- **시각 의존 요청**(지난 기일 제외, 재분석 간격)은 골든에서 빼고, 고정 `Clock`을 쓰는 Spring 단위 테스트로 따로 검증한다. 원본 핸들러는 시각을 주입할 수 없어 골든이 날짜에 따라 흔들리기 때문이다.
- **저장소 테스트**: 작은 픽스처로 재분석 판정, LIKE 이스케이프, NULL 정렬, 큰 금액, 시간대 독립성을 검증한다.

### D8. Docker와 실행 프로필
- **이미지**: `backend/Dockerfile` 멀티 스테이지(Gradle JDK 21로 빌드 → JRE 21 런타임, 비루트 사용자).
- **compose**: 기존 `docker-compose.yml`에 `mysql`(`mysql:8.4`, 볼륨 `mysql-data`, `mysqladmin ping` 헬스체크)과 `backend`(포트 8080, `depends_on: condition: service_healthy`, `/api/health` 헬스체크, 프로필 `local,seed`)를 추가한다. 비밀번호 등은 `.env`로 주입하고 `.env.example`만 커밋한다.
- **로컬 개발**: `docker compose up -d mysql` 후 IDE나 `./gradlew bootRun`으로 백엔드를 띄운다.
- **프로필**: `local`(로컬 MySQL 접속), `seed`(시드 로더 켜기), `test`(Testcontainers). 운영 프로필은 다음 change에서 정한다.

### D9. CI와 게이트
- `.github/workflows/ci.yml`에 `backend` 잡(Temurin 21, Gradle 캐시, `./gradlew check`)을 추가한다. GitHub 호스트 러너에서 Testcontainers가 동작한다.
- `CLAUDE.md` 게이트에 `cd backend && ./gradlew check`를 더한다. 기존 TS 테스트 수는 줄지 않고, 가림 함수 테스트만큼 늘어난다.

## Risks / Trade-offs

- [Spring Boot 4와 QueryDSL 포크 호환 문제] → 첫 작업에서 확인하고 실패하면 Boot 3.5.x로 고정한다(D1).
- [MySQL과 SQLite의 비교·정렬 규칙 차이로 응답이 미세하게 달라짐] → 정렬 5종 × 방향 2종 × 주요 필터 조합을 골든으로 비교한다. 차이가 나면 해당 식을 명시적으로 캐스팅하거나 정렬 규칙을 지정한다.
- [가림 처리 누락으로 실명이 공개 저장소에 올라감] → 패턴 추출 + 의심 문구 보고서 + 사람 검토 후 커밋. 커밋 전 검증 테스트가 알려진 이름 패턴이 시드에 남지 않았는지 확인한다.
- [시드가 원본과 달라 Next 화면과 Spring 응답이 다르게 보임] → 의도된 차이다. 골든은 가림 처리된 같은 데이터로 만들기 때문에 비교에는 영향이 없다.
- [재분석 최소 간격 설정을 두 프로세스가 읽음] → 같은 `config/collector.json` 파일을 읽어 원천을 하나로 유지한다.
- [두 백엔드가 공존하는 기간이 길어짐] → MySQL은 쓰기 경로가 없어 데이터 정합성 문제는 생기지 않는다. 다음 change에서 쓰기 API와 전환 시점을 정한다.

## Migration Plan

1. 이 change는 추가만 한다. 기존 Next 앱, 워커, SQLite, 기존 compose 서비스는 그대로다.
2. 배포 순서: `backend/`와 시드 생성물을 머지 → CI 통과 → 로컬에서 `docker compose up mysql backend`로 확인.
3. 롤백: `backend/` 디렉터리와 compose의 `mysql`, `backend` 서비스, CI 잡을 되돌리면 끝난다. 운영 데이터에 영향이 없다.
