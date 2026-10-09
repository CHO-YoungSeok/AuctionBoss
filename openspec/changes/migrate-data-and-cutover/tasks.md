## 1. 시작 기준과 운영 데이터 실측

- [ ] 1.1 시작 기준을 확인한다. `port-collector-to-spring`이 아카이브됐는지(메인 스펙 `spring-backend`에 "수집 스케줄러 기본 꺼짐과 외부 요청 차단"이 있는지) 보고, 게이트 5종(`npx tsc --noEmit`, `npm test`, `npm run build`, `npm run lint`, `cd backend && ./gradlew check`)이 통과하는지, TS·Java 테스트 수와 change 시작 커밋 해시를 이 파일 하단 메모에 남긴다(7.6의 `workers/analyzer.ts`·`workers/lib/`·`workers/prompts/` 무변경 확인 기준)
- [ ] 1.2 이전 원본을 정한다: `data/auctionboss.db`와 compose 볼륨 `auctionboss_auctionboss-data`의 DB를 읽기 전용으로 열어 테이블별 행 수·최대 id·마지막 회차 시각만 비교하고(값 출력 금지), design.md "결정 기록" 1(`data/auctionboss.db`)과 맞는지 확인해 메모에 남긴다. 볼륨 쪽이면 런북(D10 3)의 복사 명령을 확정한다
- [ ] 1.3 운영 원본으로 design.md의 전제를 실측해 메모에 남긴다(값 출력 금지, 건수·길이·형식 판정만): (a) 테이블별 행 수·최대 id·`sqlite_sequence`, (b) MySQL `VARCHAR` 컬럼마다 원본 최대 문자 길이와 정의 길이(초과 건수), (c) 시각 컬럼 9개의 형식 분포(`toMysqlDatetime` 통과 여부), 날짜 2개, 정수 컬럼의 비정수 값 건수, (d) `worker_runs.detail` JSON 유효성과 실수 값 포함 여부, (e) 자연 키를 `utf8mb4_0900_ai_ci` UNIQUE로 넣었을 때 충돌 건수(임시 MySQL 컨테이너), (f) 사진 기록 수·파일 수·고아 파일 수·총 바이트, (g) 워커별 회차 결과 비율(롤백 창 기준 D11). 하나라도 전제와 다르면(특히 (b) 초과나 (e) 충돌) design.md를 고치거나 사용자에게 스키마 변경 여부를 묻고 멈춘다
- [ ] 1.4 롤백 창 기준을 design.md "결정 기록" 2(회차 기준)로 확정하고, 1.3 (g) 실측 주기로 72시간 기준이면 몇 회차였는지 계산해 차이를 메모에 남긴다

## 2. 내보내기 도구(TS)

- [ ] 2.1 `export-seed.ts`의 컬럼 종류 판정과 테이블 순서를 `scripts/seed/columns.ts`로 옮겨 시드 내보내기와 함께 쓴다. 기존 시드 생성 결과가 바이트 단위로 같은지(임시 디렉터리에 다시 생성해 커밋된 `db/seed/*.sql`과 비교) 확인한다
- [ ] 2.2 `scripts/migrate/normalize.ts`(D4 행 정규화·테이블 해시, 순수 함수)를 만든다. vitest `normalize.test.ts`: 밀리초 없는 시각·`+09:00` 시각이 같은 순간의 `.SSSZ`로, 키 순서·공백이 다른 JSON이 같은 문자열로, 큰 정수(1천억 이상)가 정확한 10진 문자열로, 뒤쪽 공백·이모지·백슬래시가 그대로, `collector_state` 키가 바이트 순으로 정렬되는지. 변이 확인: JSON 키 정렬을 빼면 "키 순서" 사례가, 문자열 `trim`을 넣으면 "뒤쪽 공백" 사례가 실패한다
- [ ] 2.3 `scripts/migrate/export.ts`를 만든다(D2·D3·D8): 백업 API 스냅숏, 사전 조건(쓰기 중 아님, 최근 회차 `running` 아님, 컬럼 집합), id 포함 INSERT, 매니페스트, 참조 사진만 복사·해시, 고아 건수, 출력 위치 `data/migration/<시각>/`만 허용. vitest `export.test.ts`(임시 SQLite 합성 픽스처): (a) 빈 번호 id와 `sqlite_sequence > max(id)`가 매니페스트에 그대로, (b) 생성 SQL을 `seed-to-sqlite`의 파서로 되읽은 행이 원본과 같음, (c) 최근 회차가 `running`이면 거부, (d) `data/migration/` 밖 출력 경로 거부, (e) 형식이 다른 시각 행이 있으면 테이블·id·컬럼 이름으로 실패하고 값은 출력에 없음(D14 표식 문자열 검사), (f) 고아 사진 파일은 복사되지 않고 건수 1, (g) 두 번 실행한 SQL·매니페스트(시각 필드 제외)가 바이트 단위로 같음. 변이 확인: id 컬럼을 빼면 (a)(b)가, 경로 검사를 빼면 (d)가 실패한다
- [ ] 2.4 교차 언어 골든을 만든다(D4): `scripts/migrate/fixtures/`의 합성 SQLite 생성기와 `generate-migration-golden.ts`가 `backend/src/test/resources/migration/{sql/*.sql, manifest.json, photos/**}`를 쓴다. 합성값만 쓰는지(실명 없음) `masking.ts`의 이름 추출이 0건인지 vitest로 확인하고, 두 번 생성해 바이트 단위로 같은지 확인한다

