## ADDED Requirements

### Requirement: 필터 선택지 API 호환
백엔드는 `GET /api/items/filter-options`를 기존 Next.js 앱과 같은 계약으로 제공해야 한다(SHALL). 응답은 `{ usageTypes, sidoValues, sigunguValues, courtValues }`이고 각각 문자열 배열이다.

- `usageTypes`: 기존 용도 목록 API와 같은 값(쉼표로 쪼갠 토큰, 공백 제거, 빈 토큰 제외, 중복 제거, 정렬).
- `sidoValues`, `sigunguValues`, `courtValues`: 저장된 물건의 해당 값 중 NULL이 아닌 것의 중복 제거 목록. 빈 문자열도 하나의 값으로 다룬다(기존 앱과 같음).

중복 판단과 정렬은 문자를 그대로 비교해야 한다(SHALL). 대소문자나 악센트만 다른 값, 뒤쪽 공백만 다른 값은 서로 다른 값이며, 순서는 기존 앱과 같은 문자 코드 순이어야 한다(SHALL). 물건이 없으면 네 배열 모두 빈 배열이다.

#### Scenario: 시드 데이터의 선택지
- **WHEN** 시드 데이터에서 필터 선택지를 요청한다
- **THEN** 네 배열이 기존 앱과 같은 값과 순서로 돌아온다

#### Scenario: 문자 그대로의 구분
- **WHEN** 법원 값이 `A법원`, `a법원`, `A법원 `인 물건이 있는 상태에서 선택지를 요청한다
- **THEN** `courtValues`에 세 값이 모두 기존 앱과 같은 순서로 들어 있다

#### Scenario: 빈 데이터
- **WHEN** 물건이 하나도 없는 상태에서 선택지를 요청한다
- **THEN** 네 배열이 모두 빈 배열이다

### Requirement: 분석 이력 API 호환
백엔드는 `GET /api/items/{id}/analyses`를 기존 Next.js 앱과 같은 계약으로 제공해야 한다(SHALL). 응답은 `{ analyses, total }`이다. `analyses`는 분석 시각 최신순(같으면 id 내림차순)으로 최대 `limit`건이고, 각 항목은 상세 API의 분석과 같은 형태다. `total`은 `limit`과 무관한 그 물건의 전체 분석 건수다.

`limit`은 1 이상 50 이하의 정수이고 생략하면 10이다. 형식이 틀리면 400과 `field`가 `limit`인 `details`를 돌려줘야 한다(SHALL). `{id}`가 숫자가 아니거나 물건이 없으면 404와 `{ error: "물건을 찾을 수 없습니다: id=<id>" }`를 돌려줘야 한다(SHALL).

#### Scenario: 잘린 이력과 전체 건수
- **WHEN** 분석이 12건인 물건에 `limit=11`로 요청한다
- **THEN** 최신 11건과 `total: 12`가 돌아온다

#### Scenario: 분석 없는 물건
- **WHEN** 분석이 없는 물건의 이력을 요청한다
- **THEN** `{ analyses: [], total: 0 }`이 돌아온다

#### Scenario: 잘못된 limit
- **WHEN** `limit=0`이나 `limit=abc`로 요청한다
- **THEN** 400과 함께 `details`에 `field`가 `limit`인 항목이 있다

### Requirement: 사진 목록 API 호환
백엔드는 `GET /api/items/{id}/photos`를 기존 Next.js 앱과 같은 계약으로 제공해야 한다(SHALL). 응답은 `{ photos }`이고 각 항목은 `{ id, itemId, seq, fileSize, mimeType, collectedAt }`이며 순번 오름차순이다. 서버의 파일 경로는 응답에 넣으면 안 된다(MUST NOT). 사진이 없는 물건은 빈 배열이고, 없는 물건은 상세 API와 같은 404다.

#### Scenario: 사진 목록
- **WHEN** 사진 2건이 기록된 물건의 사진 목록을 요청한다
- **THEN** 순번 순으로 2건이 돌아오고 어느 항목에도 파일 경로 필드가 없다

