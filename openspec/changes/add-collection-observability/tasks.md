## 1. 스키마와 도메인 타입

- [x] 1.1 `src/lib/domain`에 `WorkerKind`(collector/analyzer), `RunOutcome`(running/success/failed/blocked/skipped), `WorkerRun` 타입과 워커별 `detail` 형태를 정의 — `tsc --noEmit` 통과
- [x] 1.2 `worker_runs` 테이블을 스키마에 추가(worker, started_at, finished_at, outcome, error_kind, error_message, detail JSON, 집계용 items_changed, 인덱스 `(worker, started_at DESC)`)하고 **기존 DB 파일에 재적용되는 마이그레이션 경로**를 기존 방식대로 테스트
- [x] 1.3 `config/collector.json`에 보관 상한(`observability.maxRunsPerWorker`, 기본 1000)과 상태 판정 배수(`observability.staleAfterIntervals`, 기본 3)를 추가하고 zod 스키마·로더에 반영, 잘못된 값은 조용히 기본값으로 넘어가지 않고 실패하는 것을 확인

## 2. 기록 저장소

- [x] 2.1 `startRun(worker)`와 `finishRun(runId, {outcome, errorKind, errorMessage, detail})`를 구현. 시작 시 `running` 행을 만들고 종료 시 갱신 — 워커가 회차 도중 죽어도 회차의 존재가 남는 것을 테스트로 확인
- [x] 2.2 `recordSkippedRun(worker, reason)`을 구현(시작·종료가 같은 순간이라 한 번에 기록)하고 테스트
- [x] 2.3 `detail` JSON과 집계용 `items_changed` 컬럼을 **한 함수에서만** 쓰게 하고, 두 값이 어긋나지 않는 것을 테스트로 고정(design 위험 항목)
- [x] 2.4 보관 상한 정리를 기록 시점에 수행하도록 구현하고, 상한을 넘겨 기록했을 때 오래된 것만 삭제되고 최근 것이 보존되는 것을 테스트
- [x] 2.5 `listWorkerRuns({worker, outcome, page, pageSize})`(최신순, 필터, 페이지네이션)와 `summarizeRuns({worker, since})`(성공률·차단 횟수·누적 변경 건수)를 구현하고 테스트

## 3. 상태 판정

- [x] 3.1 `getWorkerStatus(worker)`를 design D5의 판정 순서대로 구현하고, 기대 주기는 설정에서 읽도록 함 — 하드코딩하지 않을 것
- [x] 3.2 판정 순서를 테스트로 고정: 기록 없음→stale / 오래된 성공→stale / **오래된 running→stale**(finishRun 실패로 고아가 된 회차가 정상으로 보이면 안 됨) / 최근 blocked→blocked / 최근 failed→failed / 그 외 ok
- [x] 3.3 `skipped` 회차가 상태 판정에서 최근 회차로 취급되지 않는 것을 테스트(중첩 건너뜀은 정상 동작이므로 ok를 blocked로 바꿔서는 안 됨)

## 4. 워커 연동

- [x] 4.1 `workers/collector.ts`의 기존 회차 시작·완료·차단·중첩 건너뜀 로그 지점에 기록 호출을 추가(저장소 직접 호출). 어댑터의 오류 타입 이름을 `error_kind`로 기록해 차단과 일반 실패가 구별되는 것을 확인
- [x] 4.2 **모든 기록 호출을 try/catch로 감싸** 기록 실패가 수집을 중단시키지 않게 하고, 기록이 실패한 상태에서도 물건이 정상 저장되는 것을 테스트(스펙 MUST NOT)
- [x] 4.3 차단 백오프로 건너뛴 주기가 `skipped`(사유 backoff)로 기록되는 것을 확인 — 중첩 건너뜀(overlap)과 사유가 구별될 것
- [x] 4.4 `POST /api/worker-runs`(시작)와 종료 갱신 엔드포인트를 구현. 저장소 함수를 호출하는 얇은 층으로 만들어 collector 경로와 로직이 중복되지 않게 할 것. 잘못된 본문은 400, 없는 회차 갱신은 404
- [x] 4.5 `workers/analyzer.ts`가 회차를 API로 기록하도록 연동(신규·재분석·성공·실패 건수 포함). 분석할 물건이 없는 회차도 성공 0건으로 기록되는 것을 확인 — 기록 자체가 없어서는 안 됨
- [x] 4.6 analyzer의 기록 호출도 실패가 분석을 막지 않는 것을 확인(서버가 죽어 있어도 워커가 살아남을 것)

## 5. 조회 API와 상태 화면

- [x] 5.1 `GET /api/worker-runs`(worker·outcome 필터, 페이지네이션)와 집계 조회를 구현하고 실제 서버 curl로 정상·필터·빈 결과를 확인
- [x] 5.2 `/status` 페이지를 구현: 두 워커의 상태·마지막 성공 시각·최근 회차 목록·최근 집계. 차단 상태를 눈에 띄게 구별
- [x] 5.3 기록이 전혀 없을 때 오류 대신 안내가 표시되는 것을 확인
- [x] 5.4 목록·상세 페이지에서 `/status`로 가는 링크를 추가 — 접근 경로가 없으면 만들어도 아무도 보지 않음

## 6. 검증

- [x] 6.1 `npx tsc --noEmit`, `npm test`, `npm run build`, `npm run lint` 전부 통과
- [x] 6.2 실제 워커로 확인: 짧은 주기로 collector를 띄워 성공 회차가 기록되고 `/status`가 ok를 표시 → 중첩을 유발해 skipped(overlap) 기록 → 차단 오류를 주입해 blocked 기록과 `/status`의 차단 표시 → 백오프 중 skipped(backoff) 기록. 각 단계의 실제 출력을 제시
- [x] 6.3 analyzer를 서버와 함께 띄워 분석 회차가 API로 기록되는 것과, 서버를 내린 상태에서도 analyzer가 죽지 않는 것을 확인
- [x] 6.4 README에 상태 페이지·회차 기록 API·새 설정을 추가하고, **쓰기 API에 인증이 없어 외부 노출 시 임의 기록 주입이 가능하다는 점**을 명시(design D3)