## 3. 가져오기·검증(Spring 1회 실행)

- [ ] 3.1 `com.auctionboss.migration`에 Java 정규화·해시(`RowNormalizer`, `TableDigest`)를 만든다. 단위 테스트 `RowNormalizerTest`는 2.2와 같은 사례를 같은 기대 문자열로 둔다. `MigrationGoldenDigestTest`(Testcontainers MySQL)는 2.4 골든 SQL을 적재한 뒤 계산한 테이블 해시가 `manifest.json`과 모두 같은지 확인한다. 변이 확인: 시각을 초 단위로 자르면 골든 해시 테스트가 실패한다
- [ ] 3.2 `ImportRunner`(`auctionboss.run-once=import`)를 만든다(D5 순서: Flyway 최신 확인 → 컬럼 집합 → `GET_LOCK` 두 개 → 트랜잭션 → 비어 있음/교체 → SQL 실행 → 해시 대조 → 사진 → 표식 → 커밋 → `AUTO_INCREMENT`). `ImportRunnerIT`(Testcontainers): (a) 빈 대상에 골든 적재 성공·종료 코드 0·해시 일치, (b) 시드가 있는 대상에 교체 없이 실행하면 거부되고 행 수 그대로, (c) 교체로 두 번 실행해 같은 해시(멱등), (d) SQL 한 행을 제약 위반으로 바꾼 픽스처에서 실패하고 8개 테이블이 이전 전 상태, (e) 적재 뒤 MySQL 한 값을 바꾸는 훅으로 해시 불일치 → 실패·롤백, 출력에 id·컬럼 이름만 있고 값이 없음, (f) 드라이런 뒤 8개 테이블이 비어 있고 표식도 없음, (g) 커밋 뒤 새 물건 id가 `sqliteSeq + 1` 이상(spec "이전 뒤 새 행"), (h) 수집 잠금을 다른 연결이 잡고 있으면 중단. 변이 확인: `DELETE`를 `TRUNCATE`로 바꾸면 (d)가, `AUTO_INCREMENT` 설정을 빼면 (g)가 실패한다
- [ ] 3.3 사진 복사·대조(D8)를 더한다. `ImportPhotosIT`: 골든 사진이 사진 디렉터리의 같은 상대 경로에 같은 해시로 생기고 `GET /api/photos/{itemId}/{seq}`로 같은 바이트, 해시가 다른 원본 파일이면 실패·롤백(사진 디렉터리에 새 파일 없음), 경계 밖 경로(`../`)는 거부, 드라이런은 사진 디렉터리를 바꾸지 않음
- [ ] 3.4 이전 완료 표식과 기동 조건(D7)을 만든다. `MigrationGuardIT`: `prod` 프로필 + 수집 켬 + 표식 없음 → 컨텍스트 시작 실패와 로그 문구, 표식 있음 → 기동하고 스케줄러 빈 존재, `local`·`test` 프로필은 표식 없이도 기동, 표식 키가 로테이션 조회 API·백오프 판정에 영향 없음, 해시 대조에서 표식 키 제외. 변이 확인: 프로필 조건을 빼면 `local` 사례가 실패한다
- [ ] 3.5 `export-state`·`delta-report` 1회 실행 모드(D11)를 만든다. `ExportStateIT`: 백오프·로테이션 JSON 출력(키 없음 → `null`), `DeltaReportIT`: 기준 시각 이후 행만 테이블별 건수로 세고 출력에 값이 없음
- [ ] 3.6 `application-prod.yml`(D9: 기본값 없는 접속 정보, 시드 없음)을 만든다. `ProdProfileIT`: 비밀번호 환경 변수 없이 `prod` 프로필 기동 실패, 시드 로더 빈 없음

