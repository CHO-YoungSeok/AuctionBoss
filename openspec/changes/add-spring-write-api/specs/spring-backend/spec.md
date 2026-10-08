## ADDED Requirements

### Requirement: 분석 결과 저장 API 호환
백엔드는 `POST /api/analyses`를 기존 Next.js API와 같은 계약으로 제공해야 한다(SHALL). 본문은 `itemId`(1 이상의 정수), `body`(빈 문자열 아님), `promptVersion`(빈 문자열 아님), 선택 `model`(있으면 빈 문자열 아님)이다. 저장에 성공하면 201과 저장된 분석(`id`, `itemId`, `body`, `model`, `promptVersion`, `analyzedAt`)을 돌려줘야 하며(SHALL), `model`을 보내지 않으면 `null`로 저장해야 한다(SHALL). 분석 시각은 요청 본문이 아니라 서버 시각으로 기록해야 한다(SHALL).

존재하지 않는 물건에 대한 결과는 404와 `{ error: "물건을 찾을 수 없습니다: id=<id>" }`로 거절하고 아무것도 저장하면 안 된다(MUST NOT). 저장된 분석은 같은 물건의 상세 API에서 최신 분석으로 조회되어야 한다(SHALL).

#### Scenario: 분석 저장
- **WHEN** 존재하는 물건에 대해 유효한 분석 결과를 보낸다
- **THEN** 201과 저장된 분석이 돌아오고, 이어서 그 물건의 상세를 요청하면 방금 저장한 분석이 최신 분석으로 나온다

#### Scenario: 모델 생략
- **WHEN** `model` 없이 분석 결과를 보낸다
- **THEN** 201 응답의 `model`이 `null`이다

#### Scenario: 없는 물건
- **WHEN** 존재하지 않는 물건 id로 분석 결과를 보낸다
- **THEN** 404와 기존 API와 같은 오류 메시지가 돌아오고, 분석이 있는 물건 수가 바뀌지 않는다

#### Scenario: 잘못된 본문
- **WHEN** `itemId`가 문자열이거나 `body`가 빈 문자열인 본문을 보낸다
- **THEN** 400과 함께 `details`에 해당 필드 이름이 기존 API와 같은 순서로 들어 있다

### Requirement: 쓰기 요청 본문 처리 호환
JSON 본문을 받는 쓰기 API는 기존 Next.js API와 같은 규칙으로 본문을 처리해야 한다(SHALL).

- 본문이 JSON으로 해석되지 않으면 400과 `{ error: "JSON 본문을 해석할 수 없습니다" }`를 돌려줘야 한다(SHALL).
- 형식이 틀린 본문은 400과 `{ error, details: [{ field, message }] }`로 거절해야 한다(SHALL). `field`는 본문 필드 경로이고, 본문 자체가 객체가 아니면 `(root)`다.
- 타입을 바꿔 받아들이면 안 된다(MUST NOT). 예를 들어 숫자 필드에 온 `"1"`은 거절한다.
- 정의되지 않은 필드는 무시해야 한다(SHALL). 오류가 아니며 저장되지도 않는다.
- 요청의 Content-Type 헤더 값과 무관하게 본문을 JSON으로 해석해야 한다(SHALL).

#### Scenario: 해석할 수 없는 본문
- **WHEN** 쓰기 API에 JSON이 아닌 본문을 보낸다
- **THEN** 400과 `error: "JSON 본문을 해석할 수 없습니다"`가 돌아온다

#### Scenario: 문자열로 온 숫자
- **WHEN** `{ "itemId": "1", ... }`처럼 숫자 필드를 문자열로 보낸다
- **THEN** 400과 함께 `details`에 `field`가 `itemId`인 항목이 들어 있다

#### Scenario: 모르는 필드
- **WHEN** 유효한 본문에 정의되지 않은 필드를 더해 보낸다
- **THEN** 요청은 성공하고, 응답과 저장된 값에 그 필드가 없다

### Requirement: 워커 회차 API 호환
백엔드는 워커 회차 API를 기존 Next.js API와 같은 계약으로 제공해야 한다(SHALL).

