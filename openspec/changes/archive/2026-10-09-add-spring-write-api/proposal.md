## Why

1단계로 Spring 백엔드에 읽기 API 5개가 생겼지만, 분석 결과 저장·워커 회차 기록·관심 물건·피드·사진 API는 아직 Next.js에만 있다. 이 API들이 없으면 분석 워커를 Spring에 붙일 수 없고, 로드맵의 핵심 검증인 "분석 워커 코드는 바꾸지 않고 주소만 바꾼다"를 확인할 수 없다.
화면 전환(3단계)과 데이터 이전(5단계) 전에 쓰기 계약을 먼저 같은 형태로 맞춰 두어야, 이후 단계가 API 차이가 아니라 전환 자체에만 집중할 수 있다.

## What Changes

- **분석 결과 저장 API**: `POST /api/analyses`를 기존 Next와 같은 요청 검증·응답(201, 400, 404)으로 제공한다.
- **워커 회차 API**: `POST /api/worker-runs`(시작), `PATCH /api/worker-runs/{id}`(종료), `GET /api/worker-runs`(목록), `GET /api/worker-runs/summary`(집계). 워커별 보관 상한 정리를 포함한다.
- **관심 물건 API**: `GET /api/bookmarks`, `POST /api/bookmarks`(중복 등록은 성공), `DELETE /api/bookmarks/{itemId}`.
- **변동 피드 API**: `GET /api/feed`(미확인 개수 포함), `POST /api/feed/read`(읽음 처리).
- **사진 파일 API**: `GET /api/photos/{itemId}/{seq}`. 설정된 사진 디렉터리 밖의 파일은 내주지 않는다.
- **시나리오 골든 계약 비교**: 1단계의 요청 단위 골든을 "요청 순서대로 상태가 바뀌는 시나리오" 골든으로 넓힌다. Next 핸들러와 Spring에 같은 순서, 같은 고정 시각으로 요청해 응답을 비교한다.
- **분석 워커 무수정 연결 검증(개발 환경)**: 시드 MySQL + Spring에 분석 워커를 주소와 실행 파일 환경 변수만 바꿔 1회 실행하고, 분석이 MySQL에 저장되는 것을 확인한다. Claude 호출은 가짜 CLI로 대체해 비용과 외부 요청이 없다.

이 change에서 하지 않는 것:
- **운영 전환.** 운영 분석 워커·화면·수집 워커는 계속 Next + SQLite를 쓴다. MySQL에는 실명을 가린 시드만 있어서, 지금 분석 워커만 Spring으로 돌리면 분석은 MySQL에, 화면은 SQLite에 있는 "두 DB" 상태가 된다. 운영 전환은 5단계 데이터 이전과 함께 한 번에 한다.
- **화면 전용 폼 엔드포인트**(`POST /api/bookmarks/toggle`, `POST /api/feed/mark-read`의 303 리다이렉트). 화면을 서빙하는 쪽의 몫이라 3단계 화면 전환에서 다룬다.
- 인증(7단계), 수집기 이식(4단계), 사진 수집 워커 이식.

## Capabilities

### New Capabilities
<!-- 없음 -->

### Modified Capabilities
- `spring-backend`: 쓰기·나머지 API(분석 저장, 워커 회차, 관심 물건, 변동 피드, 사진 파일)의 계약 호환 요구사항과, 분석 워커가 코드 수정 없이 Spring에 연결되는 요구사항을 더한다. 기존 요구사항은 바뀌지 않는다.

`auction-analysis`, `bookmarks`, `run-observability`, `item-photos`의 요구사항은 바뀌지 않는다. Spring은 그 요구사항을 이미 만족하는 Next API의 계약을 재현할 뿐이다.

## Impact

- **신규 코드**: `backend/`의 `analysis`, `worker`, `bookmark`, `photo` 패키지에 컨트롤러·서비스·저장소, 공통 JSON 본문 검증기, 워커 설정(`maxRunsPerWorker`) 읽기
- **신규 스크립트**: `scripts/seed/generate-scenarios.ts`(시나리오 골든 생성), `scripts/seed/seed-to-sqlite.ts`(시드 SQL을 임시 SQLite로 적재), `scripts/dev/fake-claude`(개발 검증용 가짜 CLI)
- **테스트**: 시나리오 계약 테스트, 쓰기 API 통합 테스트(Testcontainers), `QueryCountTest` 확장
- **바뀌지 않는 것**: `workers/`(분석 워커 코드 변경 0줄), `src/`의 Next 라우트와 SQLite 경로, `docker-compose.yml`의 운영 서비스 주소, 기존 읽기 골든 90개
- **보안 상태**: 쓰기 API가 인증 없이 열린다. Next와 같은 상태이며, Spring 포트는 compose에서 루프백(`127.0.0.1:8080`)에만 열린다
- **문서**: `docs/ROADMAP.md` 2단계 완료 기준 문구, `docs/DEVELOPMENT_NOTES.md` 수치, `docs/REFERENCE.md` API 목록