## 4. 비교·롤백 도구(TS)

- [ ] 4.1 `scripts/migrate/compare-api.ts`(D6)를 만든다: 요청 목록 = `generate-contracts.ts` 목록(시각 의존 제외) + 원본 모든 물건의 상세·변경 이력·분석 이력·사진 목록. 원본 쪽은 Next 핸들러 직접 호출(`AUCTIONBOSS_DB`=백업), 대상 쪽은 Spring HTTP. 출력은 요청 수·불일치 수·불일치 요청 이름과 JSON 경로만. vitest: 시드 SQLite와 "같은 응답을 내는 가짜 Spring"으로 불일치 0, 한 필드를 바꾼 가짜로 불일치 1과 경로, 출력에 값 없음(D14 표식). 변이 확인: 비교에서 배열 순서를 무시하게 바꾸면 순서 바꾼 사례가 실패한다
- [ ] 4.2 `scripts/dev/compare-screens.sh`에 원천 지정 환경 변수(`SQLITE_DB`, `SPRING_BASE`, `SKIP_SEED`, `SKIP_FORMS`)를 더한다. 변수 없이 돌린 결과가 3단계와 같은지(차이 0건) 확인한다
- [ ] 4.3 `scripts/migrate/rollback-state.ts`(D11)를 만든다: `export-state` JSON을 받아 SQLite에 백오프(늦을 때만)와 로테이션을 쓴다. vitest: MySQL 백오프가 늦으면 씀, 이르면 SQLite 값 유지, 없으면 그대로, 로테이션은 항상 덮어씀, 쓴 뒤 TS 수집기의 백오프 판정(`collector-state.ts`)이 "건너뜀"을 돌려줌. 변이 확인: 비교를 빼고 항상 쓰게 하면 "이르면 유지"가 실패한다

## 5. 배포 구성 전환