- `POST /api/worker-runs`: 본문 `{ worker }`(`collector`, `analyzer`, `photos` 중 하나). 진행 중(`running`) 회차를 만들고 201과 `{ id }`를 돌려준다.
- `PATCH /api/worker-runs/{id}`: 본문 `outcome`(`success`, `failed`, `blocked`), 선택 `errorKind`, `errorMessage`, `detail`. 종료 시각을 서버 시각으로 기록하고 갱신된 회차 전체를 돌려준다. `detail`은 수집 회차 형식(`targetCourts`, `pagesRequested`, `itemsFetched`, `inserted`, `updated`, `changed`)이나 분석 회차 형식(`newCount`, `reanalysisCount`, `succeeded`, `failed`)이어야 하며, 저장할 때 그 형식에 정의된 필드만 남긴다. 집계용 변경 건수는 수집 회차 형식의 `changed`에서만 정해지고 그 밖에는 `null`이다.
- `GET /api/worker-runs`: `worker`, `outcome`, `page`, `pageSize`(기본 20, 최대 200)로 걸러 `{ runs, total, page, pageSize }`를 시작 시각 최신순(같으면 id 내림차순)으로 돌려준다.
- `GET /api/worker-runs/summary`: `worker`, `since`로 걸러 `{ totalRuns, successCount, failedCount, blockedCount, skippedCount, runningCount, successRate, itemsChanged }`를 돌려준다. 완료된 회차가 없으면 `successRate`는 `null`이다.

`{id}`가 숫자가 아니거나 해당 회차가 없으면 404와 `{ error: "회차를 찾을 수 없습니다: id=<id>" }`를 돌려줘야 한다(SHALL). 잘못된 쿼리 파라미터는 400과 URL 파라미터 이름을 `field`로 한 `details`로 거절해야 한다(SHALL).

새 회차를 시작할 때마다 그 워커의 회차가 서버 설정의 워커별 최대 보관 건수를 넘으면, 시작 시각이 오래된 것부터 넘는 만큼 지워야 한다(SHALL). 보관 상한은 기존 Next.js와 같은 설정 원천에서 읽어야 한다(SHALL).

#### Scenario: 회차 시작과 종료
- **WHEN** 분석 회차를 시작하고, 받은 id로 성공과 분석 회차 수치를 담아 종료한다
- **THEN** 시작 응답은 201과 `{ id }`이고, 종료 응답에는 시작·종료 시각, `success`, 보낸 수치, `itemsChanged: null`이 들어 있다

#### Scenario: 수집 회차의 변경 건수
- **WHEN** 수집 회차를 `detail.changed`가 5인 값으로 종료한 뒤 집계를 요청한다
- **THEN** 그 회차의 `itemsChanged`가 5이고 집계의 `itemsChanged`에 5가 더해져 있다

#### Scenario: 없는 회차 종료
- **WHEN** 존재하지 않는 회차 id나 숫자가 아닌 id로 종료를 요청한다
- **THEN** 404와 기존 API와 같은 오류 메시지가 돌아온다

#### Scenario: 형식이 다른 회차 수치
- **WHEN** 수집·분석 어느 형식에도 맞지 않는 `detail`로 종료를 요청한다
- **THEN** 400이 돌아오고 회차는 바뀌지 않는다

#### Scenario: 회차 목록 필터
- **WHEN** `worker=analyzer&outcome=success`로 목록을 요청한다
- **THEN** 해당 워커의 성공 회차만 최신순으로 돌아오고, 결과가 기존 API와 같다

#### Scenario: 보관 상한 정리
- **WHEN** 한 워커의 회차가 보관 상한만큼 쌓인 상태에서 그 워커의 회차를 하나 더 시작한다
- **THEN** 그 워커에서 시작 시각이 가장 오래된 회차가 지워지고 다른 워커의 회차는 그대로다

### Requirement: 관심 물건 API 호환
백엔드는 관심 물건 API를 기존 Next.js API와 같은 계약으로 제공해야 한다(SHALL).

- `GET /api/bookmarks`: `page`, `pageSize`(기본 20, 최대 200). `{ items, total, page, pageSize }`이며, `items`는 물건 상세 API의 `item`과 같은 형태로 최근 담은 순(같으면 물건 id 내림차순)이다. 담긴 물건이 없으면 빈 배열이다.
- `POST /api/bookmarks`: 본문 `{ itemId }`. 201과 `{ item }`(관심 표시가 켜진 물건)을 돌려준다. 이미 담긴 물건을 다시 담아도 201이며, 행이 늘거나 처음 담은 시각이 바뀌면 안 된다(MUST NOT).
- `DELETE /api/bookmarks/{itemId}`: 200과 `{ itemId, bookmarked: false }`. 담기지 않은 물건을 빼도 오류가 아니다.

