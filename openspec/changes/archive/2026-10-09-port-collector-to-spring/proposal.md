## Why

1~3단계로 Spring이 읽기·쓰기 API와 화면용 API를 같은 계약으로 갖췄지만, 물건을 만드는 쪽인 수집 워커와 사진 워커는 아직 TypeScript 프로세스가 SQLite 파일을 직접 열어 쓴다. 이 두 워커가 남아 있는 한 5단계에서 SQLite를 은퇴시킬 수 없고, Spring은 "DB의 유일한 주인"이 되지 못한다.
수집 경로는 외부 사이트 차단 위험을 직접 다루는 곳이라, 옮긴 뒤에도 같은 요청을 같은 간격으로 보내고 같은 응답을 같은 저장 결과로 바꾼다는 것을 운영 전환(5단계) 전에 기계적으로 증명해 두어야 한다.

## What Changes

- **소스 어댑터 이식**: `AuctionSource` 계약과 법원경매정보 어댑터(`courtauction`)를 Java로 옮긴다. 세션 부트스트랩, 검색 페이지네이션(`totalCnt` 기준, 페이지 상한, 빈 페이지 조기 종료), 행 접기(일괄매각), 정규화 규칙, 응답 3단 차단 감지(WAF HTML → `ipcheck` → 형식 검증), 사진 조회(상세 응답 base64), 실패 시 실제 요청 수 보존, 페이지 간 대기, 고정 User-Agent를 그대로 재현한다.
- **수집 워커 이식**: 로테이션(법원 코드로 위치 보존), 회차당 법원 수·요청 수 상한(진행 중 법원은 끊지 않음), 공유 백오프(`collector_state.backoff_until`, 짧아지지 않음), 회차 기록(시작·종료·건너뜀), 차단 시 로테이션 위치 유지를 Spring 서비스로 옮긴다. 물건 저장과 변경 이력 기록은 한 트랜잭션, 회차 기록은 별도 트랜잭션이다.
- **사진 워커 이식**: 대기 물건 선택(미시도 우선, 실패는 재시도 간격 후), 물건 사이 간격, 요청 직전 백오프 재확인, 차단 시 공유 백오프와 회차 중단, 결과 규칙(차단 > 전부 실패 > 성공), 사진 파일 저장(`{itemId}/{seq}.{ext}`)을 옮긴다. 같은 어댑터·같은 공유 백오프·같은 IP 요청 예산을 쓰므로 수집 워커와 함께 옮긴다.
- **스케줄링과 단일 실행**: `TaskScheduler` 고정 주기 틱 + MySQL `GET_LOCK` 단일 실행 잠금. 잠금을 못 얻으면 실행하지 않고 `skipped`(`overlap`)를 기록한다. 서버 인스턴스가 둘이어도 회차가 겹치지 않는다.
- **안전장치(기본 꺼짐)**: 수집·사진 스케줄러는 설정으로 명시해 켜기 전에는 빈(bean)조차 만들어지지 않는다(`auctionboss.collector.enabled=false`, `auctionboss.photos.enabled=false`). 소스 HTTP 클라이언트는 별도 설정(`auctionboss.source.external-requests-allowed=false`)이 없으면 루프백이 아닌 주소로 요청을 보내지 않는다. 테스트·CI·개발 compose에서는 외부 사이트에 요청이 나가지 않는다.
- **동등성 증명(골든)**: (a) 어댑터 골든 — TS 어댑터 테스트 픽스처(실제 응답 샘플, 차단 응답 샘플)를 JSON으로 뽑아, TS 어댑터를 루프백 가짜 서버에 붙여 만든 결과(정규화 물건, 오류 종류, 실제 전송 요청과 대기 시간)를 Java 어댑터가 같은 응답 재생으로 재현하는지 비교한다. (b) 저장 골든 — 같은 소스 응답 시퀀스(신규·갱신·변경·기준점·차단·형식 오류·요청 상한·로테이션·사진)를 TS 워커(임시 SQLite)와 Spring 워커(Testcontainers MySQL)에 넣어 `items`·`item_changes`·`worker_runs`·`collector_state`·`item_photos`와 사진 파일이 같은지 비교한다.
- **아키텍처 테스트**: ArchUnit으로 소스 고유 형식이 어댑터 패키지 밖으로 새지 않음, 어댑터가 DB에 닿지 않음, HTTP 클라이언트가 어댑터 안에만 있음을 강제한다.
- **개발 환경 검증**: 가짜 서버로 전체 경로를 돌리고, 마지막에 한 번만 실제 사이트에 최소 요청(수집: 세션 1 + 검색 1페이지, 사진: 세션 1 + 상세 1)을 1회 실행 모드로 보낸다. 그 전에 TS 수집기·사진 워커를 멈추고 차단 백오프와 직전 요청 시각을 확인한다.