- [ ] 5.1 `backend/Dockerfile`에 `/app/photos`(소유자 `app`)를 만든다. `docker build` 뒤 `docker run --rm <이미지> stat -c %u /app/photos`가 10001인지 확인한다
- [ ] 5.2 데이터 포트에 `health()`를 더하고 `/api/health`가 원천에 묻게 한다(D9). vitest: Spring 원천에서 백엔드 200 → 200·`connected`, 503·연결 실패·시간 초과 → 503·`disconnected`, 오류 문자열에 주소의 비밀 쿼리 없음, Spring 원천에서 `getDb`를 던지게 바꿔도 통과(SQLite를 열지 않음). SQLite 원천 기존 테스트는 그대로 통과
- [ ] 5.3 `docker-compose.smoke.yml`(독립 프로젝트 이름, `local,seed`, 세 설정 없음)을 만들고 `scripts/docker-smoke.sh`가 그 파일과 `-p auctionboss-smoke`만 쓰게 바꾼다. 스모크를 1회 돌려 809건·재기동 유지를 확인하고, 실행 전후 운영 볼륨(`docker volume inspect` 생성 시각)이 그대로인지 확인한다
- [ ] 5.4 `docker-compose.yml`을 운영 구성으로 바꾼다(D9: `collector`·`photos` 삭제, `backend` 운영 프로필·세 설정 켬·사진 볼륨, `web` spring 원천·백엔드 헬스 의존·볼륨 삭제, `analyzer` → 백엔드, DB 변수 `:?`, SQLite 볼륨 선언 유지). `.env.example`에 키만 맞춘다. `.env` 없이 `docker compose config`가 DB 변수 이름을 알리며 실패하고, `ANTHROPIC_API_KEY`만 없을 때는 해석되는지 확인한다(값 출력 금지)
- [ ] 5.5 K8s 매니페스트를 바꾼다(D9: 웹 단일 컨테이너·볼륨 없음·프로브, `deployment-backend.yaml`·`service-backend.yaml`·`statefulset-mysql.yaml`, Secret 키 이름만, 분석 워커 → 백엔드, configmap에서 `AUCTIONBOSS_DB` 삭제, `kustomization.yaml`). `kubectl kustomize k8s/`가 있으면 통과를 확인하고 없으면 메모한다. `deploy/k8s/README.md`를 새 구조로 고친다
- [ ] 5.6 `src/__tests__/deploy-config.test.ts`를 D9대로 반전한다: 묶음 "운영 구성에서만 수집·사진 켬"(compose `backend`·K8s 백엔드는 세 설정 참, 스모크·리허설 구성은 외부 요청 허용 거짓, 배포 파일에 `run-once` 없음, TS `collector`·`photos` 서비스·컨테이너·`npm run collector|photos` 없음), "웹은 spring 원천"(compose·K8s 웹의 `AUCTIONBOSS_DATA_SOURCE=spring`, `AUCTIONBOSS_SPRING_BASE`가 백엔드 서비스, 웹에 데이터 볼륨·`AUCTIONBOSS_DB` 없음), "분석 워커 → 백엔드"(compose·K8s), "비밀"(배포 파일에 비밀번호 리터럴 없음, `secret.yaml` `data` 값 없음, DB 변수 `:?`), "스모크 격리"(`docker-smoke.sh`에 `-p auctionboss-smoke`, `docker-compose.smoke.yml`만 사용), "백엔드 단일 인스턴스"(K8s `replicas: 1`, `Recreate`). 변이 확인: compose `backend`에서 `AUCTIONBOSS_SOURCE_EXTERNAL_REQUESTS_ALLOWED`를 빼면, 웹을 `sqlite`로 되돌리면, `collector` 서비스를 되살리면, 스모크 스크립트에서 `-p`를 빼면 각각 실패한다. 줄어든·바뀐 단언 목록을 메모에 남긴다
- [ ] 5.7 `docs/REFERENCE.md`에 "운영 전환 런북"(D10 1~8, 전환 직전 구성 커밋 해시 자리, 시각 기록 칸)과 "롤백 런북"(D11)을 쓰고, 1회 실행 모드 `import`·`export-state`·`delta-report`와 설정(`auctionboss.import.*`)을 표에 더한다. README의 `docker compose up` 안내에 "이전 완료 표식이 없으면 백엔드가 뜨지 않는다"를 적는다

## 6. 리허설(개발 환경, 운영 복사본, 실제 사이트 0요청)

- [ ] 6.1 `scripts/dev/rehearsal.override.yml`(D13: 외부 요청 허용 거짓, 소스 주소 루프백, 주기 1분, 가짜 소스 사이드카 `network_mode: "service:backend"`)과 `scripts/dev/rehearse-cutover.sh`(별도 프로젝트·볼륨·포트, 운영 원본의 백업 복사본, 각 단계 시각 기록, 값 출력 금지)를 만든다. deploy-config 테스트에 리허설 덮어쓰기의 외부 요청 허용이 거짓인지 단언을 더한다
- [ ] 6.2 리허설 1회차: 런북 D10 2~8을 그대로 돈다. 확인: 가져오기 드라이런·본 실행 해시 8/8 일치, 사진 대조, `compare-api` 불일치 0, `compare-screens`(SKIP_FORMS) 차이 0, 백엔드 첫 수집·사진 회차가 가짜 소스로만 요청(백엔드 로그의 요청 대상 호스트가 루프백뿐), 이전된 백오프·로테이션이 이어짐, 분석 워커(가짜 Claude CLI) 1회 성공. 시간(내보내기, 가져오기, 비교, 전체 다운타임 T2−T0, 수집 공백)을 메모에 남긴다
- [ ] 6.3 리허설 2회차: 같은 백업으로 `replace` 재실행 → 해시가 1회차와 같은지(멱등), 표식 시각만 갱신되는지 확인한다. 이전 전 상태에서 운영 구성으로 띄우면 백엔드가 기동을 거부하는지(D7)도 이 환경에서 확인한다
- [ ] 6.4 롤백 리허설(D11): 리허설 환경에서 가짜 소스로 차단 응답을 1회 받게 해 MySQL 백오프를 만든 뒤 → 스케줄러 끔 → `delta-report` → `export-state` → `rollback-state` → 전환 직전 커밋의 compose로 TS 경로 기동(소스는 가짜 서버, 기동·화면·백오프 판정만 확인). 확인: SQLite 백오프가 MySQL 값으로 늘어남, TS 수집기 첫 틱이 백오프 건너뜀, 화면이 복사본 데이터로 뜸. 롤백 소요 시간을 메모에 남긴다
- [ ] 6.5 리허설 산출물(`data/migration/` 리허설 디렉터리, `docs/untracked/` HTML, 리허설 볼륨)을 지우고 지웠음을 메모에 남긴다. 리허설에서 고친 런북 문구를 5.7 문서에 반영한다