존재하지 않는 물건을 담거나 빼면 404와 `{ error: "물건을 찾을 수 없습니다: id=<id>" }`를 돌려주고 아무것도 바꾸면 안 된다(MUST NOT). `DELETE`의 `{itemId}`가 숫자가 아니어도 같은 404다.

관심 목록 조회의 데이터베이스 질의 수는 담긴 물건 수에 비례하면 안 된다(MUST NOT).

#### Scenario: 관심 등록과 목록
- **WHEN** 물건 두 개를 차례로 담고 관심 목록을 요청한다
- **THEN** 나중에 담은 물건이 먼저 오고, 각 물건의 `bookmarked`가 `true`이며, 결과가 기존 API와 같다

#### Scenario: 중복 등록
- **WHEN** 이미 담긴 물건을 다시 담는다
- **THEN** 201이 돌아오고, 관심 목록의 건수와 그 물건의 담은 순서가 바뀌지 않는다

#### Scenario: 관심 해제
- **WHEN** 담긴 물건을 뺀 뒤 관심 목록과 물건 목록(`bookmarked=true`)을 요청한다
- **THEN** 두 결과 모두 그 물건을 포함하지 않는다

#### Scenario: 없는 물건 등록
- **WHEN** 존재하지 않는 물건 id로 관심 등록을 요청한다
- **THEN** 404가 돌아오고 관심 목록이 바뀌지 않는다

#### Scenario: 담긴 물건 수와 무관한 질의 수
- **WHEN** 담긴 물건이 4건일 때와 30건일 때 같은 관심 목록 요청을 보낸다
- **THEN** 두 요청이 실행한 데이터베이스 질의 수가 같다

### Requirement: 변동 피드 API 호환
백엔드는 변동 피드 API를 기존 Next.js API와 같은 계약으로 제공해야 한다(SHALL).

- `GET /api/feed`: `page`, `pageSize`(기본 20, 최대 200), `sinceBookmarkedAt`(`true`/`false`). 담긴 물건의 실제 변경(기준점 제외)을 변경 시각 최신순(같으면 변경 id 내림차순)으로 `{ entries, total, page, pageSize, unreadCount }`에 담아 돌려준다. 각 항목은 `id`, `itemId`, `itemAddress`, `field`, `oldValue`, `newValue`, `changedAt`, `bookmarkedAt`이다. `sinceBookmarkedAt=true`면 담은 시각 이후의 변경만 포함한다.
- `POST /api/feed/read`: 본문 없이 호출한다. 서버 시각을 마지막 확인 시각으로 기록하고 200과 `{ lastReadAt, unreadCount }`를 돌려준다. 마지막 확인 시각은 항상 한 행만 유지해야 한다(SHALL).

미확인 개수는 마지막 확인 시각보다 뒤에 기록된 피드 변경 수이며, 한 번도 확인하지 않았으면 전체 피드 변경 수다(SHALL). 피드 조회만으로 확인 시각이 바뀌면 안 된다(MUST NOT). 피드 조회의 데이터베이스 질의 수는 피드 항목 수에 비례하면 안 된다(MUST NOT).

#### Scenario: 피드와 미확인 개수
- **WHEN** 실제 변경 이력이 있는 물건을 담고, 한 번도 읽음 처리를 하지 않은 상태에서 피드를 요청한다
- **THEN** 그 물건의 실제 변경만 최신순으로 돌아오고 `unreadCount`가 피드 전체 건수와 같으며, 결과가 기존 API와 같다

#### Scenario: 읽음 처리
- **WHEN** 읽음 처리를 요청한 뒤 피드를 다시 요청한다
- **THEN** 읽음 응답의 `lastReadAt`이 요청 시점의 서버 시각이고, 이후 피드의 `unreadCount`가 0이다

#### Scenario: 조회만 한 경우
- **WHEN** 읽음 처리 없이 피드를 두 번 요청한다
- **THEN** 두 응답의 `unreadCount`가 같다

#### Scenario: 잘못된 피드 파라미터
- **WHEN** `sinceBookmarkedAt=yes`로 피드를 요청한다
- **THEN** 400과 함께 `details`에 `field`가 `sinceBookmarkedAt`인 항목이 들어 있다

