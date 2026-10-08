## Why

메인 스펙을 코드와 대조한 결과(`align-specs-with-code`), 사진 워커와 배포 설정에서 "스펙은 옳고 코드가 틀린" 결함이 나왔다. 사진 워커는 회차를 기록하지 않아 상태 화면에서 영구히 '미실행'으로 보이고, 차단 백오프를 수집 워커와 공유하지 못해 IP 차단을 연장할 수 있다. 컨테이너로 띄운 분석 워커는 서버 주소 변수 이름이 달라 서버를 찾지 못한다. 상시 운영(로드맵 병행 항목)을 시작하기 전에 지금의 TypeScript 운영 경로에서 이 결함들을 먼저 고친다.

## What Changes

- **소스 어댑터에 사진 조회 추가**: `AuctionSource`에 사진 조회 메서드를 더하고 법원경매 어댑터가 구현한다. 사진 워커는 `courtauction/detail`을 직접 import하지 않는다. 사진 요청에도 차단 감지 3단 검사(본문 첫 글자 → `ipcheck` → zod)를 적용한다. 확인되지 않은 옛 상세 엔드포인트를 쓰던 `detail.ts`는 어댑터 내부로 흡수되어 사라진다.
- **차단 백오프 공유**: 차단 백오프 종료 시각을 `collector_state`의 `backoff_until` 키 하나에 기록한다. 수집 워커는 메모리 변수 대신 이 값을 읽고 쓴다(재시작해도 백오프가 유지된다). 사진 워커도 같은 키를 읽고, 소스가 차단을 알리면 같은 키에 기록한다. 응답 메시지에 "HTTP"가 들어 있으면 10분 백오프를 걸던 임의 규칙은 없앤다.
- **사진 워커 재작성**: 수집 워커와 같은 상주·주기 구조(`--once` 지원)로 바꾸고, 회차를 `worker_runs`에 기록한다(성공·실패·차단·건너뜀). 요청 간격·회차당 물건 수·주기를 설정으로 뺀다. 실패한 물건은 마지막 시도 후 설정 간격(기본 24시간)이 지나야 다시 대상이 된다.
- **사진 표시 상태 정정**: 상세 조회 키가 없는 물건은 '수집 실패'가 아니라 '사진 정보 없음(조회 불가)'로 표시한다.
- **배포 설정 정정**: compose와 K8s의 analyzer에 `AUCTIONBOSS_API_BASE`를 넘긴다. compose analyzer에 `ANTHROPIC_API_KEY`(선택)를 넘긴다. compose web 헬스체크를 curl 없이 동작하게 바꾼다. 사진 워커를 compose 서비스와 K8s Pod 컨테이너로 추가한다.
- **Claude API 기본 모델 교체**: 은퇴한 `claude-3-5-sonnet-20241022` 하드코딩을 현재 모델로 바꾼다. `AUCTIONBOSS_ANALYZE_MODEL`로 덮어쓰는 구조는 그대로 둔다.
- **스키마**: `items`에 사진 마지막 시도 시각 컬럼을 추가한다(SQLite는 `client.ts` ALTER 보정, MySQL은 Flyway `V2`).

이 change에서 하지 않는 것:
- 사진 수집·수집 워커의 Spring 이식(로드맵 4단계)
- 분석 실행 방식(API·CLI 선택 규칙) 자체의 변경 — 기본 모델 값만 바꾼다

## Capabilities

### New Capabilities
<!-- 없음 -->

### Modified Capabilities
- `item-photos`: 실패 재시도 간격, 차단 백오프의 공유 저장소와 회차 기록, 조회 불가 표시 상태, 상주·주기 실행과 요청 간격 설정
- `run-observability`: 사진 워커 회차 기록(처리 수치·상태 판정 주기)을 별도 요구사항으로 추가하고, 상태 화면에 사진 워커를 포함
- `auction-collection`: 어댑터 계약에 사진 조회를 포함하고, 차단 백오프를 워커 간 공유 저장소에 기록·조회
- `deployment-and-health`: compose 구성(analyzer 환경 변수, curl 없는 web 헬스체크, 사진 워커 서비스) 요구사항 추가, K8s 워크로드에 analyzer 환경 변수와 사진 워커 컨테이너 반영

## Impact

- **코드**: `src/lib/sources/types.ts`, `src/lib/sources/courtauction/adapter.ts`(사진 조회), `src/lib/sources/courtauction/detail.ts`(삭제), `src/lib/db/collector-state.ts`(백오프 키·함수), `src/lib/db/schema.ts`·`client.ts`·`repository.ts`(시도 시각 컬럼, 대기 물건 조회), `src/lib/domain/types.ts`·`config.ts`(사진 회차 수치, 사진 설정), `src/lib/db/worker-runs.ts`(사진 워커 상태 판정 주기), `workers/collector.ts`, `workers/photos.ts`, `workers/lib/claude.ts`, `src/app/_lib/photo-display.ts`, `src/app/_lib/status-display.ts`
- **설정**: `config/collector.json`에 `photos` 절 추가
- **배포**: `docker-compose.yml`, `k8s/deployment.yaml`, `k8s/deployment-analyzer.yaml`
- **Spring 백엔드**: `backend/src/main/resources/db/migration/V2__item_photo_attempt.sql` 추가(컬럼만, 쓰기 경로 없음). 읽기 API 응답은 바뀌지 않는다
- **테스트**: 사진 워커·어댑터 사진 조회·백오프 공유·대기 물건 조회·표시 상태·compose/K8s 설정·기본 모델에 테스트를 추가한다. 테스트 수는 늘기만 한다
- **다른 change와의 관계**: `align-specs-with-code`와 같은 요구사항을 MODIFIED하지 않는다(design.md D9)