이 change에서 하지 않는 것:
- **운영 전환.** 운영 수집기·사진 워커는 TS + SQLite로 계속 돈다. Spring 스케줄러를 켜는 것은 5단계 데이터 이전 때 TS 워커를 끈 뒤에 한다. 두 수집기가 동시에 돌면 같은 IP의 요청 예산이 두 배가 되고, 서로 다른 DB에 있는 백오프를 서로 보지 못해 차단 위험이 커지므로 **동시 운영을 금지**한다.
- 분석 워커 이식(TS 유지, 2단계에서 HTTP로 Spring 연결을 증명함), 수집 범위 확대(ROADMAP "하지 않는 것"), 인증(7단계), 알림·지표(6단계).
- TS 수집기·사진 워커·소스 어댑터의 동작 변경. `workers/`와 `src/lib/sources/`는 바꾸지 않는다.

## Capabilities

### New Capabilities
<!-- 없음 -->

### Modified Capabilities
- `spring-backend`: 수집·사진 워커를 기존 요구사항 그대로 실행하는 요구사항, 스케줄러 기본 꺼짐과 외부 요청 차단 안전장치, 인스턴스 간 단일 실행 잠금, 저장과 회차 기록의 트랜잭션 경계, 소스 형식 격리의 기계적 강제, 어댑터·저장 결과의 동등성 증명, 운영 전환 보류와 동시 운영 금지를 더한다(ADDED). 기존 요구사항은 바뀌지 않는다.

`auction-collection`, `item-photos`, `run-observability`, `auction-history`의 요구사항은 바뀌지 않는다. 겹친 주기 건너뜀과 그 기록, 공유 백오프와 "짧아지지 않음", 요청 상한과 로테이션, 저장과 이력의 원자성, 사진 대기열·결과 규칙은 이미 그 스펙에 있고, Spring 구현은 그 요구사항을 같은 동작으로 만족할 뿐이다. 이번에 새로 생기는 요구는 Spring 구현과 전환 과정에만 해당하므로 `spring-backend`에 둔다.
`spring-backend`에는 진행 중인 `switch-web-to-data-port`도 요구사항을 더한다. 이 change는 그 change가 아카이브된 뒤에 아카이브한다.

## Impact

- **신규 코드(`backend/`)**: `collect.source`(계약·오류 계층), `collect.source.courtauction`(어댑터·HTTP·응답 파서·행 접기), `collect.collector`(회차 본체·저장·변경 감지·로테이션), `collect.photos`(사진 회차·파일 저장), `collect.run`(스케줄러·잠금·1회 실행 모드·설정 읽기). 기존 `worker` 패키지의 회차 서비스와 `collector_state` 저장소를 재사용·확장한다
- **신규 의존성(Java)**: ArchUnit(테스트), MockWebServer(테스트). 운영 의존성은 늘리지 않는다(HTTP는 JDK `HttpClient`, 잠금은 MySQL 함수)
- **신규 스크립트(TS)**: `scripts/collector-golden/`(픽스처 JSON 추출, 어댑터 골든 생성, 저장 골든 생성, 실데이터 비교). `workers/`와 `src/lib/sources/`는 수정하지 않는다
- **테스트**: 어댑터 골든·저장 골든 계약 테스트, 잠금·스케줄러·안전장치 통합 테스트, 아키텍처 테스트, 배포 설정 테스트 확장
- **스키마**: Flyway 마이그레이션 추가 없음(필요한 테이블과 컬럼은 V1~V3에 있다)
- **바뀌지 않는 것**: 운영 compose·K8s의 수집·사진 워커(TS), 분석 워커, 화면, 기존 API 계약과 골든
- **외부 요청**: 이 change 전체에서 실제 사이트 요청은 8장의 수동 확인 1회(최대 4요청)뿐이다
- **문서**: `docs/ROADMAP.md` 4단계 완료 기준 해석과 5단계 런북, `docs/DEVELOPMENT_NOTES.md` 수치, `docs/REFERENCE.md` 설정·실행 모드