### Requirement: 사진 파일 API 호환
백엔드는 `GET /api/photos/{itemId}/{seq}`를 기존 Next.js API와 같은 계약으로 제공해야 한다(SHALL). 저장된 사진이면 200, 저장된 MIME 형식의 `Content-Type`, `Cache-Control: public, max-age=86400, immutable`과 파일 내용을 그대로 돌려줘야 한다(SHALL). `itemId`나 `seq`가 정수로 해석되지 않으면 400과 본문 `Invalid ID`를, 사진 기록이 없으면 404와 `Not Found`를, 기록은 있으나 파일을 읽을 수 없으면 404와 `File Not Found`를 텍스트로 돌려줘야 한다(SHALL).

사진 파일은 설정된 사진 디렉터리 안에서만 읽어야 하며(MUST), 기록된 경로가 그 디렉터리 밖을 가리키면 파일을 읽을 수 없는 경우와 같이 404를 돌려줘야 한다(SHALL).

#### Scenario: 사진 조회
- **WHEN** 사진이 저장된 물건의 사진을 순번으로 요청한다
- **THEN** 200과 저장된 파일과 같은 바이트, 같은 `Content-Type`과 캐시 헤더가 돌아온다

#### Scenario: 사진 기록 없음
- **WHEN** 사진 기록이 없는 순번을 요청한다
- **THEN** 404와 `Not Found`가 돌아온다

#### Scenario: 디렉터리 밖 경로
- **WHEN** 사진 기록의 경로가 사진 디렉터리 밖을 가리키는 상태에서 그 사진을 요청한다
- **THEN** 404와 `File Not Found`가 돌아오고 디렉터리 밖 파일 내용은 응답에 나오지 않는다

#### Scenario: 숫자가 아닌 id
- **WHEN** `/api/photos/abc/1`을 요청한다
- **THEN** 400과 `Invalid ID`가 돌아온다

### Requirement: 쓰기 계약의 시나리오 비교
쓰기 API의 호환은 요청 순서에 따라 상태가 바뀌는 시나리오 단위로 기존 Next.js API와 기계적으로 비교해 증명해야 한다(SHALL). 두 쪽은 같은 시드 상태에서 시작해 같은 순서의 요청을 받고, 각 요청 시점의 서버 시각을 같은 값으로 고정한 채 응답의 상태 코드와 본문을 비교해야 한다(SHALL). 서버 시각에서 나온 값(분석 시각, 회차 시작·종료 시각, 담은 시각, 마지막 확인 시각)도 비교 대상이다.

시나리오는 최소한 회차 시작·종료·목록·집계, 관심 등록·중복 등록·목록·피드·읽음·해제, 분석 저장과 상세의 최신 분석 확인, 사진 조회를 포함해야 한다(SHALL).

#### Scenario: 시나리오 골든 일치
- **WHEN** 기존 API로 만든 시나리오 골든을 같은 시드 상태의 백엔드에 같은 순서와 같은 고정 시각으로 재생한다
- **THEN** 모든 단계의 상태 코드와 본문이 골든과 같다

### Requirement: 분석 워커 무수정 연결
분석 워커는 코드 수정 없이 실행 설정(서버 주소)만 바꿔 백엔드와 동작해야 한다(SHALL). 백엔드에 연결된 분석 워커의 한 회차는 대상 조회, 분석 결과 저장, 회차 시작·종료 기록을 모두 백엔드 API로 처리해야 하며(SHALL), 결과는 백엔드의 데이터베이스에 남아야 한다(SHALL).

이 연결은 시드 데이터를 가진 개발 환경에서 검증한다. 운영 환경의 분석 워커, 화면, 수집 워커는 이 단계에서 백엔드로 전환하지 않아야 한다(MUST NOT) — 운영 데이터가 아직 기존 데이터베이스에 있어서, 분석 워커만 옮기면 분석과 화면이 서로 다른 데이터베이스를 보게 된다.

#### Scenario: 주소만 바꾼 분석 회차
- **WHEN** 개발 환경에서 분석 워커를 백엔드 주소로 1회 실행한다(분석 모델 호출은 가짜 실행 파일로 대체)
- **THEN** 백엔드 데이터베이스에 새 분석이 저장되고 분석 회차 기록이 성공으로 남으며, 분석 워커 코드의 변경은 0줄이다

#### Scenario: 운영 경로 유지
- **WHEN** 이 change를 적용한 뒤 기본 설정으로 운영 구성의 분석 워커를 띄운다
- **THEN** 분석 워커는 기존 Next.js 서버 주소로 통신하고, 분석은 기존 데이터베이스에 저장된다
