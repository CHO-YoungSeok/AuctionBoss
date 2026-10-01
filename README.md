# AuctionBoss

**법원경매 물건을 자동 수집하고, 변동을 추적하며, AI가 물건마다 요약 분석을 붙여 주는 서비스**

[![CI](https://github.com/CHO-YoungSeok/AuctionBoss/actions/workflows/ci.yml/badge.svg)](https://github.com/CHO-YoungSeok/AuctionBoss/actions/workflows/ci.yml)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Next.js](https://img.shields.io/badge/Next.js-15-000000?logo=nextdotjs)
![SQLite](https://img.shields.io/badge/SQLite-better--sqlite3-003B57?logo=sqlite)
![Tests](https://img.shields.io/badge/tests-766%20passed-success)

> 1인 개발 · 2026.09 · TypeScript / Next.js 15 / SQLite / Claude API · Docker · Kubernetes

---

## 한눈에 보기

법원경매정보 사이트는 "지금 상태"만 보여 준다. 그런데 투자자가 정말 알고 싶은 것은 **"내가 보는 물건의 최저가가 언제 얼마나 떨어졌는가"** 다.

AuctionBoss는 이 틈을 메운다.

- **10분마다 수집** → 서울 5개 법원의 진행 중 물건을 정규화해 저장
- **변동 추적** → 최저매각가·유찰횟수·매각기일·진행상태가 바뀌면 이력으로 남기고, 관심 물건은 피드로 알림
- **AI 분석** → 물건마다 Claude가 감정가 대비 비율·면적당 가격·차수별 저감 추이를 해석한 요약을 작성
- **운영 관측** → 수집기가 차단당했는지, 조용히 죽었는지를 로그가 아닌 화면(`/status`)에서 확인

---

## 핵심 기능

| 영역 | 기능 |
| --- | --- |
| 수집 | 법원 로테이션 수집, 회차당 요청 예산 제한, IP 차단 감지 및 1시간 백오프, 물건 사진 별도 수집 |
| 열람 | 용도·지역·가격대·유찰횟수·매각기일·저감률·사진 유무 필터, 5종 정렬, 필터·정렬·페이지 상태를 URL로 재현 |
| 상세 | 차수별 최저가 변화, 변경 이력 타임라인, AI 분석 리포트, 사진, 카카오/네이버 지도 바로가기 |
| 추적 | 관심 물건 등록, 관심 물건의 변동만 모은 피드, 읽음 처리 |
| 분석 | 신규 물건 자동 분석, 가격 변동 시 재분석(24시간 쿨다운), 프롬프트 버전 관리 |
| 운영 | 워커 회차 기록(성공/실패/차단/건너뜀), 상태 대시보드, 헬스체크, Docker Compose / K8s 매니페스트 |

---

## 아키텍처

세 개의 독립 프로세스가 하나의 SQLite를 중심으로 동작한다. 하나가 죽어도 나머지는 계속 돈다.

```
 courtauction.go.kr
        │  JSON (비공식 엔드포인트)
        ▼
 ┌──────────────┐  upsert   ┌──────────┐  read/write  ┌─────────────────┐
 │  collector   │ ────────▶ │  SQLite  │ ◀──────────▶ │  Next.js 앱     │ ◀── 브라우저
 │  (10분 주기) │           │          │              │  페이지 + /api  │
 └──────────────┘           └──────────┘              └─────────────────┘
   CourtAuctionAdapter                                        ▲
   소스 JSON → 도메인 모델                                     │ HTTP only
                                                              ▼
                                                     ┌─────────────────┐
                                                     │  analyzer       │ ──▶ Claude
                                                     │  (10분 주기)    │     (CLI 또는 API)
                                                     └─────────────────┘
```

### 설계 원칙

1. **소스 격리** — 외부 사이트 접근은 `AuctionSource` 어댑터 뒤에만 존재한다. 소스 고유 JSON 형식은 어댑터 밖으로 새지 않으므로, 소스가 바뀌어도 서비스 본체는 영향받지 않는다.
2. **분석 워커는 DB를 모른다** — analyzer는 HTTP API로만 서버와 통신한다. 분석 워커를 다른 머신·컨테이너로 분리해도 코드 변경이 없다.
3. **스펙 먼저, 구현은 그다음** — 모든 기능은 OpenSpec으로 proposal → design → spec → tasks를 먼저 쓰고 구현했다. 17개 change가 `openspec/changes/archive/`에 그대로 남아 있다.

---

## 기술적으로 고민한 지점

**1. HTTP 200으로 오는 차단을 어떻게 감지하나**
사이트는 IP를 차단해도 상태 코드를 200으로 유지한 채 본문만 바꾼다. 어댑터는 응답을 3단으로 검사한다. 본문이 JSON인가 → `ipcheck` 플래그가 참인가 → zod 스키마가 통과하는가. 하나라도 실패하면 회차를 즉시 중단하고 1시간 백오프에 들어간다. 차단은 "실패"와 다른 결과로 기록해 원인과 대응을 구별한다.

**2. 요청 예산을 어떻게 지키나**
실측 결과 5분에 15회 미만의 요청으로도 차단됐다. 회차당 요청 수 상한과 법원 수 상한을 설정으로 두고, 법원을 매 회차 로테이션해 한 번에 한 곳만 긁는다. 사진 수집은 물건당 1요청이라 물건 수집과 완전히 분리된 워커로 두고, 화면 렌더링 경로에서는 절대 외부 요청을 보내지 않는다.

**3. AI가 산수를 틀리는 문제**
프롬프트 v2는 모델에게 JSON에서 면적을 찾아 가격을 나누라고 시켰는데, 값이 있는데도 "정보 없음"으로 답하는 사례가 나왔다. v3부터는 면적당 가격·차수별 저감률을 **코드가 미리 계산**해 "파생 지표" 블록으로 넘기고, 모델에게는 해석만 맡긴다. 저장된 분석마다 프롬프트 버전을 기록하므로 버전이 올라가면 재분석 대상이 자동으로 잡힌다.

**4. 소스 데이터를 믿지 않는 표시**
전체 물건의 48%에서 최소 면적이 최대 면적보다 큰 역전 데이터가 들어왔다. 범위로 이어 붙이지 않고 두 값을 병기하며, 면적당 가격 계산에 어느 면적을 썼는지 화면과 프롬프트 양쪽에 명시한다. "정직한 표시"를 UX 원칙으로 뒀다.

**5. 워커가 조용히 죽는 것을 어떻게 아나**
수집·분석 워커의 모든 회차를 `worker_runs` 테이블에 남긴다. 건너뛴 회차도 기록해 "죽었다"와 "의도적으로 쉬었다"를 구별한다. 설정 주기의 3배 동안 기록이 없으면 `/status`가 stale로 표시한다.

---

## 기술 스택

| 분류 | 선택 | 이유 |
| --- | --- | --- |
| 언어 | TypeScript 5 (strict) | 소스 JSON → 도메인 모델 변환을 타입으로 강제 |
| 프레임워크 | Next.js 15 App Router, React 19 | 서버 컴포넌트로 DB 직접 조회, API 라우트를 워커와 공유 |
| DB | SQLite (better-sqlite3) | 단일 서버·수백 건 규모에 맞는 가장 단순한 선택. 동기 API로 트랜잭션이 명확 |
| 검증 | zod | 외부 응답·API 입력·Claude 출력 전부 런타임 검증 |
| AI | Claude (CLI headless / Messages API) | `ANTHROPIC_API_KEY` 유무로 자동 전환 |
| 테스트 | Vitest | 51개 파일, 766개 테스트, 2초 내 완료 |
| 배포 | Docker multi-stage, Docker Compose, Kubernetes(Kustomize) | 헬스체크 엔드포인트로 liveness/readiness 프로브 |
| CI | GitHub Actions | typecheck → test → build → lint 4단 게이트 |

---

## 빠른 시작

### Docker Compose (권장)

```bash
git clone https://github.com/CHO-YoungSeok/AuctionBoss.git
cd AuctionBoss
docker compose up -d
# http://localhost:3000
```

웹·수집기·분석기 세 컨테이너가 함께 뜬다. 분석기를 쓰려면 `docker-compose.yml`의 analyzer 서비스에 `ANTHROPIC_API_KEY` 환경 변수를 추가한다.

### 로컬 개발

```bash
npm install
npm run dev          # 터미널 1 — 웹 서버
npm run collector    # 터미널 2 — 수집 워커 (즉시 1회 실행 후 10분 주기)
npm run analyzer     # 터미널 3 — 분석 워커 (서버가 뜬 뒤에 실행)
```

| 환경 변수 | 설명 | 기본값 |
| --- | --- | --- |
| `AUCTIONBOSS_DB` | SQLite 파일 경로 | `./data/auctionboss.db` |
| `ANTHROPIC_API_KEY` | 있으면 Messages API 직접 호출, 없으면 로컬 `claude` CLI 사용 | 없음 |
| `AUCTIONBOSS_API_BASE` | 분석 워커가 바라볼 서버 주소 | `http://localhost:3000` |

수집 범위·주기·분석 한도는 `config/collector.json`에서 조정한다.

---

## 프로젝트 구조

```
src/
├── app/                    # Next.js App Router
│   ├── page.tsx            #   물건 목록 (필터·정렬·페이지네이션)
│   ├── items/[id]/         #   물건 상세 (이력·분석·사진·지도)
│   ├── bookmarks/ feed/    #   관심 물건, 변동 피드
│   ├── status/             #   워커 상태 대시보드
│   └── api/                #   items · analyses · bookmarks · feed · worker-runs · photos · health
└── lib/
    ├── domain/             # 도메인 모델, 쿼리 규칙, 가격 계산, 법원 로테이션
    ├── sources/            # AuctionSource 인터페이스 + courtauction 어댑터 (소스 격리 경계)
    ├── db/                 # 스키마, 리포지토리, 마이그레이션
    └── storage/            # 사진 파일 저장

workers/
├── collector.ts            # 수집 워커
├── analyzer.ts             # 분석 워커 (HTTP API만 사용)
├── photos.ts               # 사진 수집 워커
├── lib/                    # Claude 호출, 프롬프트 렌더, 파생 지표 계산
└── prompts/analyze-item.md # 분석 프롬프트 (v3)

openspec/
├── specs/                  # 8개 capability의 현재 스펙
└── changes/archive/        # 17개 change의 proposal · design · tasks 기록

k8s/  Dockerfile  docker-compose.yml  .github/workflows/ci.yml
```

---

## 품질과 개발 프로세스

- **테스트 766개 / 51개 파일** — 어댑터는 실제 응답 fixture로, API 라우트는 임시 DB로, 워커는 Claude 호출을 주입해 검증한다. 상세 페이지 렌더링과 XSS 이스케이프도 회귀 테스트로 고정했다.
- **4단 게이트** — `tsc --noEmit`, `vitest`, `next build`, `eslint`가 모두 통과해야 머지한다. CI와 로컬 기준이 같다.
- **스펙 주도 개발** — 기능 하나가 proposal → design → spec(SHALL/MUST 규칙) → tasks → 구현 → 아카이브 순서로 흐른다. 열린 질문과 미검증 가설은 design.md에 기록해 두고 다음 사이클에서 실측으로 닫는다.
- **실측 기반 결정** — 차단 임계, 요청 예산, 페이지 크기 상한 같은 숫자는 전부 실제 측정값이며 근거 위치를 코드 주석과 문서에 남겼다.

---

## 알려진 한계

- 비공식 엔드포인트에 의존하므로 소스가 바뀌면 수집이 멈춘다. zod 검증으로 즉시 감지는 되지만 자동 복구는 없다.
- 며칠 단위 무인 운용의 장기 차단 임계는 아직 실측되지 않았다. 회차 기록 인프라로 데이터를 쌓는 중이다.
- 인증이 없다. 로컬·내부망 사용을 전제한다.
- 권리관계·임차인·등기 정보는 소스 자체에 없어 분석에 포함되지 않는다.
- 수집 데이터는 개인 열람 용도이며, 외부 재배포 전에는 별도 법적 검토가 필요하다.

---

## 더 읽기

- [상세 레퍼런스](docs/REFERENCE.md) — 전체 API 명세, 설정 항목, 실측 수치, 사이클별 설계 결정
- [현재 스펙](openspec/specs/) — 8개 capability의 요구사항
- [소스 조사 노트](src/lib/sources/courtauction/NOTES.md) — 비공식 엔드포인트 분석과 차단 실측 기록
