## 1. 프로젝트 스캐폴드

- [x] 1.1 Next.js(App Router) + TypeScript 프로젝트를 생성하고 `npm run dev`로 기본 페이지가 뜨는 것을 확인
- [x] 1.2 better-sqlite3, zod 의존성을 추가하고 `npm install`이 성공하는 것을 확인
- [x] 1.3 design.md D1의 디렉터리 구조(`src/lib/{db,domain,sources}`, `workers/`, `config/`)를 만들고 `config/collector.json`(법원 1곳, 주기 10분, 분석 회차당 5건 기본값)을 추가

## 2. 도메인 모델과 DB

- [x] 2.1 `src/lib/domain`에 `AuctionItem`, `Analysis`, `CollectScope` 타입을 정의 (spec auction-collection의 정규화 필드 전부 포함) — `tsc --noEmit` 통과로 확인
- [x] 2.2 `src/lib/db`에 SQLite 초기화(WAL 모드)와 `items`(UNIQUE(court, case_no, item_no), first_seen_at/last_seen_at), `analyses`(item_id FK, body, model, prompt_version, analyzed_at) 스키마 생성 코드를 작성 — 앱 실행 시 DB 파일과 테이블이 생성되는 것을 확인
- [x] 2.3 items upsert 함수(신규는 first_seen_at 기록, 기존은 값·last_seen_at 갱신)와 조회 함수(페이지네이션, 미분석 필터)를 작성하고 단위 테스트로 신규/갱신/중복 없음을 검증

## 3. 수집기 (auction-collection)

- [x] 3.1 법원경매정보 사이트의 물건 검색 내부 엔드포인트를 브라우저 개발자도구로 관찰해 요청/응답 형식을 파악하고, 관찰 결과(URL, 파라미터, 응답 예시)를 `src/lib/sources/courtauction/NOTES.md`에 기록
- [x] 3.2 `AuctionSource` 인터페이스와 `CourtAuctionAdapter`를 구현 (POST 요청, 페이지네이션 순회, zod 응답 검증, 정규화 변환, 필수 필드 누락 항목 제외+경고 로그) — 실제 사이트 대상 1회 실행으로 설정 지역의 물건 배열이 반환되는 것을 확인
- [x] 3.3 zod 검증 실패·요청 실패 시 오류를 로그로 남기고 해당 회차를 중단하는 실패 처리를 구현하고, 잘못된 응답 fixture로 단위 테스트 검증
- [x] 3.4 `workers/collector.ts`에 상주 스케줄러(설정 주기 setInterval, 실행 중 플래그로 중첩 방지, 회차별 처리 건수 로그)를 구현 — 주기를 짧게 설정해 2회차 연속 실행과 중첩 건너뛰기를 로그로 확인
- [x] 3.5 수집기를 실제로 돌려 설정 지역 물건이 DB에 저장되고, 재실행 시 중복 없이 갱신되는 것을 확인

## 4. 열람 (auction-viewing)

- [x] 4.1 `GET /api/items`(페이지네이션, `analyzed=false` 필터, 전체 건수 포함)와 `GET /api/items/[id]`(없으면 404)를 구현하고 curl로 응답 형식 확인
- [x] 4.2 물건 목록 페이지(매각기일 오름차순, 페이지네이션, 빈 상태 안내)를 구현하고 브라우저에서 수집된 실데이터 표시 확인
- [x] 4.3 물건 상세 페이지(사건번호, 물건번호, 법원, 수집 시각 포함 전체 필드 + 분석 영역 자리)를 구현하고 존재하지 않는 ID에서 404가 뜨는 것 확인

## 5. 분석 파이프라인 (auction-analysis)

- [x] 5.1 `POST /api/analyses`(물건 식별자·본문·prompt_version 검증, 없는 물건이면 404, 저장 후 성공 응답)를 구현하고 정상/오류 케이스를 curl로 확인
- [x] 5.2 분석 프롬프트 템플릿 `workers/prompts/analyze-item.md`(v1: 요약 평가 + 감정가 대비 최저가 코멘트)을 작성
- [x] 5.3 `workers/analyzer.ts`를 구현: `GET /api/items?analyzed=false&pageSize=N`으로 대상 조회 → 물건별 `claude -p --output-format json` 실행 → 출력 파싱 → `POST /api/analyses` 전송, 개별 실패는 로그 후 계속 진행 — 물건 1건으로 실제 실행해 분석 결과가 저장되는 것을 확인
- [x] 5.4 analyzer를 상주 주기 실행(10분)으로 만들고, 미분석 물건이 없을 때 아무 것도 하지 않고 대기하는 것을 로그로 확인
- [x] 5.5 물건 상세 페이지에 최신 분석 결과(요약, 분석 시각)를 표시하고, 분석 전 물건에는 "분석 대기 중" 안내가 나오는 것을 브라우저에서 확인

## 6. 엔드투엔드 검증

- [x] 6.1 collector, analyzer, Next.js 서버를 동시에 띄우고 "신규 수집 → 목록 표시 → 자동 분석 → 상세에서 분석 결과 확인"의 전체 흐름이 개입 없이 도는 것을 확인
- [x] 6.2 README에 실행 방법(서버/워커 기동 명령, config 설명, Claude Code CLI 사전 요건)을 정리하고 문서대로 처음부터 재현되는 것을 확인