## 7. 운영 전환 실행(사람 확인)

- [ ] 7.1 **사람 확인 관문**: 6장 수치와 런북을 사용자에게 보여 주고 전환 일시와 원본(1.2)을 확인받는다. 확인 전에는 7.2 이후를 진행하지 않는다
- [ ] 7.2 사전 확인(D10 1): 게이트 5종, `docker compose config` 해석, SQLite 백오프 과거, TS 마지막 수집 회차 종료 시각 기록, 전환 직전 구성 커밋 해시를 런북에 기록
- [ ] 7.3 쓰기 정지(T0)와 백업·내보내기(D10 2~3). 매니페스트의 테이블별 행 수가 1.3 실측 이상인지 확인한다
- [ ] 7.4 가져오기 드라이런 → 본 실행 → 검증(D10 4~6). 해시 8/8, 사진 대조, `compare-api` 불일치 0, `compare-screens` 차이 0이 아니면 7.5로 가지 않고 롤백 런북을 따른다
- [ ] 7.5 켬(T1)과 확인(T2, D10 7~8): 백엔드 첫 수집 틱이 TS 마지막 회차 + 주기 이후인지, 첫 수집·사진 회차 결과(결과 종류, 요청 페이지 수, 신규·갱신·변경 건수), 분석 워커 첫 회차 결과, 웹 헬스·화면 5개 200을 확인한다
- [ ] 7.6 분석 워커 무수정 확인: `git diff --stat <1.1 시작 커밋> -- workers/analyzer.ts workers/lib/ workers/prompts/`가 비어 있음을 메모에 남긴다
- [ ] 7.7 수치를 메모에 남긴다(값·실명 없이): 내보내기·가져오기 시간, 테이블별 행 수와 해시 일치, 사진 수·바이트, API 비교 요청 수·불일치, 다운타임(T2−T0), 수집 공백, 첫 회차 결과. `data/migration/<시각>/`(백업 포함)은 롤백 창 동안 지우지 않는다

## 8. 롤백 창 관찰과 은퇴(사람 확인 뒤)