#### Scenario: 없는 물건의 사진 목록
- **WHEN** 존재하지 않는 물건의 사진 목록을 요청한다
- **THEN** 404와 기존 앱과 같은 오류 메시지가 돌아온다

### Requirement: 워커 상태 판정 API 호환
백엔드는 `GET /api/worker-runs/status?worker=<워커>`를 기존 Next.js 앱과 같은 계약과 판정 규칙(run-observability "실행 상태 판정")으로 제공해야 한다(SHALL). 응답은 `{ state, lastSuccessAt, lastRun }`이다. `state`는 `ok`, `blocked`, `failed`, `stale` 중 하나이고, `lastRun`은 회차 목록 API의 회차와 같은 형태이거나 `null`이다.

판정의 "지금"은 백엔드의 서버 시각이어야 하고(SHALL), 워커별 기대 주기와 미실행 배수는 기존 앱과 같은 설정 원천에서 읽어야 한다(SHALL). `worker`가 없거나 `collector`, `analyzer`, `photos`가 아니면 400과 `field`가 `worker`인 `details`를 돌려줘야 한다(SHALL).

#### Scenario: 기록 없는 워커
- **WHEN** 회차 기록이 없는 워커의 상태를 요청한다
- **THEN** `{ state: "stale", lastSuccessAt: null, lastRun: null }`이 돌아온다

#### Scenario: 진행 중 회차 뒤의 차단
- **WHEN** 기대 주기 안에 성공 회차가 있고, 그 뒤 차단으로 끝난 회차와 아직 진행 중인 회차가 차례로 기록된 워커의 상태를 요청한다
- **THEN** `state`가 `blocked`이고 `lastRun`은 진행 중 회차다

#### Scenario: 건너뜀 뒤의 차단
- **WHEN** 차단으로 끝난 회차 뒤에 건너뜀 회차만 기록된 워커의 상태를 요청한다
- **THEN** `state`가 `blocked`이고 `lastRun`은 건너뜀 회차다

#### Scenario: 시간이 지나 미실행
- **WHEN** 마지막 성공 뒤 기대 주기 × 미실행 배수보다 긴 시간이 지난 시각에 상태를 요청한다
- **THEN** `state`가 `stale`이고 `lastSuccessAt`은 그 성공 회차의 종료 시각이다

### Requirement: 로테이션 위치 API 호환
백엔드는 `GET /api/collector-state/rotation`을 기존 Next.js 앱과 같은 계약으로 제공해야 한다(SHALL). 응답은 `{ nextCourtCode }`이고, 수집기가 다음 회차에 처리할 법원 코드이거나 기록이 없으면 `null`이다. 수집기의 다른 상태 값(차단 백오프 등)은 이 API로 노출하면 안 된다(MUST NOT).

#### Scenario: 기록된 위치
- **WHEN** 시드 데이터에서 로테이션 위치를 요청한다
- **THEN** 기존 앱과 같은 법원 코드가 돌아온다

#### Scenario: 기록 없음
- **WHEN** 로테이션 위치 기록이 없는 상태에서 요청한다
- **THEN** `{ nextCourtCode: null }`이 돌아온다

### Requirement: 화면용 읽기 계약의 시나리오 비교
화면용 읽기 API 5개의 호환은 기존 Next.js 앱과 같은 시드 상태, 같은 요청 순서, 같은 고정 서버 시각으로 응답을 비교해 기계적으로 증명해야 한다(SHALL). 워커 상태 판정처럼 시각에 따라 결과가 달라지는 API는 시각을 앞으로 옮기는 단계를 포함해 정상·차단·실패·미실행 판정을 모두 비교해야 한다(SHALL).

#### Scenario: 화면용 읽기 골든 일치
- **WHEN** 기존 앱으로 만든 화면용 읽기 시나리오 골든을 같은 시드 상태의 백엔드에 같은 순서와 같은 고정 시각으로 재생한다
- **THEN** 모든 단계의 상태 코드와 본문이 골든과 같다