- [ ] 8.1 **사람 확인 관문**: 롤백 창(1.4 확정 기준)이 끝났는지 MySQL 회차 기록 집계로 보여 주고, 은퇴 진행을 사용자에게 확인받는다. 창 안에서 롤백했다면 그 기록(델타 건수, 원인)을 메모에 남기고 7장으로 돌아간다
- [ ] 8.2 렌더·포트 테스트를 메모리 `DataPort`로 옮긴다(D12). 기존 기대값은 그대로 두고 데이터 주입 방식만 바꾼다. 옮긴 뒤 SQLite로 돌던 렌더 테스트와 같은 개수가 통과하는지 확인한다
- [ ] 8.3 지울 TS 테스트 묶음마다 같은 동작을 덮는 Java 테스트를 짝지어 표로 만든다(저장소 쿼리 ↔ `ContractTest`·통합 테스트, 수집기·사진 워커 ↔ 저장 골든, 어댑터 ↔ 어댑터 골든, JSON 라우트 ↔ 계약·시나리오 골든). 짝이 없는 동작이 있으면 Java 테스트를 먼저 더한다
- [ ] 8.4 은퇴 대상을 지운다(D12 목록: SQLite 포트·`src/lib/db/**`·TS 수집·사진 워커·TS 어댑터·Next JSON 라우트 17개·SQLite 의존 생성기·`scripts/migrate/`). 원천 선택은 `spring`만, `sqlite`는 은퇴 오류로 바꾸고 vitest로 확인한다(`sqlite` → 은퇴 문구, 알 수 없는 값 → 허용 값 `spring`, 주소 없음 → 주소 필요, 어느 경우도 파일을 만들지 않음). 남은 라우트 4개(`health`, `bookmarks/toggle`, `feed/mark-read`, `photos/[itemId]/[seq]`) 테스트가 통과하는지, `grep -rn "better-sqlite3\|@/lib/db" src workers scripts`가 비었는지 확인한다
- [ ] 8.5 `better-sqlite3` 의존성, Dockerfile 네이티브 빌드 도구와 `/app/data` 볼륨, CI `build-essential` 단계, compose·K8s의 SQLite 볼륨·PVC 선언을 지운다. Next 이미지 크기 전후를 메모에 남기고, deploy-config 테스트에 "SQLite 볼륨·PVC·`AUCTIONBOSS_DB` 없음" 단언을 더한다
- [ ] 8.6 린트 경계를 다시 쓴다(D12 규칙 3개). `src/__tests__/lint-boundary.test.ts`가 ESLint API로 가상 파일을 검사한다: 화면에서 `better-sqlite3` 가져오기 실패, 테스트 파일에서도 실패(예외 없음), `workers/`에서 `@/lib/data-port`·`next/server` 실패, `src/app/`에서 `@/lib/data-port/spring/client` 실패, 데이터 포트 인터페이스 가져오기는 통과. 변이 확인: 규칙 하나를 지우면 해당 사례가 실패한다
- [ ] 8.7 계약 골든 동결을 확인한다: 은퇴 전후 `git diff --stat -- backend/src/test/resources/`가 비어 있고, Java 계약·시나리오·어댑터·저장·이전 골든 테스트 수가 은퇴 전과 같은지 메모에 남긴다

## 9. 마무리

- [ ] 9.1 게이트 5종을 모두 통과시킨다. TS 테스트 수 변화(8.3 표의 묶음별 감소 이유)와 Java 테스트 수 변화를 메모에 남긴다. `git diff --stat <1.1 시작 커밋> -- workers/analyzer.ts workers/lib/ workers/prompts/`가 비어 있는지 다시 확인한다
- [ ] 9.2 실명 검사(D14): `git ls-files` 전체에서 원본 비고로 추출한 이름 목록(메모리에서만)이 나타나지 않는지 확인하고 건수(0)만 메모에 남긴다. `data/migration/`·`docs/untracked/`가 git에 없음을 확인한다
- [ ] 9.3 `docs/DEVELOPMENT_NOTES.md` 17절에 수치를 남긴다: 1.3 실측(건수만), 6장 리허설 시간·멱등·롤백 시간, 7장 전환 수치(이전 시간, 행 수, 해시 일치, 다운타임, 수집 공백, 첫 회차 결과), 롤백 창 집계, 은퇴 전후 테스트 수·이미지 크기
- [ ] 9.4 `docs/ROADMAP.md`를 갱신한다: 5단계 상태·완료 기준 해석("테이블별 행 수와 표본 값 일치"를 전수 해시와 API 전수 비교로, "수집 공백 시간"을 7.7 값으로), "지금 상태"의 구조 설명과 목표 구조 도달, 6단계 할 일(상시 환경, `mysqldump` 백업과 복구, 이전 백업의 보관 결정)
- [ ] 9.5 `regression-verifier` 서브에이전트로 회귀 검증을 받고 지적 사항을 반영한다(특히 "운영 구성이 실수로 SQLite나 TS 수집기로 돌아갈 때 잡는 테스트", "이전 전 기동 거부", "스모크가 운영 볼륨을 지우는 경로")
- [ ] 9.6 커밋하고 푸시한 뒤 GitHub Actions의 TS 잡과 Java 잡이 통과하는지 확인한다(장마다 커밋·푸시는 따로 한다)
- [ ] 9.7 `openspec validate migrate-data-and-cutover --strict`를 통과시킨 뒤 change를 아카이브하고(`port-collector-to-spring` 아카이브 뒤), 메인 스펙 `spring-backend`·`web-data-port`·`deployment-and-health`에 반영됐는지 확인한다. `web-data-port`·`deployment-and-health`의 Purpose 문장을 SQLite 은퇴에 맞게 메인 스펙에서 직접 고친다
