# 개발 기록

> 개발 기간(2026.09) 동안 사이클마다 이어서 적은 작업 기록이다. 당시의 실측 수치, 미해결 질문, 설계 판단이 시간 순서대로 쌓여 있어 일부 내용은 현재 코드와 다를 수 있다.
> 프로젝트 소개는 [README](../README.md)를, 현재 기준의 설정과 API는 [레퍼런스](REFERENCE.md)를 볼 것.

대한민국 법원경매 물건을 주기적으로 수집해 SQLite에 저장하고, 웹에서 목록·상세로 열람하며,
물건마다 Claude Code CLI로 생성한 AI 요약 분석을 함께 보여주는 개인/내부용 서비스다.

- 스택: TypeScript + Next.js 15 (App Router) + SQLite(better-sqlite3) + zod
- 수집 소스: [대한민국 법원경매정보](https://www.courtauction.go.kr) 내부 JSON 엔드포인트 (공식 Open API 없음)
- 분석: 서버 로컬에 설치·인증된 `claude` CLI를 headless(`claude --print`)로 호출

## 1. 개요

세 개의 **독립 프로세스**로 구성된다. 셋 다 같은 저장소·같은 `package.json`을 쓰지만
각각 따로 띄워야 하고, 하나가 죽어도 나머지는 계속 돈다.

| 프로세스 | 실행 명령 | 하는 일 |
| --- | --- | --- |
| Next.js 앱 | `npm start` | 물건 목록/상세 페이지 + `/api/*` 라우트. SQLite를 직접 읽고 쓴다. |
| collector 워커 | `npm run collector` | 주기적으로 법원경매정보 사이트를 긁어 `items` 테이블에 upsert 한다. |
| analyzer 워커 | `npm run analyzer` | 미분석 물건을 **HTTP API로** 가져와 `claude`를 돌리고 결과를 API로 되돌려 저장한다. |

데이터 흐름:

```
  [ courtauction.go.kr ]
            |
            |  POST /pgj/pgjsearch/searchControllerMain.on  (페이지 순회, 수 초 간격)
            v
  +---------------------+
  |  collector 워커      |   workers/collector.ts
  |  (setInterval 상주)  |   -> CourtAuctionAdapter 가 소스 JSON을 도메인 모델로 정규화
  +---------------------+
            |  upsertItems()  (better-sqlite3 직접 쓰기)
            v
      +--------------+            +------------------------+
      |   SQLite     | <--------- |  Next.js 앱 (npm start)|
      | items /      |  읽기/쓰기  |  /  , /items/[id]      | --> 웹 UI (브라우저)
      | analyses     |            |  /api/items, /api/...  |
      +--------------+            +------------------------+
            ^                            ^        |
            |                            |        | GET /api/items?analyzed=false
            | insertAnalysis()           |        v
            |                            |   +----------------------+
            +----------------------------+   |   analyzer 워커       |  workers/analyzer.ts
              POST /api/analyses              |  (setInterval 상주)   |
                                              +----------------------+
                                                       |  프롬프트 + 물건 JSON (stdin)
                                                       v
                                              +----------------------+
                                              |  claude CLI          |
                                              |  --print --output-   |
                                              |  format json         |
                                              +----------------------+
```

핵심 경계 두 가지 (`openspec/changes/archive/2026-09-07-auction-pipeline-mvp/design.md` D3/D5 —
이 change는 완료되어 archive로 이동했다, §9 참고):

- **수집 소스는 어댑터 뒤로 격리한다.** 사이트 고유 필드명(`jiwonNm`, `srnSaNo` 등)은
  `src/lib/sources/courtauction/` 밖으로 나가지 않는다. 소스를 갈아끼워도 나머지 코드는 그대로다.
- **analyzer는 DB를 직접 열지 않는다.** 서버와는 HTTP로만 통신하므로, 분석기를 다른 머신으로
  옮기거나 여러 대로 늘려도 서버 코드는 바뀌지 않는다. 대신 **서버가 떠 있어야만 분석이 돈다.**

analyzer는 한 회차에 서버를 **두 번** 조회한다: 먼저 `GET /api/items?analyzed=false`로 신규
미분석 물건을, 그다음 `GET /api/items?needsAnalysis=true&promptVersion=<현재 버전>`로 재분석
대상을 가져온다(§6 "변경 이력과 재분석" 참고). 신규 조회가 항상 먼저이고 전량 처리되므로,
재분석 대상이 아무리 쌓여도 신규 분석 물건이 뒤로 밀리지 않는다.

두 워커 모두 회차(실행 1회분)마다 자신의 실행 기록을 남긴다 — collector는 저장소 함수
(`startRun`/`finishRun`)를 직접 호출하고, analyzer는 DB를 열지 않으므로 `POST /api/worker-runs`
/ `PATCH /api/worker-runs/[id]`로 같은 기록을 남긴다. 이 기록이 `/status` 화면과 회차 조회
API의 근거다(§7 참고).

## 2. 사전 요건

| 항목 | 확인된 버전 / 조건 |
| --- | --- |
| Node.js | `v26.7.0` (개발·검증에 실제로 쓴 버전). Next.js 15.5의 `engines`는 `^18.18.0 \|\| ^19.8.0 \|\| >= 20.0.0`. |
| npm | `11.19.0` |
| `claude` CLI | `2.1.263 (Claude Code)`. **analyzer를 돌리려면 반드시 설치 + 로그인(인증)되어 있어야 한다.** |

- `claude`는 `PATH`에서 찾는다. 다른 경로에 있으면 `AUCTIONBOSS_CLAUDE_BIN`으로 지정한다.
  `claude --version`이 정상 출력되고, `claude` 계정 인증이 끝나 있어야 한다. 인증이 안 되어 있으면
  analyzer는 물건마다 `ClaudeInvocationError`를 로그로 남기고 다음 물건으로 넘어간다(워커는 죽지 않는다).
- collector/앱만 쓸 거라면 `claude` CLI는 없어도 된다.
- **`better-sqlite3`는 네이티브(C++) 모듈이다.** 다행히 13.x는 npm 패키지 안에 플랫폼별 prebuilt
  바이너리를 함께 배포한다(`node_modules/better-sqlite3/prebuilds/`: darwin-arm64/x64, linux-x64/arm64,
  linuxmusl, win32-x64/arm64). 이 목록에 있는 플랫폼이면 컴파일 없이 그대로 동작한다.
  - npm 11에서는 설치 스크립트 승인 게이트 때문에 다음 경고가 뜬다:
    `npm warn install-scripts better-sqlite3@13.0.3 (install: node-gyp rebuild)`.
    **위 prebuild가 있는 플랫폼에서는 이 경고를 무시해도 된다** — 실제로 `node-gyp rebuild`가 돌지 않고
    `build/Release/`가 없는 상태로도 정상 동작하는 것을 확인했다.
  - prebuild가 없는 플랫폼이거나 직접 컴파일해야 한다면 `npm install-scripts approve better-sqlite3` 후
    재설치하고, Xcode Command Line Tools(macOS) 또는 `build-essential`+`python3`(Linux)를 갖춰야 한다.
  - Next.js 설정(`next.config.ts`)의 `serverExternalPackages: ["better-sqlite3"]`가 이 모듈을 서버 번들에서 제외한다.

## 3. 설치 및 실행

```bash
npm install
npm run build      # Next.js 프로덕션 빌드 (타입 체크 + 린트 포함)
```

그다음 **터미널 3개를 열어 세 프로세스를 동시에** 띄운다. 순서가 중요하다.

```bash
# 터미널 1 — 웹 서버 (가장 먼저. analyzer가 이 서버에 의존한다)
npm start                      # 기본 http://localhost:3000
# 개발 중이라면 대신: npm run dev

# 터미널 2 — 수집 워커 (시작 즉시 1회 실행 후 config의 intervalMs 주기로 반복)
npm run collector

# 터미널 3 — 분석 워커 (서버가 뜬 뒤에 실행)
npm run analyzer
# 1회만 돌리고 끝내려면:
npm run analyzer -- --once
```

- 순서 이유: analyzer는 `GET /api/items?analyzed=false` → `POST /api/analyses`로만 동작한다.
  서버가 없으면 매 회차 `[analyzer] 회차 실행 실패 — AnalyzerApiError: ...`를 남기고 다음 주기를 기다린다(죽지는 않는다).
  collector는 DB에 직접 쓰므로 서버 없이도 동작하지만, 수집 결과를 보려면 결국 서버가 필요하다.
- 기본 포트 3000이 아닌 곳에 띄웠다면 analyzer에 `AUCTIONBOSS_API_BASE`를 반드시 넘겨야 한다.
  예: `PORT=3333 npm start` → `AUCTIONBOSS_API_BASE=http://localhost:3333 npm run analyzer`
- DB 파일은 첫 실행 때 자동 생성된다(기본 `<repo>/data/auctionboss.db`, WAL 모드). 별도 마이그레이션 명령이 없다 —
  연결할 때마다 `CREATE TABLE IF NOT EXISTS`가 돈다.
- 워커는 `Ctrl+C`(SIGINT)로 멈춘다. collector는 진행 중인 회차를 마치고 종료한다.

세 프로세스가 **같은 DB 파일**을 봐야 한다. 환경변수로 경로를 바꿀 때는 셋 다 같은 값을 줘야 한다.

```bash
export AUCTIONBOSS_DB=/path/to/auctionboss.db   # 세 터미널 모두에서
```

## 4. 설정

### 4.1 `config/collector.json`

```json
{
  "scope": {
    "courts": [
      { "name": "서울중앙지방법원", "courtCode": "B000210" }
    ],
    "maxCourtsPerRun": 1,
    "maxRequestsPerRun": 13
  },
  "intervalMs": 600000,
  "analysis": {
    "maxItemsPerRun": 5,
    "maxReanalysisPerRun": 2,
    "reanalysisCooldownHours": 24,
    "intervalMs": 600000
  },
  "observability": {
    "maxRunsPerWorker": 1000,
    "staleAfterIntervals": 3
  }
}
```

| 필드 | 기본값 | 의미와 바꿨을 때의 효과 |
| --- | --- | --- |
| `scope.courts[]` | 서울중앙지방법원 1곳 | 수집 대상 법원 목록. 최소 1곳 필요(빈 배열이면 시작 시 `CollectorConfigError`). **법원 수 자체는 요청량과 직결되지 않는다** — 회차당 실제로 도는 법원 수는 아래 `maxCourtsPerRun`이 정한다(로테이션, §4.1a). 법원이 늘면 대신 한 바퀴(전체 법원을 한 번씩 도는 데 걸리는 시간)가 길어진다. |
| `scope.courts[].name` | `"서울중앙지방법원"` | 법원 이름. DB `items.court`에 그대로 저장되는 값이다. |
| `scope.courts[].courtCode` | `"B000210"` | 사이트의 `cortOfcCd`. 빈 문자열이면 어댑터가 `name`으로 `src/lib/sources/courtauction/courts.ts`의 60개 코드표에서 찾는다. 다른 법원 코드는 그 파일 참조. |
| `scope.maxCourtsPerRun` | `1` | 회차당 처리할 법원 수 상한(§4.1a). 법원이 이 값보다 많으면 회차마다 일부만 돌고 다음 회차가 이어서 처리한다(원형 로테이션). 법원 1곳이면 이 값과 무관하게 매 회차 그 법원만 돈다(이 설정 도입 전과 동일, 회귀 보장). |
| `scope.maxRequestsPerRun` | `13` | 회차당 요청 수 **안전장치**(§4.1a, §8). `maxCourtsPerRun`을 대신하는 값이 아니라 보조 장치다 — 이미 시작한 법원의 수집은 절대 끊지 않되, 이 값을 넘으면 그 회차에서 **다음** 법원을 새로 시작하지 않는다(법원을 중간에 끊으면 "물건이 줄었다"로 오해될 수 있어서다). 기본값 13은 서울중앙지방법원 1곳·매각기일 60일 범위 기준 실측 요청 수(§7.3, §8)에 맞춘 것이지, 여러 법원에서 안전하다고 검증된 값이 아니다. |
| `intervalMs` | `600000` (10분) | collector 수집 주기. **늘리는 것이 안전한 방향이다** — §8 참고. 이전 회차가 아직 안 끝났으면 이번 tick은 건너뛴다(중첩 실행 없음). |
| `analysis.maxItemsPerRun` | `5` | analyzer 한 회차에 분석할 최대 **신규** 물건 수(아직 분석 결과가 하나도 없는 물건). Claude 호출 비용의 상한이다. 올리면 회차당 비용과 소요 시간이 비례해 늘어난다(호출은 순차 실행). |
| `analysis.maxReanalysisPerRun` | `2` | analyzer 한 회차에 재분석할 최대 물건 수(§6 참고). `maxItemsPerRun`과는 **독립된 별도 한도**다 — 회차당 총 Claude 호출 수 상한은 두 값의 **합**(`maxItemsPerRun + maxReanalysisPerRun`, 기본 5+2=7)이지, 하나의 한도를 나눠 쓰는 게 아니다. |
| `analysis.reanalysisCooldownHours` | `24` | 재분석 쿨다운(시간). 물건의 최신 분석이 이 시간 이내면 감시 필드가 다시 바뀌어도 재분석 대상에서 제외한다. 정수(0 이상), 소수·음수·누락은 다른 `analysis` 필드와 똑같이 시작 시 `CollectorConfigError`로 죽는다. 0을 주면 쿨다운이 완전히 꺼진다(이전 동작과 동일) — **왜 이 필드가 필요한지는 §6.2의 "왜 쿨다운이 필요한가" 문단을 반드시 읽을 것.** |
| `analysis.intervalMs` | `600000` (10분) | analyzer 주기. 신규 미분석 물건도 재분석 대상도 없으면 `[analyzer] 미분석 물건도 재분석 대상도 없음`만 찍고 아무것도 호출하지 않는다. |
| `observability.maxRunsPerWorker` | `1000` | 워커별(`collector`/`analyzer` 각각) `worker_runs` 보관 상한(건수). 새 회차를 기록할 때마다 이 값을 넘는 오래된 행을 지운다(`src/lib/db/worker-runs.ts`의 `prune`). 10분 주기면 하루 144행이 쌓이므로 상한이 없으면 기록이 무한정 불어난다 — 기본값 1000은 약 7일치다. 올리면 `/status`·`GET /api/worker-runs`에서 더 긴 이력을 볼 수 있지만 DB 파일이 그만큼 커진다. |
| `observability.staleAfterIntervals` | `3` | 워커 상태를 `stale`(미실행)로 판정하는 배수. 마지막 성공(또는 마지막 기록)이 `기대 주기 × 이 값`보다 오래되면 `stale`이 된다(기대 주기는 collector면 `intervalMs`, analyzer면 `analysis.intervalMs`). 값을 낮추면 워커가 죽었을 때 더 빨리 `stale`로 잡히지만, 회차 소요 시간이 주기에 가까운 상황에서는 정상 실행 중에도 오탐할 수 있다(design.md Open Questions — 이 배수가 적절한지는 아직 실측으로 검증되지 않았다). |

설정이 없거나 JSON이 깨졌거나 스키마에 안 맞으면 **기본값으로 조용히 넘어가지 않고 즉시 종료한다**
(수집 범위가 의도와 다르게 도는 것이 더 나쁘다는 판단). 로딩은 프로세스 수명 동안 캐시되므로
설정을 고쳤으면 워커를 재시작해야 한다.

### 4.1a 법원 추가하기 · 로테이션 · 신선도 트레이드오프

(`openspec/changes/scale-collection-scheduling/design.md`)

**법원을 추가하는 법:**

1. `config/collector.json`의 `scope.courts` 배열에 `{ "name": "...", "courtCode": "..." }`
   항목을 추가한다. `courtCode`(사이트의 `cortOfcCd`)는
   `src/lib/sources/courtauction/courts.ts`의 60개 코드표에서 찾는다 — 빈 문자열로 둬도
   되지만(어댑터가 `name`으로 그 표를 찾아준다), 코드표에 없는 이름이면 수집이 그 법원에서
   실패한다.
2. `scope.maxCourtsPerRun`은 보통 그대로(기본 1) 둔다 — 법원이 늘어도 회차당 상한은 자동으로
   나머지 법원을 다음 회차로 넘긴다. 회차당 더 많은 법원을 한 번에 처리하고 싶을 때만(그만큼
   회차당 요청도 늘어난다) 이 값을 올린다.
3. 설정은 프로세스 수명 동안 캐시되므로 collector 워커를 재시작해야 반영된다(§3, §4.1).

**로테이션이 도는 방식(design.md D2/D3):** 법원 목록을 원형으로 보고, 저장된 위치(법원의
`courtCode` — 목록 순번이 아니다, `collector_state` 테이블)부터 `maxCourtsPerRun`개를 그 회차가
처리한 뒤 다음 시작 위치를 저장한다. 저장된 코드가 목록에 없으면(법원을 지웠거나 재정렬한
직후) 처음부터 다시 돈다 — 엉뚱한 법원을 계속 건너뛰는 대신 스스로 복구된다. 법원이 1곳뿐이면
이 값과 무관하게 매 회차 그 법원만 도므로 **이 기능 도입 전과 완전히 동일하게 동작한다.**

**⚠️ 트레이드오프 — 법원을 늘리면 개별 법원의 신선도가 나빠진다.** 회차당 예산은 요청 수가
아니라 **법원 수**로 잡혀 있다(`maxCourtsPerRun`) — 한 법원의 페이지 수는 요청을 보내보기
전에는 모르므로, 요청 수로 예산을 잘랐다가는 법원이 페이지 중간에서 잘려 "물건이 줄었다"로
오인될 수 있기 때문이다. 그 결과 **법원 한 곳이 다시 수집되기까지 걸리는 시간(한 바퀴)**이
`ceil(법원 수 / maxCourtsPerRun) × intervalMs`로 늘어난다. 예를 들어 기본값(`intervalMs`
10분, `maxCourtsPerRun` 1)에서 법원이 1곳이면 한 바퀴가 10분이지만, 법원을 10곳으로 늘리면
한 바퀴가 100분(1시간 40분)으로 늘어난다 — 즉 어떤 법원의 특정 물건이 수집 시점 기준 최대
100분 묵은 정보일 수 있다는 뜻이다. 이 값(한 바퀴 소요 시간)과 현재 로테이션이 어느 법원을
가리키고 있는지는 `/status` 화면에 항상 표시된다(§7.1) — **법원을 늘리는 대가를 숨기지 않고
바로 눈에 보이게 하는 것이 이 기능의 설계 목적이다.**

**⚠️ 여러 법원에서 안전한 요청 예산은 아직 실측되지 않았다.** `maxRequestsPerRun`(기본 13)의
기본값은 서울중앙지방법원 1곳 기준 실측(§7.3, §8)에서 나온 수치이지, 법원을 여러 곳 돌렸을 때도
안전하다고 검증된 값이 아니다 — §8의 "요청량이 임계에 가깝다"는 결론이 이 change 이후에도
그대로 유지된다. `pagesRequested`(§7.3)가 회차마다 실측값으로 남으므로, 법원을 늘린 뒤에는
`GET /api/worker-runs`로 **며칠치 회차 기록을 관측**해 실제 요청 수·차단 여부를 보고 예산을
조정해야 한다 — 추측이 아니라 그 기록이 쌓여야 정할 수 있다.

### 4.2 환경 변수

전부 선택 사항이다. 값이 있으면 `config/collector.json`보다 **우선**한다
(설정 파일을 건드리지 않고 일회성 실행·검증을 하기 위한 장치).

| 변수 | 적용 프로세스 | 기본값 | 용도 |
| --- | --- | --- | --- |
| `AUCTIONBOSS_DB` | 앱, collector | `<cwd>/data/auctionboss.db` | SQLite 파일 경로. 상대 경로면 cwd 기준으로 절대화된다. `:memory:`도 받는다(테스트용). |
| `AUCTIONBOSS_CONFIG` | collector, analyzer | `<cwd>/config/collector.json` | 설정 파일 경로. `loadCollectorConfig()`를 호출하는 두 워커만 읽는다 — Next.js 앱은 `config/collector.json`을 아예 import하지 않는다(`src/lib/domain/config.ts` 사용처는 `workers/collector.ts`, `workers/analyzer.ts`뿐). |
| `AUCTIONBOSS_COLLECT_INTERVAL_MS` | collector | `config.intervalMs` | 수집 주기(ms). 양의 정수. |
| `AUCTIONBOSS_COLLECT_BACKOFF_MS` | collector | `3600000` (1시간) | 로봇탐지 차단 감지 시 tick을 건너뛸 시간(ms). |
| `AUCTIONBOSS_COLLECT_PAGE_SIZE` | collector | `40` | 한 요청으로 가져올 **행** 수. **40이 서버 상한이고, 넘기면 경고 후 40으로 클램프된다**(§8). |
| `AUCTIONBOSS_COLLECT_PAGE_DELAY_MS` | collector | `5000` | 페이지 사이 대기(ms). 줄이면 차단 위험이 커진다. |
| `AUCTIONBOSS_COLLECT_BID_WINDOW_DAYS` | collector | `60` | 매각기일 조회 범위(오늘 ~ 오늘+N일). 줄이면 대상 행 수와 요청 횟수가 함께 줄어든다. |
| `AUCTIONBOSS_COLLECT_MAX_PAGES` | collector | `50` | 폭주 방지용 페이지 상한. 여기 걸리면 경고 로그를 남기고 그 회차를 중단한다. |
| `AUCTIONBOSS_API_BASE` | analyzer | `http://localhost:3000` | 서버 주소. 서버 포트를 바꿨으면 필수. |
| `AUCTIONBOSS_ANALYZE_MAX` | analyzer | `config.analysis.maxItemsPerRun` (5) | 회차당 최대 **신규** 분석 건수. |
| `AUCTIONBOSS_ANALYZE_REANALYZE_MAX` | analyzer | `config.analysis.maxReanalysisPerRun` (2) | 회차당 최대 **재분석** 건수. `AUCTIONBOSS_ANALYZE_MAX`와 독립이며, 총 호출 수 상한은 두 값의 합이다(§6). |
| `AUCTIONBOSS_ANALYZE_INTERVAL_MS` | analyzer | `config.analysis.intervalMs` (600000) | 분석 주기(ms). |
| `AUCTIONBOSS_ANALYZE_MODEL` | analyzer | 없음(= CLI 기본 모델) | `claude --model`로 넘길 값. 예: `sonnet`, `haiku`. |
| `AUCTIONBOSS_ANALYZE_TIMEOUT_MS` | analyzer | `120000` (2분) | `claude` 호출 1건 타임아웃. 넘기면 SIGKILL 후 그 물건만 실패 처리. |
| `AUCTIONBOSS_ANALYZE_PROMPT` | analyzer | `<cwd>/workers/prompts/analyze-item.md` | 프롬프트 템플릿 경로. 템플릿에 `{{ITEM_JSON}}` 토큰이 없으면 시작 시 오류. |
| `AUCTIONBOSS_CLAUDE_BIN` | analyzer | `claude` | CLI 실행 파일 경로/이름. |
| `PORT` | 앱 | `3000` | Next.js 서버 포트(Next.js 표준 변수). |

숫자형 변수에 0·음수·비숫자를 넣으면 조용히 무시하지 않고 **즉시 오류로 죽는다.**

`claude` 호출은 이 저장소의 설정을 물려받지 않도록 격리해서 실행한다:
`--strict-mcp-config`, `--setting-sources ""`, `--tools ""`, `--permission-prompts none`,
`--no-session-persistence`, 그리고 저장소 밖 임시 디렉터리를 cwd로 쓴다
(`workers/lib/claude.ts`). 분석 결과가 환경에 따라 달라지거나 CLI가 파일을 건드리는 일을 막기 위함이다.

## 5. API

여덟 개다(`find src/app/api -name route.ts` 기준: `/api/items`, `/api/items/[id]`,
`/api/items/[id]/changes`, `/api/items/usage-types`, `/api/analyses`, `/api/worker-runs`,
`/api/worker-runs/[id]`, `/api/worker-runs/summary`). analyzer는 이 중 `GET /api/items`
(§1의 두 단계 조회에 각각 한 번씩), `POST /api/analyses`, 그리고 회차 기록용
`POST /api/worker-runs` / `PATCH /api/worker-runs/[id]`를 계약으로 쓰므로 응답 형태를
임의로 바꾸면 안 된다 — 나머지(`/api/items/[id]`, `.../changes`, `.../usage-types`,
`GET /api/worker-runs`, `.../summary`)는 웹 UI(목록/상세, `/status`) 전용이라 analyzer와
무관하다.

add-bookmarks-and-feed change가 관심 물건·변동 피드용 엔드포인트 여섯 개를 더 추가했다
(`/api/bookmarks`, `/api/bookmarks/[itemId]`, `/api/bookmarks/toggle`, `/api/feed`,
`/api/feed/read`, `/api/feed/mark-read` — 이 절 뒤쪽에 별도로 설명한다). analyzer/collector는
이 엔드포인트들을 쓰지 않는다 — 전부 웹 UI(`/`, `/items/[id]`, `/bookmarks`, `/feed`) 전용이다.

### `GET /api/items` — 물건 목록

이 표는 `src/lib/domain/item-query.ts`의 `ITEM_QUERY_PARAMS`와 zod 스키마(`itemQueryParamsSchema`)를
기준으로 한다 — 이 파일에 없는 파라미터 이름은 API가 조용히 무시한다(모르는 파라미터 이름은
오류가 아니다).

| 쿼리 파라미터 | 타입 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `page` | 정수 ≥ 1 | `1` | 페이지 번호 |
| `pageSize` | 정수 1~200 | `20`(`DEFAULT_PAGE_SIZE`) | 페이지 크기. 200 초과는 400. |
| `analyzed` | `true` \| `false` | (없음 = 전체) | 분석 결과 유무 필터. analyzer의 1단계(신규 분석)가 `analyzed=false`를 쓴다. **이 필터의 의미는 재분석 기능이 생긴 뒤에도 바뀌지 않았다** — "분석 결과가 하나도 없는 물건"만 뜻하며, 이미 분석됐지만 재분석이 필요한 물건은 포함하지 않는다. |
| `needsAnalysis` | `true` | (없음) | 재분석 대상 필터(§6.2 참고). `true`만 지원한다(`false`는 지원하지 않음 — 400). **반드시 `promptVersion`과 함께 와야 하며, 혼자 오면 400이다.** analyzer의 2단계(재분석)가 쓴다. **이 필터가 걸리면 정렬이 강제로 바뀐다 — 아래 "정렬" 문단 참고.** |
| `promptVersion` | 문자열(비어 있지 않음) | (없음) | `needsAnalysis=true`의 판정 기준이 되는 "호출자의 현재 프롬프트 버전". `needsAnalysis` 없이 혼자 오면 아무것도 좁히지 않는다(무시된다). |
| `usage` | 문자열, **반복 파라미터** | (없음 = 전체) | 용도(`usageType`) 필터. 하나라도 일치하면 통과(OR). **토큰 단위로 매칭한다(ux-overhaul-phase2, 계약 변경)** — 저장된 값이 복합 문자열(`"상가,오피스텔,근린시설"`)이면 쉼표로 나눈 개별 토큰 중 하나만 같아도 통과한다. 예전에는 복합 문자열 전체와 정확히 같아야만 통과했다(그래서 `"상가,오피스텔,근린시설"` 물건 115건이 `usage=오피스텔`에서 전부 빠졌다) — 이제는 같은 요청이 그 물건들도 포함한다. 앞뒤에 `,` 구분자를 붙여 비교해 `"오피스텔형"` 같은 부분 문자열 오탐은 피한다. **`usage=a&usage=b`처럼 이름을 반복해서 보낸다 — 쉼표로 합쳐 보내면 안 된다**(용도 문자열 자체에 쉼표가 들어 있다, `src/lib/sources/courtauction/NOTES.md` §8). 최대 `MAX_USAGE_TYPES`(50)개, 초과 시 400. |
| `sido` | 문자열, **반복 파라미터** | (없음 = 전체) | 시/도(`sido`) 필터. 저장된 값과 정확히 일치해야 한다(구조화 컬럼이라 `usage`와 달리 복합 문자열이 아니다). `usage`와 같은 반복 파라미터 인코딩. 최대 `MAX_REGION_VALUES`(50)개. |
| `sigungu` | 문자열, **반복 파라미터** | (없음 = 전체) | 시/군/구(`sigungu`) 필터. `sido`와 같은 규칙. `dong`(읍/면/동)은 아직 지원하지 않는다(관악구만 동이 수십 개라 체크박스가 감당하지 못한다 — 지역을 좁힌 뒤 필요해지면 추가한다). |
| `minPrice` | 정수 ≥ 0(원) | (없음) | 최저매각가격(`minBidPrice`) 하한, 포함. 값이 `NULL`인 물건은 제외된다. 합산된 유효 하한이 `maxPrice`(또는 `maxEok`/`maxMan` 합산값)보다 크면 400. |
| `maxPrice` | 정수 ≥ 0(원) | (없음) | 최저매각가격 상한, 포함. |
| `minEok`/`minMan`, `maxEok`/`maxMan` | 정수 ≥ 0 | (없음) | **억/만원 단위 입력**(ux-overhaul-phase2). 사람이 억/만원으로 입력하면 서버가 `eok*1억 + man*1만원`으로 합산해 `minPrice`/`maxPrice`와 똑같이 다룬다 — API가 실제로 받는 값은 여전히 원 정수다(워커 계약·기존 400 동작 불변). 한쪽만 와도 나머지는 0으로 본다. **우선순위: 같은 요청에 `minPrice`(원 단위)와 `minEok`/`minMan`이 동시에 오면 `minPrice`가 이긴다** — `maxPrice`/`maxEok`/`maxMan`도 대칭. 이미 계약·테스트로 고정된 원 단위 필드가 새로 추가된 사람 편의용 필드 때문에 흔들리면 안 된다는 판단이다(design.md D3). 자주 쓰는 가격대(`1억 이하`/`1~3억`/`3~5억`/`5~10억`/`10억+`)는 화면에 프리셋 링크로 제공되며, 이미 계산된 `minPrice`/`maxPrice`(원 단위) 값을 URL에 직접 담는 단순 링크다. |
| `minFailed` | 정수 ≥ 0 | (없음) | 유찰횟수(`failedBidCount`) 하한, 포함. 값이 `NULL`인 물건은 제외된다. |
| `q` | 문자열(비어 있지 않음) | (없음) | 소재지(`address`) 부분 일치 키워드(`LIKE`, 대소문자·특수문자 이스케이프 처리). |
| `dateFrom` | `YYYY-MM-DD` | (없음) | 매각기일(`auctionDate`) 하한, 포함. 값이 `NULL`인 물건은 제외된다. `dateTo`보다 늦으면 둘 다 400. |
| `dateTo` | `YYYY-MM-DD` | (없음) | 매각기일 상한, 포함. |
| `excludePast` | `true` | (없음) | **지난 기일 제외 — opt-in 전용이다.** `true`만 지원한다(다른 값은 400). 오늘(한국 시간) 이후 매각기일만 남긴다(당일 포함, 경계 포함). **기본값이 아니다** — 이 필터를 기본으로 켜면 실데이터 기준 121건(31%)이 조용히 사라진다. |
| `bookmarked` | `true` \| `false` | (없음 = 전체) | 관심 물건 필터. `true`=관심만, `false`=관심 제외. 목록 행의 관심 표시(스칼라 서브쿼리, `bookmarked` 필드)와는 별개의 `WHERE` 조건이라 그 표시 컬럼의 "필터·정렬·total에 영향 없음" 보장은 그대로 유지된다. |
| `sort` | `auctionDate` \| `minBidPrice` \| `bidRatio` \| `failedBidCount` \| `pricePerArea` | `auctionDate`(`DEFAULT_SORT_KEY`) | 정렬 기준. `bidRatio`는 최저매각가격/감정가 비율. `pricePerArea`(ux-overhaul-phase2)는 최저매각가격/면적(㎡) — 면적이 없어 계산할 수 없는 물건은 방향과 무관하게 뒤로 간다(`bidRatio`와 같은 NULL 규칙). |
| `dir` | `asc` \| `desc` | `asc`(`DEFAULT_SORT_DIRECTION`) | 정렬 방향. 값이 없는(`NULL`) 물건은 방향과 무관하게 항상 뒤로 간다. |

정렬은 기본적으로 매각기일 오름차순이며(값이 없는 물건은 뒤로) `sort`/`dir`로 바꿀 수 있다.
**단, `needsAnalysis=true`가 걸린 조회는 정렬이 "가장 오래전에 분석된 물건 우선"(`analyzed_at ASC`,
§6.2)으로 하드코딩되어 있고, 이때는 `sort`/`dir`를 함께 보내도 조용히 무시된다** — analyzer가
재분석 대상을 뽑을 때 오래된 것부터 소진하도록 저장소(`src/lib/db/repository.ts`의
`listItems`)가 강제하는 동작이다(`orderByClause` 대신 `NEEDS_ANALYSIS_ORDER` 상수를 쓴다).
잘못된 파라미터는 보정하지 않고 **400**으로 거절한다.

```jsonc
// 200 OK
{
  "items": [
    {
      "id": 1,
      "court": "서울중앙지방법원",
      "caseNo": "2011타경28497",
      "itemNo": "1",
      "address": "서울특별시 성북구 정릉동 1032 ...",
      "usageType": "아파트",
      "appraisalPrice": 711000000,   // 원(정수) 또는 null
      "minBidPrice": 711000000,
      "auctionDate": "2026-09-08",   // YYYY-MM-DD 또는 null
      "failedBidCount": 1,
      "status": "유찰 1회",           // 유찰횟수에서 파생한 값 ("신건" | "유찰 N회")
      "firstSeenAt": "2026-09-06T06:55:48.709Z",
      "lastSeenAt": "2026-09-06T06:55:48.709Z",
      "lastChangedAt": "2026-09-06T07:05:12.000Z", // 감시 필드의 가장 최근 "실제" 변경 시각.
                                                     // 기준점(최초 저장)은 세지 않는다. 변경이
                                                     // 한 번도 없으면 null(§6 참고).
      // 아래는 확장 필드 32개 중 일부 발췌 — 전체 목록은 바로 다음 "확장 필드" 문단 참고.
      // 전부 nullable이고, 이 기능 이전에 수집된 물건은 다음 수집 전까지 전부 null이다.
      "minArea": 84,                                // ㎡. 0은 "값 없음"으로 이미 null 처리됨(D3)
      "buildingDescription": "철근콘크리트구조\n84.99㎡",  // 줄바꿈 그대로 보존
      "minBidPriceRound1": 711000000,
      "usageCodeLarge": "20000"                     // 코드표 미확인 — 원문 그대로, 해석하지 않음
    }
  ],
  "total": 8,
  "page": 1,
  "pageSize": 20
}
```

### 확장 필드 (enrich-item-fields, 2026-09-08)

목록/상세 응답의 물건 객체에는 위 기본 필드 외에 **확장 필드 32개**가 함께 들어 있다
(`src/lib/domain/types.ts`의 `AuctionItem`, 전부 `nullable`). 소스가 이미 내려주고 있었지만
지금까지는 zod 스키마가 선언하지 않아 파싱 단계에서 버려지던 값들이다 — **추가 수집 요청은
0건**이다(`NOTES.md` §11). 값이 없으면(소스가 `""`/`"0"`을 보낸 경우 등) `null`이지 `0`이
아니다 — 가격·면적 도메인에서 `0`은 실제 값이 아니라 "값 없음"이기 때문이다(design.md D3).
의미를 확인하지 못한 코드값(용도 코드, 진행상태 코드, 좌표)은 해석하지 않고 원문 문자열
그대로 저장한다(design.md D4) — 화면에도 코드값 그대로 노출하거나 아예 표시하지 않는다.

카테고리별로 묶으면 다음과 같다(소스 필드명·전체 매핑표는 `src/lib/sources/courtauction/NOTES.md`
§11 참고):

| 카테고리 | 필드 | 비고 |
| --- | --- | --- |
| 면적·건물구조 | `minArea`, `maxArea`, `buildingDescription` | `buildingDescription`은 줄바꿈 포함 원문(예: `"철근콘크리트구조\n84.99㎡"`) |
| 차수별 최저가 | `minBidPriceRound1`~`Round4`, `minBidPriceRateRound1`~`Round2` | 소스가 고정 4개 슬롯으로 준다(1~2차만 저감률도 옴). 값 없는 회차는 그냥 없는 것으로 표시(빈 행 생성 안 함) |
| 용도 분류 코드 (원문, 미해석) | `usageCodeLarge`, `usageCodeMedium`, `usageCodeSmall` | 코드표를 찾지 못했다(`UNVERIFIED`) — 라벨을 붙이지 않는다 |
| 구조화된 소재지 | `sido`, `sigungu`, `dong`, `lotNumber`, `buildingName`, `buildingUnit` | 조합 문자열인 `address`만으로는 안 나오는 동/층/호 단위 값 |
| 좌표 (원문, 미사용) | `coordinateX`, `coordinateY`, `coordinateLevel` | 좌표계(EPSG)를 확인하지 못해 저장만 하고 지도 등에는 쓰지 않는다 |
| 매각기일 상세 | `auctionTime`, `auctionPlace`, `auctionDecisionDate`, `auctionRound` | `auctionTime`은 콜론 없는 `HHmm` 문자열(예: `"1000"` = 10:00) |
| 사건 비고·중복/병합사건 | `note`, `duplicateCaseNo`, `mergedCaseNo` | `note`에 `"일괄매각"`이 들어 있으면 목적물이 여럿인 물건이라는 뜻 |
| 담당계·연락처 | `courtDepartment`, `courtPhone` | |
| 진행상태 코드 (원문, 미해석) | `statusCode`, `itemStatusCode` | 화면의 "진행상태"(`status`)는 이 코드가 아니라 `failedBidCount`에서 파생한다 — 이 두 코드는 의미를 모른다 |

물건 상세 페이지(`/items/[id]`)의 "확장 정보" 카드가 위 카테고리 그대로의 섹션으로
나눠 보여주며, 면적당 가격(`minBidPrice ÷ minArea`)처럼 확장 필드로 새로 계산 가능해진
값도 함께 표시한다(`src/app/_lib/item-extensions.ts`).

**⚠️ 이 소스로 얻을 수 없는 것 — 분석 품질의 하드 한계.** 권리관계·임차인·등기 정보(전입세대,
확정일자, 근저당·가압류 등 선순위 채권, 말소기준권리)는 **이 소스 API 자체에 존재하지
않는다**(`NOTES.md` §10.3, 상세 화면정의 XML 전체에 관련 필드가 하나도 없음을 확인한
`CONFIRMED` 사실 — 추측이 아니다). 경매 판단의 핵심인 권리분석 데이터를 이 프로젝트의
분석은 애초에 볼 수 없다는 뜻이다. AI 분석 프롬프트(§6.2, `workers/prompts/analyze-item.md`)도
이 사실을 "이번에 주어지지 않았다"가 아니라 "이 소스에 존재하지 않는다"로 모델에 명시해
모델이 그 공백을 추론으로 메우지 못하게 한다 — 그래도 **분석 결과를 신뢰의 근거로 쓰기 전에
사람이 반드시 알아야 하는 상한선**이다. 입찰 전 권리분석·현장조사는 이 서비스가 대신할 수
없다.

**⚠️ 비용 영향 — `PROMPT_VERSION` v2.** 이 확장 필드들을 분석에 실제로 활용하도록(면적당
가격, 차수별 저감 추이, 일괄매각 여부) 프롬프트를 v2로 올렸다(`workers/lib/prompt.ts`). §6.2가
이미 설명하듯, 프롬프트 버전을 올리면 **이미 분석이 끝난 물건 전부**가 재분석 후보가 된다
(조건 3: 저장된 분석의 `promptVersion`이 현재 버전과 다름). 즉 이 change를 배포하는 순간
그동안 쌓인 분석 전량이 재분석 대상으로 잡힌다는 뜻이다. 총 비용 자체는 줄지 않지만
`maxReanalysisPerRun`(기본 2건/회차)과 `reanalysisCooldownHours`(기본 24시간)가 **소진
속도**를 제한한다 — 물건 수백 건이면 여러 회차·여러 시간에 걸쳐 서서히 빠진다. 급하게
소진하려면 `AUCTIONBOSS_ANALYZE_REANALYZE_MAX`를 일시적으로 올린다(§4.2, §6.2 "비용 경고"
문단 참고).

### `GET /api/items/[id]` — 물건 1건 + 최신 분석

- `id`가 숫자가 아니거나 없는 물건이면 **404**.

```jsonc
// 200 OK
{
  "item": { /* 위와 같은 물건 객체 */ },
  "analysis": {                 // 분석이 아직 없으면 null. 분석이 여러 건 쌓였어도 항상 최신 1건만.
    "id": 1,
    "itemId": 1,
    "body": "**요약 평가** — ...",   // markdown 원문
    "model": "claude-sonnet-5",      // CLI 출력에서 못 알아내면 null
    "promptVersion": "v1",
    "analyzedAt": "2026-09-06T06:56:57.086Z"
  }
}
```

이전 분석 이력은 이 엔드포인트가 아니라 물건 상세 페이지(`/items/[id]`)가 서버 컴포넌트
안에서 `listAnalyses(itemId, { limit })`로 직접 읽어 렌더링한다 — 이력 전용 API는 없다.

**단, 상세 페이지는 본문을 무제한으로 그리지 않는다.** `src/app/items/[id]/page.tsx`의
`MAX_ANALYSES_FETCHED`(11 = 최신 1건 + 이전 10건)만큼만 `listAnalyses`로 가져와 본문을
렌더링하고, 실제 전체 건수는 `countAnalyses(itemId)`로 별도 조회해 "이전 분석 N건 보기"
표제와 "그 외 M건은 표시하지 않습니다" 문구에 쓴다 — 표제의 숫자(전체 건수)와 실제로
펼쳐서 볼 수 있는 건수(최대 10건)가 다를 수 있다는 뜻이다. 이 한도가 없으면, §6.2에서
설명한 것처럼 감시 필드가 회차마다 뒤집히는 물건 하나가 재분석을 수백 건 쌓아 상세
페이지 하나가 수 MB의 markdown 본문을 그대로 안게 된다.

### `GET /api/items/[id]/changes` — 물건 변경 이력

물건의 감시 대상 필드(최저매각가격, 유찰횟수, 매각기일, 진행상태) 변경 이력을 시간순으로
전부 반환한다.

- 없는 `id`(숫자가 아니거나 물건이 없음)면 **404**.
- **`changes`는 필터링되지 않는다 — 최초 저장 시의 기준점 행(baseline)도 그대로 포함된
  전체 이력이다.** 물건이 처음 수집될 때 감시 대상 필드(값이 `NULL`이 아닌 것)마다
  `kind: "baseline"`인 기준점 행이 만들어지고(§6.1 D2), 이후 실제 값이 바뀔 때마다
  `kind: "change"`인 행이 추가된다. 두 종류가 같은 배열에 시간순으로 섞여서 나온다 —
  **`"changes": []`는 감시 필드가 전부 `NULL`인 물건에서만 나온다(진짜 빈 이력)**. 두 번
  수집된 보통 물건이면 감시 필드 4개의 기준점 4행 + 실제 변경 수만큼이 반환된다(예:
  `src/app/api/items/[id]/changes/__tests__/route.test.ts`는 최초 수집 1회 + 실제 변경
  1회 뒤 **6건**(기준점 4 + 변경 2)을 기대한다).
  **클라이언트가 "진짜 변경"만 보고 싶으면 `kind === "change"`인 행만 걸러야 한다**
  (`src/app/_lib/change-history.ts`의 `isRealChange`가 하는 일과 같다) — **`oldValue !== null`로
  거르던 예전 방식은 버그였다.** `NULL`이던 필드에 값이 처음 생기는 것(예: 비어 있던
  매각기일이 잡히는 경우, 또는 소스 글리치로 지워졌던 값이 복구되는 경우)도 엄연히 "실제
  변경"이지만, 저장소는 기준점 행을 만들 때와 똑같이 `oldValue: null`로 기록한다 — 그래서
  `oldValue`의 null 여부만으로는 이 둘을 구별할 수 없다. 예전 방식(`oldValue IS NULL` =
  기준점)에서는 이런 변경이 기준점과 섞여 상세 페이지의 변경 이력 카드, 목록의 "최근 변동"
  배지, 재분석 대상 판정(§6.2) 세 곳 모두에서 통째로 사라졌다. `kind`는 저장소가 기록
  시점에 이 둘을 애초에 다른 값(`"baseline"`/`"change"`)으로 남기므로, 조회 시점에는
  `oldValue`를 해석할 필요 없이 `kind`만 보면 된다.

```jsonc
// 200 OK — 두 번 수집된 물건의 실제 응답 예 (baseline 4건 + 실제 변경 2건)
{
  "changes": [
    { "id": 1, "itemId": 1, "field": "minBidPrice", "oldValue": null, "newValue": "400000000",
      "changedAt": "2026-01-01T00:00:00.000Z", "kind": "baseline" },
    { "id": 2, "itemId": 1, "field": "failedBidCount", "oldValue": null, "newValue": "1",
      "changedAt": "2026-01-01T00:00:00.000Z", "kind": "baseline" },
    { "id": 3, "itemId": 1, "field": "auctionDate", "oldValue": null, "newValue": "2026-10-01",
      "changedAt": "2026-01-01T00:00:00.000Z", "kind": "baseline" },
    { "id": 4, "itemId": 1, "field": "status", "oldValue": null, "newValue": "진행",
      "changedAt": "2026-01-01T00:00:00.000Z", "kind": "baseline" },
    { "id": 5, "itemId": 1, "field": "minBidPrice",       // WatchedField: minBidPrice | failedBidCount | auctionDate | status
      "oldValue": "400000000",      // 문자열로 저장된다(§6.1 참고).
      "newValue": "300000000",
      "changedAt": "2026-01-02T00:00:00.000Z", "kind": "change" },
    { "id": 6, "itemId": 1, "field": "failedBidCount", "oldValue": "1", "newValue": "2",
      "changedAt": "2026-01-02T00:00:00.000Z", "kind": "change" }
  ]
}
```

- **`kind`는 `"baseline" | "change"`다** — 기준점/실제 변경을 구별하는 유일한 마커이며,
  `oldValue`의 null 여부와는 별개다(위 설명 참고). 응답 행의 필드 집합은 항상
  `{ id, itemId, field, oldValue, newValue, changedAt, kind }`다.

### `GET /api/items/usage-types` — 저장된 용도 목록

`src/app/api/items/usage-types/route.ts`. 목록 페이지의 용도 필터 체크박스가 어떤 값을
보여줄지 저장된 데이터에서 직접 뽑아 쓴다(고정 목록이 아니다) — `GET /api/items`의
`usage` 파라미터에 넣을 수 있는 값의 출처이기도 하다.

**ux-overhaul-phase2부터 복합 문자열을 쉼표로 쪼갠 개별 토큰을 돌려준다** — 저장된
`usage_type`이 `"상가,오피스텔,근린시설"`이면 원본 문자열이 아니라 `"상가"`/`"오피스텔"`/
`"근린시설"` 세 개의 토큰이 각각 목록에 들어간다(중복 제거). `usage` 파라미터의 토큰
매칭 규칙과 짝을 이룬다(위 §5 표 참고) — 선택지와 매칭 규칙이 같은 단위를 쓰지 않으면
체크박스로 고른 값이 매칭에 안 걸리는 모순이 생긴다.

```jsonc
// 200 OK
{ "usageTypes": ["근린시설", "상가", "아파트", "오피스텔"] }
```

- 물건이 하나도 없으면 빈 배열(오류 아님).
- 정적 경로(`usage-types`)가 동적 경로(`[id]`)보다 먼저 매칭되므로 `/api/items/usage-types`가
  `/api/items/[id]`의 `id="usage-types"` 요청으로 잘못 해석되지 않는다(Next.js App Router의
  기본 라우팅 규칙).

### `POST /api/analyses` — 분석 결과 저장

```jsonc
// 요청 본문 (application/json)
{
  "itemId": 1,            // 정수 ≥ 1, 필수
  "body": "...",          // 비어 있지 않은 문자열, 필수
  "promptVersion": "v1",  // 비어 있지 않은 문자열, 필수
  "model": "claude-sonnet-5"  // 선택. 생략하면 null로 저장
}
```

- 성공: **201** + 저장된 분석 객체(위 `analysis`와 같은 형태)
- 본문 형식 오류: **400** (`{ error, details: [{ field, message }] }`)
- 존재하지 않는 `itemId`: **404** (저장하지 않는다)

물건당 분석은 여러 건 쌓일 수 있고(재분석은 새 행을 추가할 뿐 이전 분석을 지우지 않는다),
조회는 항상 최신 1건을 돌려준다.

### `GET /api/worker-runs` — 회차 기록 목록

`src/app/api/worker-runs/route.ts`. 워커의 실행 회차(run)를 최신순으로 조회한다
(§7 "워커 상태 관측" 참고). 파라미터 검증은 `src/app/_lib/worker-run-query.ts`가 한다 —
인식되는 이름에 잘못된 값이 오면(오탈자, 범위 밖 숫자) 조용히 기본값으로 넘어가지 않고
**400**으로 거절한다.

| 쿼리 파라미터 | 타입 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `worker` | `collector` \| `analyzer` | (없음 = 전체) | 워커 종류 필터 |
| `outcome` | `running` \| `success` \| `failed` \| `blocked` \| `skipped` | (없음 = 전체) | 결과 구분 필터 |
| `page` | 정수 ≥ 1 | `1` | 페이지 번호 |
| `pageSize` | 정수 1~200 | `20` | 페이지 크기. 200 초과는 400 |

```jsonc
// 200 OK
{
  "runs": [
    {
      "id": 42,
      "worker": "collector",
      "startedAt": "2026-09-08T06:50:00.000Z",
      "finishedAt": "2026-09-08T06:51:12.000Z",  // 아직 끝나지 않은(running) 회차는 null
      "outcome": "success",                       // running | success | failed | blocked | skipped
      "errorKind": null,          // failed/blocked면 오류 클래스 이름(예: "RobotDetectedError"),
                                   // skipped면 사유("overlap" | "backoff")
      "errorMessage": null,
      "detail": {                 // 워커별로 형태가 다르다. collector 회차의 예:
        "targetCourts": ["서울중앙지방법원"],
        "pagesRequested": 12,     // 실제로 보낸 요청 페이지 수(§7.3 참고)
        "itemsFetched": 444,
        "inserted": 2,
        "updated": 440,
        "changed": 3              // 감시 필드가 실제로 바뀐 물건 수(§7.2 참고)
      },
      "itemsChanged": 3           // 위 detail.changed와 항상 같은 값(집계용 컬럼). analyzer
                                   // 회차나 detail이 없는 회차는 null
    }
  ],
  "total": 1,
  "page": 1,
  "pageSize": 20
}
```

analyzer 회차의 `detail`은 `{ newCount, reanalysisCount, succeeded, failed }` 형태다(신규
분석 건수, 재분석 건수, 성공·실패 건수).

### `POST /api/worker-runs` — 회차 시작 기록

```jsonc
// 요청 본문
{ "worker": "collector" }  // "collector" | "analyzer", 필수
```

- 성공: **201** + `{ "id": <새 회차 id> }`
- 본문 형식 오류: **400**

collector는 이 API를 쓰지 않고 저장소 함수(`startRun`)를 직접 호출한다. analyzer는 DB를
직접 열지 않으므로(§1) 회차 시작마다 이 엔드포인트를 호출해야 한다.

**⚠️ 이 엔드포인트는 인증이 없다.** §7.4 및 아래 `PATCH /api/worker-runs/[id]`의 경고를
반드시 읽을 것.

### `PATCH /api/worker-runs/[id]` — 회차 종료 기록

```jsonc
// 요청 본문
{
  "outcome": "success",       // "success" | "failed" | "blocked", 필수 (running/skipped는 이 API로 못 만든다)
  "errorKind": "RobotDetectedError",   // 선택. 빈 문자열 불가
  "errorMessage": "...",               // 선택. 빈 문자열 불가
  "detail": {                          // 선택. worker에 맞는 형태만 허용(zod union)
    "newCount": 3, "reanalysisCount": 1, "succeeded": 4, "failed": 0
  }
}
```

- 성공: **200** + 갱신된 회차 객체(위 `GET /api/worker-runs`의 `runs[]` 항목과 같은 형태)
- 본문 형식 오류: **400**
- `id`가 숫자가 아니거나 존재하지 않는 회차: **404**

**⚠️ 인증이 없다 — 완곡하게 말하지 않는다.** `POST /api/worker-runs`와
`PATCH /api/worker-runs/[id]`는 둘 다 인증 없이 누구나 호출할 수 있다. 현재는 로컬/개인
전용 실행이 전제라 허용된 상태이지만(design.md D3), **이 서버가 외부에 노출되는 순간
누구나 임의의 회차 기록을 주입할 수 있다.** `/status` 화면과 `GET /api/worker-runs/summary`
집계는 전부 이 기록에서 계산되므로, 주입된 "성공" 기록 하나가 실제로는 멈추거나 차단된
워커를 "정상"으로 둔갑시켜 진짜 장애를 감출 수 있다. **인증을 도입할 때 반드시 포함해야
할 엔드포인트로 지금부터 명시해 둔다.**

### `GET /api/worker-runs/summary` — 최근 기간 집계

`src/app/api/worker-runs/summary/route.ts`. `/status` 화면의 "성공률/차단 횟수/누적 변경
건수" 카드가 이 라우트가 호출하는 것과 같은 함수(`summarizeRuns()`)를 쓴다 — 다만 화면은
서버 컴포넌트라 이 API를 거치지 않고 함수를 직접 호출한다(§7.1 참고). 이 API는 화면이
아닌 외부 클라이언트(운영자의 curl, 향후 모니터링 도구)를 위한 것이다.

| 쿼리 파라미터 | 타입 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `worker` | `collector` \| `analyzer` | (없음 = 전체) | 워커 종류 필터 |
| `since` | ISO 날짜·시각 문자열 | (없음 = 보관 중인 전체 기록) | 이 시각(포함) 이후 시작된 회차만 집계 |

```jsonc
// 200 OK
{
  "totalRuns": 42,
  "successCount": 38,
  "failedCount": 1,
  "blockedCount": 2,
  "skippedCount": 1,
  "runningCount": 0,
  "successRate": 0.9268292682926829,  // successCount / (success+failed+blocked). 완료된 회차가
                                        // 하나도 없으면 null(0%와 구별하기 위해 — "0"이 아니다)
  "itemsChanged": 57                   // 이 기간 items_changed 컬럼의 합(§7.2)
}
```

### 관심 물건·변동 피드 API (add-bookmarks-and-feed)

사용법·화면 설명은 §6.3을 먼저 읽을 것. 여기는 API 계약만 정리한다. 전부 인증이 없다 —
**§7.4의 "쓰기 API에 인증이 없다" 목록에 아래 쓰기 엔드포인트가 전부 포함돼 있다.**

#### `GET /api/bookmarks` — 관심 물건 목록

| 쿼리 파라미터 | 타입 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `page` | 정수 ≥ 1 | `1` | 페이지 번호 |
| `pageSize` | 정수 1~200 | `20` | 페이지 크기. 200 초과는 400 |

```jsonc
// 200 OK — 담긴 물건이 없으면 items: []  (오류 아님)
{ "items": [ /* GET /api/items와 같은 물건 객체(bookmarked: true) */ ], "total": 1, "page": 1, "pageSize": 20 }
```

#### `POST /api/bookmarks` — 관심 등록

```jsonc
// 요청 본문
{ "itemId": 1 }  // 정수 ≥ 1, 필수
```

- 성공: **201** + `{ "item": { ... } }`(등록된 물건, `bookmarked: true`)
- 이미 담긴 물건을 다시 등록해도 **오류가 아니다**(중복 행이 생기지 않는다, 성공으로 처리)
- 존재하지 않는 `itemId`: **404**, 아무것도 저장하지 않는다
- 본문 형식 오류: **400**

#### `DELETE /api/bookmarks/[itemId]` — 관심 해제

- 성공: **200** + `{ "itemId": 1, "bookmarked": false }`
- 담기지 않은(하지만 존재하는) 물건을 해제해도 **오류가 아니다**(idempotent)
- `itemId`가 숫자가 아니거나 존재하지 않는 물건: **404**

#### `GET /api/feed` — 변동 피드

관심 물건에 생긴 **실제 변경**(`item_changes.kind = 'change'`, 기준점 제외)만 최신순으로
돌려준다 — §6.1의 `kind` 구분을 그대로 물려받는다.

| 쿼리 파라미터 | 타입 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `page` | 정수 ≥ 1 | `1` | 페이지 번호 |
| `pageSize` | 정수 1~200 | `20` | 페이지 크기. 200 초과는 400 |
| `sinceBookmarkedAt` | `true` \| `false` | `false` | `true`면 각 물건을 관심 등록한 시각 이후의 변동만 포함한다. 기본(`false`)은 등록 이전 변동도 포함한다 — 방금 담은 물건의 최근 하락을 못 보면 담은 의미가 없다는 것이 의도적인 기본값이다. |

```jsonc
// 200 OK
{
  "entries": [
    {
      "id": 9, "itemId": 1, "itemAddress": "서울특별시 관악구 신림동 1-1",
      "field": "minBidPrice", "oldValue": "400000000", "newValue": "320000000",
      "changedAt": "2026-01-02T00:00:00.000Z",
      "bookmarkedAt": "2026-01-01T00:00:00.000Z"  // 이 물건을 관심 등록한 시각
    }
  ],
  "total": 1, "page": 1, "pageSize": 20,
  "unreadCount": 1   // 저장된 값이 아니라 매 호출마다 도출된다(§6.3) — 이 호출 자체는 읽음 처리를 하지 않는다
}
```

#### `POST /api/feed/read` — 읽음 처리 (JSON API)

```jsonc
// 200 OK
{ "lastReadAt": "2026-09-08T13:15:51.000Z", "unreadCount": 0 }
```

본문이 없어도 된다(현재 시각으로 처리). **`GET /api/feed`를 아무리 호출해도 이 엔드포인트를
직접 호출하지 않는 한 읽음 처리는 절대 일어나지 않는다**(§6.3, design.md D3).

#### `POST /api/bookmarks/toggle`, `POST /api/feed/mark-read` — 화면 전용 폼 엔드포인트

`/`, `/items/[id]`, `/bookmarks`의 관심 토글 버튼과 `/feed`의 "전체 읽음 처리" 버튼이 쓰는
`<form method="post">` 전용 엔드포인트다. 이 프로젝트는 클라이언트 JS를 쓰지 않으므로(필터
폼도 `method="get"`이다), 위 JSON API와 별도로 두었다 — HTML 폼은 JSON 응답이 아니라
리다이렉트가 필요하기 때문이다. `form-urlencoded` 본문을 받고 처리 후 `returnTo`(같은
오리진의 상대 경로만 허용, `src/app/_lib/safe-redirect.ts`)로 **303** 리다이렉트한다.
직접 호출할 일은 없지만(화면 전용), 존재를 밝혀 둔다 — 이 두 엔드포인트도 인증이 없다.

| 엔드포인트 | 본문 | 동작 |
| --- | --- | --- |
| `POST /api/bookmarks/toggle` | `itemId`, `bookmarked`(제출 시점의 현재 상태), `returnTo` | `bookmarked=true`면 해제, 아니면 등록 후 `returnTo`로 리다이렉트 |
| `POST /api/feed/mark-read` | `returnTo` | 피드 전체를 읽음 처리하고 `returnTo`로 리다이렉트 |

## 6. 변경 이력과 재분석

### 6.1 변경 이력

`items`는 물건당 1행만 upsert하므로, 원래는 최저매각가격이 저감돼도 현재 값만 남고 과거
값은 사라진다. 이를 보완하기 위해 **감시 대상 필드(watched fields) 4개**가 바뀔 때마다
`item_changes` 테이블에 "언제, 무엇이, 얼마에서 얼마로" 바뀌었는지 행을 남긴다:

- `minBidPrice`(최저매각가격), `failedBidCount`(유찰횟수), `auctionDate`(매각기일),
  `status`(진행상태)

핵심 규칙: **감시 필드의 값이 실제로 바뀔 때만** 이력 행이 생긴다. collector가 10분마다
같은 물건을 다시 수집해도 값이 그대로면 아무것도 쌓이지 않는다 — 이력 테이블이 무한정
불어나지 않는 이유다. `소재지`처럼 감시 대상이 아닌 필드만 바뀐 경우도 물건은 갱신되지만
이력은 남지 않는다. 물건 갱신과 이력 기록은 하나의 트랜잭션이라 원자적이다(한쪽만 반영되는
경우가 없다).

**이 기능 도입 이전에 이미 수집된 물건에는 기준점 이력이 없다** — 최초 저장 시점을
소급해서 만들 수 없기 때문이다. 이런 물건은 값이 실제로 바뀌는 첫 순간까지 이력이
비어 있고, 물건 상세 화면은 이 상태를 (신규 물건이 아직 한 번도 안 바뀐 상태와 똑같이)
"아직 변동이 없습니다"로 정상 표시한다 — 오류가 아니다.

변경 이력은 `GET /api/items/[id]/changes`(§5)로 조회하거나, 물건 상세 페이지
(`/items/[id]`)의 "변경 이력" 카드에서 시간순으로 볼 수 있다. 최저매각가격 변경은 하락/상승
방향과 변화폭(금액·비율)이 함께 표시된다. 목록 화면(`/`)에서는 최근 7일 이내에 실제 변동이
있었던 물건에 배지가 붙는다.

**기준점/실제 변경 구별은 `item_changes.kind`(`'baseline' | 'change'`) 컬럼이 유일한
기준이다.** 예전에는 `old_value IS NULL`로 구별했는데, "값이 없던 필드에 값이 처음
생기는" 것도 실제 변경이면서 `old_value`가 여전히 `NULL`로 기록되므로(예: 비어 있던
매각기일이 잡히거나, 소스 글리치로 사라졌던 값이 복구되는 경우) 기준점과 구별할 방법이
없었다 — 이런 변경이 상세 페이지의 변경 이력, 목록의 "최근 변동" 배지, §6.2의 재분석 대상
판정에서 전부 사라지는 버그였다. `kind`는 저장 시점에 이 둘을 명시적으로 다르게 남긴다
(`src/lib/db/repository.ts`의 `detectWatchedChanges`는 항상 `kind: "change"`를,
`baselineWatchedChanges`는 항상 `kind: "baseline"`을 쓴다).

이 컬럼이 없던 시절에 만들어진 DB 파일은 앱/워커가 열 때 자동으로 마이그레이션된다
(`src/lib/db/client.ts`의 `migrateItemChangesKindColumn` — `CREATE TABLE IF NOT EXISTS`는
이미 있는 테이블에 컬럼을 추가해 주지 않으므로 `ALTER TABLE ... ADD COLUMN`으로 직접
추가한다). 백필 규칙은 예전 방식 그대로다: `old_value IS NULL`인 기존 행은 `kind =
'baseline'`으로, 나머지는 `kind = 'change'`로 채운다. **이 백필에는 되돌릴 수 없는 손실이
있다** — 컬럼이 없던 시절에 기록된 "null → 값" 실제 변경(위에서 설명한 버그 케이스)은
`old_value`가 `NULL`이라는 이유만으로 이 마이그레이션에서도 그대로 기준점으로
재분류된다. 그 시절 데이터는 애초에 두 경우를 구별해서 저장하지 않았으므로 소급해서
복구할 방법이 없다 — 이 마이그레이션이 고치는 것은 "이후로 새로 기록되는 행"부터다.
(마이그레이션 자체는 `src/lib/db/__tests__/client.test.ts`의 "item_changes.kind 컬럼 추가
전 스키마로 만든 기존 DB 파일에 컬럼이 추가되고 기존 행이 백필된다" 테스트로 검증돼 있다.)

### 6.2 재분석

analyzer는 처음에는 "분석 결과가 하나도 없는 물건"만 분석했다. 이제는 이미 분석된 물건도
아래 **세 조건 중 하나**를 만족하면 재분석 대상(candidate)이 된다:

1. 분석 결과가 아직 없는 물건 (기존과 동일)
2. 최신 분석 이후 감시 대상 필드가 실제로 바뀐 물건 — 최저가가 떨어졌는데 옛 가격 기준
   분석이 남아 있으면 틀린 정보가 되기 때문
3. 최신 분석의 프롬프트 버전이 analyzer의 현재 `PROMPT_VERSION`과 **다른**(같음/다름만 보고,
   높고 낮음은 따지지 않는다) 물건

재분석 대상은 `GET /api/items?needsAnalysis=true&promptVersion=<현재 버전>`(§5)으로 조회하며,
기존 `analyzed=false` 필터의 의미(분석 결과 유무)는 바뀌지 않는다 — 재분석 대상 여부는 별도
파라미터로만 알 수 있다.

위 세 조건을 만족해도, **물건의 최신 분석이 `reanalysisCooldownHours`(기본 24시간) 이내에
이뤄졌으면 재분석 대상에서 제외된다.** 이 값은 워커가 보내는 URL 파라미터가 아니라
**서버가 자기 `config/collector.json`을 읽어 스스로 적용**한다(`needsAnalysis=true`
요청이면 항상 적용됨, `src/app/api/items/route.ts`) — analyzer가 조정할 수 있는 값이
아니다.

**왜 쿨다운이 필요한가.** `status`(진행상태)는 사이트가 주는 값이 아니라 `failedBidCount`
(유찰횟수)에서 어댑터가 1:1로 파생시킨 값이다(`0` → `"신건"`, 그 외 → `"유찰 N회"`,
`src/lib/sources/courtauction/adapter.ts`의 `deriveStatus`). 그래서 소스가 `유찰횟수`를
수집 회차마다 다르게(예: 일시적으로 유실됐다 복구되는 패턴) 보고하는 물건 하나가 있으면,
그 물건은 수집될 때마다 감시 필드 최소 2개(`failedBidCount`, `status`)가 동시에 "실제
변경"으로 기록되고 — 조건 2에 의해 — **매 회차 재분석 대상으로 재적격된다.** 10분
주기라면 하루 144회 수집(24 × 60 / 10)이 돌므로, 이 물건 하나가 하루 최대 144번, 한 달
약 4,320번의 유료 Claude 호출을 유발할 수 있다. `maxReanalysisPerRun`은 **회차당** 상한일
뿐 재분석 대기열 자체를 비우지 못한다 — 대기열에 이 물건이 계속 다시 들어오므로 한도를
계속 잠식한다. 실제 쓰레기값 없이 진짜 유찰이 일어나는 주기는 대략 월 단위이므로, 24시간
쿨다운은 정상적인 재분석 요구를 막지 않으면서 이 낭비를 하루 144회에서 하루 1회로
줄인다. **이건 "성능 최적화"가 아니라 비용 버그를 막는 장치다.**

이 패턴이 실제로 일어나고 있는지는 collector의 회차 로그로 알 수 있다 — `workers/collector.ts`가
`저장 완료 — inserted=N, updated=N, changed=N` 형태로 매 회차 출력하는 `changed`는
**감시 대상 필드가 실제로 바뀐 "물건 수"**다(이력 행 수가 아니고, 기준점도 세지 않는다).
운영자가 지켜봐야 할 신호는 이 값이다: 물건 수(대개 수백 건 규모)에 비해 `changed`가 매
회차 비정상적으로 크거나 특정 회차마다 반복적으로 비슷한 값이 나오면, 위에서 설명한
소스 노이즈로 인한 스퓨리어스 변경이 의심되는 상황이다.

**`maxItemsPerRun`(신규 분석 한도)과 `maxReanalysisPerRun`(재분석 한도, 기본 2)은 서로
독립된 한도다.** 회차당 Claude 호출 수 상한은 이 둘의 **합**이다(기본값 기준 5 + 2 = 7건) —
"둘이 하나의 한도를 나눠 쓴다"가 아니다. 신규 분석이 항상 먼저 전량 배정되므로, 재분석
대상이 아무리 많아도 아직 한 번도 분석되지 않은 물건이 재분석 대기열에 밀려 미뤄지지
않는다. 재분석은 **가장 오래전에 분석된 물건부터** 순서대로 뽑는다 — 최근 변경 우선으로
하면 자주 바뀌는 물건 하나가 한도를 독점할 수 있기 때문이다.

**⚠️ 비용 경고 — 절대 가볍게 볼 일이 아니다.** `workers/lib/prompt.ts`의 `PROMPT_VERSION`
상수를 올리면, **이미 분석이 끝난 물건 전부**가 위 조건 3에 걸려 재분석 대상이 된다. 물건이
수백 건이면 Claude 호출 수백 건이 발생한다는 뜻이다. 다만 한 회차에 실제로 소비되는 양은
`maxReanalysisPerRun`만큼씩 나뉘어 여러 회차에 걸쳐 서서히 빠진다(예: 대상 100건, 한도
2건/회차 → 50회차, 즉 10분 주기 기준 약 8시간 20분에 걸쳐 소진). **그래도 총 비용 자체가
줄어드는 것은 아니다** — 프롬프트 버전을 올리는 것은 "전체 물건을 다시 분석하겠다"는 명시적
지출 결정으로 취급해야 한다. 급하게 소진하고 싶다면 `AUCTIONBOSS_ANALYZE_REANALYZE_MAX`를
일시적으로 올려서 회차당 처리량을 늘릴 수 있다(그만큼 회차당 비용도 늘어난다).

**★ 이 재분석 경로 전체는 2026-09-09(11회차)까지 실데이터로 단 한 번도 실행된 적이
없었다** — 실제 수집에서 감시 필드가 바뀐 사례가 아직 없어(위 `changed` 값이 항상
0이었다) 재분석 후보 자체가 존재하지 않았기 때문이다. 11회차가 이미 분석된 물건의
감시 필드를 직접 바꿔(수집 결과를 조작 — 소스를 속이는 것이 아니다) 후보를 인위적으로
만들어 처음으로 전체 경로를 실증했다. 확인된 것:
- 후보가 실제로 재분석되고, **이전 분석은 지워지지 않고 그대로 남는다**(새 분석이
  추가될 뿐이다) — 재분석된 물건 상세 화면의 "이전 분석" 목록에서 확인 가능.
- 새 분석은 바뀐 값을 실제로 반영한다(예: 유찰 1회→2회, 비율 100%→80%로 바뀐 뒤
  재분석한 결과가 새 값 기준으로 다시 계산됨).
- 미분석 물건이 남아 있는 상태에서도 **신규 분석이 재분석보다 항상 먼저** 처리된다.
- **쿨다운이 실제로 막는다**: 방금 재분석된 물건을 곧바로 다시 바꿔도, 기본값
  24시간 안에서는 재분석 후보 목록(`needsAnalysis=true`)에 나타나지 않는다. 24시간을
  기다릴 수 없어 `config/collector.json`의 `reanalysisCooldownHours`를 일시적으로
  1로 낮춰 후보가 즉시 나타나는 것도 확인했다(재수집 시각이 이미 실제로 4시간 이상
  지난 뒤였다) — 확인 후 24로 되돌리고 복귀도 재확인했다.
- 쿨다운 중에도 물건 상세 화면의 분석 최신성 배지는 "갱신 예정"으로 정확히 표시된다
  — 자동 재분석이 아직 안 됐다고 해서 화면이 "최신"이라고 잘못 말하지 않는다.

상세 절차와 실제 로그는 `NOTES.md` §14.3에 있다.

### 6.3 관심 물건과 변동 피드 (add-bookmarks-and-feed)

10분마다 수집해 §6.1의 변경 이력을 남기는 이유는 결국 "내가 보는 물건에 무슨 일이
생겼는지" 알기 위함이다. 이 기능이 그 마지막 연결이다 — 물건을 관심 목록에 담아두면,
그 물건들에 생긴 **실제 변경만** 모아서 최신순으로 볼 수 있다.

**사용법:**

- 물건 목록(`/`)의 각 행과 물건 상세(`/items/[id]`)에 관심 토글 버튼(☆ 관심 등록 / ★ 관심
  해제)이 있다. 클라이언트 JS 없는 평범한 `<form method="post">`라, 목록에서 누르면 지금
  보던 필터·정렬·페이지가 그대로 유지된 채 같은 화면으로 돌아온다(§5 "관심 물건·변동 피드
  API"의 `POST /api/bookmarks/toggle` 참고) — 물건 하나를 담았다고 필터가 초기화되면
  목록에서 이 기능을 쓸 수 없기 때문이다.
- `/bookmarks` — 담아둔 물건만 모아 보는 목록. 아직 하나도 안 담았으면 오류 대신 안내
  문구가 뜬다.
- `/feed` — 관심 물건에 생긴 변동을 최신순으로 보여준다. 각 항목에 물건(소재지로 표시,
  클릭하면 상세로), 어떤 필드가, 이전 값에서 새 값으로, 언제 바뀌었는지가 나온다. 최초
  저장 시점의 **기준점은 변동으로 취급하지 않는다** — 방금 담은 물건이라도 기준점 때문에
  가짜 변동이 뜨지 않는다(`item_changes.kind = 'change'`만 읽는다, §6.1).
- 관심을 해제하면 그 물건의 변동은 `/feed`에서도, `/bookmarks`에서도 즉시 사라진다.

**미확인 표시와 읽음 처리:** `/feed`는 마지막으로 읽음 처리한 시각 이후의 변동을 미확인으로
구별해 배지로 보여주고, 미확인 개수를 화면 상단(그리고 `/`, `/items/[id]`의 링크)에
노출한다. **`/feed`를 열어보기만 해서는 절대 읽음 처리가 되지 않는다** — 화면에 있는
"전체 읽음 처리" 버튼을 눌러야만 그 시점까지의 변동이 확인 처리된다. 훑어보려고 페이지를
연 순간 미확인 표시가 사라지면 무엇이 새로 왔는지 놓치기 때문이다. 미확인 개수는 저장된
값이 아니라 `변경 시각 > 마지막 읽음 시각`으로 매번 다시 계산한다(한 번도 읽지 않았으면
전체가 미확인) — 저장하면 갱신을 놓쳤을 때 조용히 틀린 숫자가 표시될 수 있다.

**⚠️ 단일 사용자 전제.** 관심 목록(`bookmarks` 테이블)과 마지막 읽음 시각(`feed_reads`
테이블, 행이 하나뿐이다)은 **사용자 구분 없이 전역으로 관리된다.** 이 서비스가 개인/내부
전용이라는 이 프로젝트의 기존 전제(§8, §11)를 그대로 물려받은 것이다. 실무적으로 두 가지를
뜻한다:

- 이 서버에 접근할 수 있는 사람(또는 브라우저) 누구든 같은 관심 목록·같은 읽음 상태를
  본다 — 사람마다 다른 관심 목록을 가질 수 없다.
- 여러 기기·여러 탭에서 동시에 `/feed`를 쓰면, 한쪽에서 읽음 처리한 시각이 다른 쪽의
  "여기까지 읽었다" 기준도 함께 덮어쓴다.

나중에 다중 사용자가 필요해지면 **`bookmarks`와 `feed_reads` 두 테이블에 `user_id`
컬럼을 추가하고, `src/lib/db/bookmarks.ts`의 모든 조회·쓰기에 그 조건을 더해야 한다** —
지금 이 파일에는 그 조건이 아예 없다(파일 상단 주석에도 같은 경고가 있다). 이 항목은
§11 "알려진 한계"에도 올라 있다.

### 6.4 목록 판단 지표 · 분석 상태 배지 · 원본 확인 (improve-item-discovery-ux)

분석은 회차당 5건씩만 처리되므로(§6.2) 수백 건 중 대부분은 오랫동안 "분석 대기 중"이다.
분석을 기다리지 않고도 이미 저장된 값만으로 1차 선별이 가능하도록, 목록·상세 화면에
판단 지표를 추가했다. 데이터 계층은 바뀌지 않았다 — 필요한 값은 전부 이미 저장돼 있다.

**★ 이 설계가 실제로 그 역할을 하는지 실데이터로 확인함(11회차)**: 389건 중 회차당
신규 5건이면 전부 분석하는 데 78회차·약 13시간이 걸린다. 이게 받아들일 만한지는
"분석 없이도 판단이 가능한가"에 달려 있는데, 실제로 미분석 물건(약 350건)만 놓고
지역(시/군/구)·용도·유찰횟수·저감률 정렬을 조합해 봤더니 즉시 좁혀졌다 — 예: 저감률
오름차순 정렬만으로 최저매각가격이 감정가의 2.8%까지 떨어진(유찰 16회) 물건이 바로
1등으로 나왔고, "강남구 + 유찰 1회 이상" 조합은 350여 건을 24건으로 좁혔다. 목록
화면 자체는 물건이 분석됐는지 여부를 행 단위로 표시하지 않는다(분석 유무 배지는
상세 화면에만 있다) — 그래서 사용자가 목록을 스크롤하며 "분석 대기 중"이라는 문구를
반복해서 보는 일 자체가 없다. 결론: **이번 사이클에서는 우선순위 조정(관심 물건
우선 분석 등) 기능을 구현하지 않는다** — 이미 있는 필터·정렬만으로 목적(판단 가능한
후보로 좁히기)이 달성되고, 마지막 사이클에 재분석 경로 등 이번에 막 검증한 로직을
건드릴 위험을 감수할 이유가 없기 때문이다. 다만 관심 물건 우선 분석은 여전히 합리적인
다음 개선안으로 남겨 둔다(구현 안 함, 판단만).

**목록의 저감률·면적당 가격** (`src/app/_lib/discount.ts`, `src/app/_lib/item-extensions.ts`)

- **저감률** = 최저매각가격 ÷ 감정가. 유찰이 몇 번 돌았는지를 금액 감각으로 보여준다.
  단계로 시각 구분한다(`DISCOUNT_STAGE_LABELS`) — 단계 개수와 경계값은 §6.5(ux-overhaul-
  phase1)에서 실측 분포에 맞춰 4단계→6단계로 재조정됐다. **색에만 의존하지 않는다** —
  단계마다 다른 텍스트 라벨이 항상 함께 표시된다.
- **면적당 가격** = 최저매각가격 ÷ 면적(`computePricePerArea`, `src/lib/domain/price.ts`).
  분석 워커(`workers/lib/derived.ts`)와 **같은 함수**를 공유한다 — 화면과 분석이 각자
  계산을 다시 구현하면 가드 조건이 갈라질 위험이 있어서다.
- 감정가·면적이 없어 계산할 수 없는 물건은 그 칸이 `-`로 표시되고 행 전체는 정상
  렌더링된다. 목록 쿼리의 `WHERE`/`ORDER BY`/`total`은 이 지표 추가와 무관하다 — 표시만
  추가했을 뿐 필터·정렬 계약은 그대로다.
- **소재지는 지역 요약으로 표시된다**(`src/app/_lib/region-summary.ts`). 구조화된 소재지
  (`sido`/`sigungu`/`dong`, §「확장 필드」)가 있으면 그걸 앞세운 짧은 표기("서울특별시
  강남구 역삼동")를 쓰고, 없는 물건(이 기능 이전 수집분)은 기존 `address` 문자열을 그대로
  쓴다. 지역으로 **필터**하는 것은 이 change의 범위가 아니다 — 표시만 바꿨다.

**상세의 분석 상태 배지** (`src/app/_lib/analysis-freshness.ts`)

물건 상세의 "AI 분석" 카드는 항상 세 상태 중 하나를 배지+설명 문구로 보여준다:

| 상태 | 배지 | 의미 |
| --- | --- | --- |
| `pending` | 분석 대기 중 | 이 물건은 아직 한 번도 분석되지 않았다 |
| `fresh` | 최신 분석 | 마지막 분석 이후 감시 필드가 바뀌지 않았고 프롬프트 버전도 같다 |
| `stale` | 갱신 예정 | 분석 이후 감시 필드가 바뀌었거나 프롬프트 버전이 낡았다 — **아래 분석 내용이 현재 값과 다를 수 있다는 경고** |

`stale` 판정은 §6.2의 재분석 대상 선정(`NEEDS_ANALYSIS_PREDICATE`)과 **같은 두 조건**
(최신 분석 이후 실제 변경 / 프롬프트 버전 불일치)을 재사용한다 — 화면이 판정을 새로
구현하면 워커와 다른 답을 낼 수 있어서다. 단, **재분석 쿨다운은 이 판정에 넣지 않는다**
— 쿨다운은 워커가 이번 회차에 그 물건을 재분석 후보로 집어들지 여부일 뿐, 분석이 실제로
최신인지와는 다른 질문이다. 쿨다운까지 반영하면 쿨다운 중에는 "최신"으로 잘못 표시돼
§6.2가 경고하는 사고(옛 가격 기준 분석이 최신처럼 보임)가 그대로 재현된다. 그리고 대기
순번·예상 시각은 만들지 않는다 — 재분석·쿨다운·회차당 한도가 얽혀 있어 정확한 예측이
불가능하고, 틀린 예측은 안 보여주느니만 못하다.

**원본 확인 — 왜 홈 링크인가**

물건 상세는 "법원경매정보에서 확인" 카드에 [법원경매정보 홈](https://www.courtauction.go.kr/pgj/index.on)
링크와 법원명·사건번호를 `<input readonly>`로 나란히 제공한다(클릭 한 번으로 전체 선택 —
클립보드 복사에는 JS가 필요하지만 readOnly input의 전체 선택은 아니다, 이 프로젝트는
클라이언트 JS를 쓰지 않는다). 물건별 딥링크가 아니라 홈으로 보내는 이유는 **물건별 GET
URL이 존재하지 않기 때문이다** — 조사로 확인된 사실이다: 법원경매정보는 WebSquare5
SPA이고, 상세 화면 정의 XML(171KB) 전체에 `location.search`/`location.hash`/
`URLSearchParams`가 **0건**이다. 물건 식별자는 URL이 아니라 화면 간 인메모리 파라미터로만
전달된다. `index.on?w2xPath=...`로 화면 자체는 열리지만 물건을 지정하는 파라미터가 없어,
그 링크는 데이터 없는 빈 화면이나 오류로 이어질 위험이 홈보다 크다 — 그래서 깨진 딥링크
대신 홈 링크 + 그 자리에서 복사 가능한 검색값을 제공한다.

### 6.5 정직한 표시 — 면적 병기·불일치 경고·비고 배지·신선도 배너 (ux-overhaul-phase1)

실데이터 389건을 직접 질의해 조사한 결과, **화면이 틀린 숫자를 보여주고 있었고 그 값이
AI 분석 프롬프트까지 오염시키고 있었다.** 이 change는 표시 계층만 고친다 — 목록 쿼리의
`WHERE`/`ORDER BY`/`total`은 건드리지 않는다(회귀 위험을 최소화하기 위한 이 change의
전제, design.md Context).

**면적 병기와 역전 처리** (`src/app/_lib/item-extensions.ts`, `src/lib/domain/price.ts`)

- 실데이터 186건(48%)이 `minArea > maxArea`(예: id 48 — `minArea=11414`,
  `maxArea=80`)다. 원인은 불명 — 두 필드가 대지권/전유면적인지 토지/건물인지조차 소스
  재조사 없이는 알 수 없다. 이전 화면은 이걸 `"11414㎡ ~ 80㎡"`라는 **존재하지 않는
  범위**로 그렸다.
- 지금은 역전된 경우 범위로 잇지 않고 `면적 A 11,414㎡ (3,452.7평) · 면적 B 80㎡
  (24.2평) (의미 미확정)`처럼 두 값을 병기한다. **값을 정렬해 뒤집지 않는다** —
  `"80㎡ ~ 11,414㎡"`로 보이면 "최소가 80"이라는 없는 사실을 만들게 된다. 이는 좌표·
  용도코드에 이미 적용한 원칙(원문 보존, §5 「확장 필드」)과 같다. 정상인 경우(52%,
  `min <= max`)는 기존처럼 범위로 잇는다.
- 모든 면적 표시에 평(坪)이 함께 붙는다(1평=3.3058㎡, 소수 1자리 — 원본이 정수로 절삭
  저장되므로 그 이상의 정밀도를 꾸며내지 않는다): `84㎡ (25.4평)`.
- `computePricePerArea`(분석 워커 `workers/lib/derived.ts`와 공유하는 함수, §6.4)의
  반환값이 `{ pricePerArea, basisArea, basisField, basisAmbiguous }`로 넓어졌다 —
  **어느 면적으로 나눴는지**가 이제 결과에 포함된다. 화면은 `basisAmbiguous`가 true일
  때만(=`minArea`/`maxArea`가 둘 다 있고 서로 다를 때만) `1,296,089원/㎡ (면적 A
  179㎡ 기준)`처럼 기준을 밝힌다. **어느 면적이 옳은지는 이번에 정하지 않는다** — 여전히
  `minArea` 우선(기존 규칙 그대로)이고, 역전된 물건은 여전히 큰 값으로 나눠 단가가
  최대 143배 작게 나올 수 있다. 이번에 한 일은 그 사실을 숨기지 않고 드러낸 것뿐이다.
  이 기준 정보는 **분석 프롬프트에도 그대로 들어간다**(`workers/lib/prompt.ts`) — 모델이
  숫자가 이상해 보이면 "면적 정보 자체가 불확실하다"고 스스로 판단할 근거를 준다.
- 목록 테이블에는 새 열을 만들지 않았다 — 기존 "면적당 가격" 열(헤더는 "면적"으로
  바꿈) 안에 면적(㎡·평)과 면적당 가격을 두 줄로 쌓아 보여준다.

**유찰횟수-저감률 불일치 경고** (`src/app/_lib/bid-mismatch.ts`)

- 실데이터 79건(20%)에서 `failedBidCount`와 소스가 준 `minBidPriceRateRound1`이
  서로 맞지 않는다(예: 유찰 8회인데 저감률은 80% — 1회 유찰 수준). 국내 법원경매는
  통상 유찰 1회당 감정가의 80%로 재산정하므로(20% 저감 — 아래 "저감률 단계 재조정"이
  실측 389건으로 이 규칙을 확인했다), `failedBidCount`회 유찰이면 저감률은
  이론상 `100 × 0.8^failedBidCount`(%)여야 한다. 실제 저감률과 이 예측값의 차이가
  15퍼센트포인트를 넘으면(임계 근거는 `bid-mismatch.ts` 상단 주석, 실측 사례 3건으로
  정함) "불일치" 배지를 목록·상세에 띄운다.
- **어느 쪽이 맞는지 판단해 한쪽을 감추지 않는다** — 배지 설명은 예상값과 실제값을
  둘 다 그대로 보여준다("유찰 8회면 저감률이 약 16.8%일 것으로 예상되지만, 실제
  저감률은 80.0%입니다 — 두 값이 서로 모순되어 어느 쪽이 맞는지 알 수 없습니다").

**비고 플래그** (`src/app/_lib/note-flags.ts`)

- `note`가 152건에 있고, 그 내용이 실제로 입찰 가부를 가른다(예: 지분매각이면 지분만
  사는 것). 이전에는 상세 페이지 최하단 6번째 카드에만 있었다. 실측 문자열 패턴으로
  6개 유형(실제로 관측된 것만, 추측 없음)을 판정한다: 일괄매각, 대항력 포기조건,
  지분매각, 위반건축물, 농지취득자격증명, 보증금 20%(특별매각조건, 통상 10%보다 높음).
- 목록 소재지 칸에 배지로 표시된다. **배지는 패턴 매칭이라 오탐·미탐이 있을 수 있다**
  — 원문을 대체하지 않는 신호일 뿐이다. 상세 페이지는 이제 `note`가 있으면 **가격 카드
  위**(재배치 순서 최상단)에 배지+원문을 그대로 보여준다 — 배지에 안 걸린 비고도
  원문은 항상 보인다.

**매각기일 D-day와 시각 포맷** (`src/app/_lib/d-day.ts`)

- 실데이터 121건(31%)이 오늘이 매각기일이고, 기본 정렬이 매각기일 오름차순이라 매일
  첫 페이지가 "오늘 입찰이 끝나는 물건"으로 채워진다. **기본 정렬은 바꾸지 않는다** —
  1·5·7회차의 많은 테스트가 이 계약에 의존하고, "지난 기일 제외"를 기본값으로 만들면
  121건이 조용히 사라진다(§6 필터 원칙과 같은 이유). 대신 목록에 `2026-09-08(오늘)`
  /`2026-09-10 (D-2)`/`(지남)` 배지를 표시만 한다.
- `auctionTime`("1000" 같은 네 자리 숫자)은 상세 페이지에서 `10:00`으로 표시한다.
  저장 계층은 여전히 원문을 그대로 보존한다(`formatAuctionTime`은 표시 전용 변환) —
  389건 전부가 이 형식이라 지금까지는 원문 그대로 노출되고 있었다.

**저감률 단계 재조정** (`src/app/_lib/discount.ts`)

- 실측 389건의 저감률 분포(1.0=164, 0.8=102, 0.64=66, 0.51=20, 0.41=20, 나머지 17)가
  정확히 `0.8ⁿ`(유찰 1회당 20% 저감)을 뒷받침한다. 이전 4단계는 0.03~0.63의 57건을
  "64% 미만" 한 칸에 뭉쳤다. 이제 6단계다: `100%대`/`80%대`/`64%대`/`51%대`/`41%대`
  /`41% 미만`. 경계는 이론값(`0.8ⁿ`)에서 0.001을 뺀 값을 쓴다 — 실측값이 반올림 오차로
  이론값보다 최대 약 6×10⁻⁶ 낮게 나오는 사례(예: 0.639999531426452)가 있어, 그대로
  쓰면 한 단계 아래로 밀려나기 때문이다. 이 경계로 실측 389건을 분류하면 위 분포가
  정확히 재현된다.

**데이터 신선도·분석 커버리지 배너** (`src/app/_lib/collection-banner.ts`)

- 목록 상단에 마지막 수집 시각·대상 법원·`분석 5/389건`(분석 커버리지)을 항상 보여준다.
  분석이 전체의 1.3%뿐인데 이전에는 목록 어디에도 그 사실이 없어 상세를 열어야만
  알 수 있었다. **새 쿼리를 만들지 않는다** — `getWorkerStatus`(§7.1이 이미 쓰는 함수)와
  `listItems({analyzed: true})`(기존 파라미터)를 그대로 재사용한다.
- 수집이 차단(`blocked`)되었거나 오래 멈췄으면(`stale`) 배너가 경고 색으로 바뀐다 —
  이전에는 1시간 백오프 중에도 목록이 아무 일 없다는 얼굴로 낡은 가격을 계속 보여줬다.

**분석 카드의 소스 한계 상설 고지** (`src/app/_lib/analysis-freshness.ts`)

- "AI 분석" 카드에 "권리관계·임차인·등기 정보는 이 데이터 소스에 없다"는 문구가
  분석 유무·최신성과 무관하게 항상 보인다. 이 사실은 §11 항목 4에 이미 적혀 있었지만
  화면 어디에도 없었다 — 분석 본문만 읽은 사용자가 그것을 권리분석까지 포함한 결과로
  오해할 위험이 있었다.

### 6.6 필터 확장 — 지역·가격 폼·기일·관심·용도 토큰·면적당 가격 정렬 (ux-overhaul-phase2)

Phase 1이 **틀린 표시**를 고쳤다면, 이 change는 **찾을 수 없는 문제**를 고친다. 목록
쿼리의 `WHERE`/`ORDER BY`/`total`을 실제로 건드리는 유일한 change라 지금까지 중 회귀
위험이 가장 크다 — 새 필터 파라미터 하나마다 `ITEM_QUERY_PARAMS`/zod 스키마/`ItemQuery`
타입/`hasActiveFilters`/`buildFilter`/`itemQuerySearchParams` 여섯 곳을 동시에 고쳐야
한다(design.md Context). API 파라미터 표는 위 §5를 참고하고, 여기서는 판단이 필요했던
지점만 정리한다.

**용도 토큰 매칭 — 유일한 계약 변경**

- 저장된 `usage_type`이 복합 문자열(`"상가,오피스텔,근린시설"`, 115건)이라 예전에는
  `usage=오피스텔`이 정확 일치(`IN`)로 걸려 이 115건이 전부 빠졌다 — 화면에는 24건만
  보여 "오피스텔이 별로 없다"는 잘못된 인상을 줬다.
- 이제 저장된 값 앞뒤에 `,` 구분자를 붙여(`,상가,오피스텔,근린시설,`) `LIKE`로 토큰
  경계를 맞춘다. `"오피스텔형"`처럼 부분 문자열만 겹치는 값은 구분자 덕분에 걸리지
  않는다. 실데이터로 확인: `usage=오피스텔`이 24건 → 139건.
- 선택지(`listUsageTypes`)도 같은 규칙으로 토큰을 쪼개 돌려준다 — 그렇지 않으면
  체크박스에 `"상가,오피스텔,근린시설"`이라는 값 하나가 뜨고, 그걸 골라도 개별 용도
  검색은 안 되는 모순이 생긴다.
- 분석 워커는 `usage`를 전혀 참조하지 않으므로(코드 검색으로 확인) 워커 계약은
  이 변경의 영향을 받지 않는다.

**가격 폼 — 억/만원 입력과 원 단위 파라미터의 관계**

- 실데이터가 76만원~261억까지 걸쳐 있어 원 단위 11자리 입력은 0 하나만 틀려도 조용히
  10배 다른 결과를 낸다. 화면 입력칸은 억/만원 두 칸(`minEok`/`minMan`,
  `maxEok`/`maxMan`)으로 받고, **서버가 원 단위로 합산**해 기존 `minPrice`/`maxPrice`
  (원 정수, 워커 계약)로 처리한다 — API가 실제로 받아들이는 값의 단위는 바뀌지 않았다.
- **우선순위(design.md D3 Open Question, 여기서 확정)**: 같은 요청에 `minPrice`와
  `minEok`/`minMan`이 동시에 오면 **`minPrice`(원 단위)가 이긴다** — `maxPrice`도
  대칭. 이미 계약·테스트로 고정된 필드가 새로 추가한 사람 편의용 필드 때문에 흔들리면
  안 된다는 판단이다. 화면 폼은 항상 억/만원 칸만 제출하므로 이 충돌은 실제로는
  URL을 손으로 조합했을 때만 발생한다.
- 프리셋(`1억 이하`/`1~3억`/`3~5억`/`5~10억`/`10억+`)은 이미 계산된 `minPrice`/
  `maxPrice`(원 단위) 값이 담긴 단순 링크다(`src/app/_lib/price-input.ts`의
  `PRICE_PRESETS`). 현재 적용된 가격 조건은 억/만원 단위로도 화면에 함께 표시된다
  (`formatWonAsEokMan`, `src/app/_lib/format.ts`).

**매각기일 범위·관심 필터 — 반드시 opt-in**

- `dateFrom`/`dateTo`는 일반적인 범위 필터지만, "지난 기일 제외"(`excludePast=true`)는
  **기본값으로 만들지 않는다.** 실데이터 389건 중 121건(31%)이 이미 지난 기일이라,
  기본으로 켜면 그 물건들이 조용히 사라지고 "물건이 갑자기 줄었다"로 읽힌다 — 6회차에서
  법원을 중간에 끊지 않기로 한 것과 같은 이유(§4.1a).
- 관심 필터(`bookmarked=true`/`false`)는 §6.3의 `bookmarked` 표시 컬럼(스칼라
  서브쿼리)과 별개의 `WHERE` 조건이다 — 표시 컬럼이 "필터·정렬·total에 관여하지
  않는다"는 기존 보장을 건드리지 않으려고 재사용하지 않고 새 `EXISTS` 조건을 추가했다.

**지역 필터·면적당 가격 정렬**

- `sido`/`sigungu`는 이미 저장돼 있던 구조화 컬럼을 다중 선택 필터로 노출한 것뿐이다
  (선택지는 `listSidoValues`/`listSigunguValues`로 저장 데이터에서 도출, 고정 목록
  아님). 관악구가 전체의 47%(183건)라 지역을 좁히지 않으면 목록이 사실상 관악구
  목록이었다. `dong`(읍/면/동)은 이번에 넣지 않는다 — 관악구만 동이 수십 개라
  체크박스가 감당하지 못한다.
- 정렬 기준에 `pricePerArea`(면적당 가격)가 추가됐다. `bidRatio`가 확립한 NULL 규칙
  (`(식) IS NULL`을 선행 정렬 키로 둬서 계산 불가한 물건을 방향과 무관하게 뒤로 보냄)을
  그대로 따른다. **§6.5(Phase 1)의 면적 정직화가 선행 조건이다** — 그게 없으면
  "저평가 순 정렬"이 실제로는 대지면적이 큰 순 정렬이 되어 버린다.

**필터 상태 가시화**

- 적용 중인 조건은 칩으로 표시되고(`src/app/_lib/filter-chips.ts`) 칩마다 개별 해제
  링크가 있다 — 새 함수 없이 기존 `itemListHref(query, { 필드: undefined })`로 만든다.
- 필터 폼 전체는 `<details>`로 접힌다(필터가 하나라도 걸려 있으면 펼쳐진 채로 시작) —
  클라이언트 JS 없이 상세 페이지의 "이전 분석"(§6.1)과 같은 방식이다.
- 페이지 크기를 20건 고정에서 사용자가 고를 수 있게 했다(10/20/50/100/200건).

## 7. 워커 상태 관측 (observability)

수집·분석 워커가 실제로 돌고 있는지, 무엇을 했는지, 왜 멈췄는지를 로그가 아니라 조회
가능한 기록으로 남기는 기능이다(`openspec/changes/add-collection-observability/`, 아직
archive로 이동하지 않은 진행 중 change). 워커는 회차(run, 실행 1회분)마다 `worker_runs`
테이블에 시작·종료·결과를 남기고(§5의 `GET /api/worker-runs`), 이를 사람이 보는 화면
(`/status`)과 집계 API(`GET /api/worker-runs/summary`)로 노출한다.

### 7.1 `/status` 페이지

`src/app/status/page.tsx`(서버 컴포넌트, `force-dynamic` — 다른 페이지와 같은 관례로
정적 프리렌더를 꺼서 새 회차가 바로 보이게 한다)가 collector/analyzer 두 워커 각각에
대해 카드 하나씩 보여준다:

- 현재 상태(4가지, 아래 표) + 마지막 성공 시각
- 최근 24시간 성공률 · 차단 횟수 · 누적 변경 건수 · 전체 회차 수(`summarizeRuns()`를
  화면이 직접 호출한 결과 — `GET /api/worker-runs/summary` API를 거치지 않는다. 서버
  컴포넌트라 저장소를 바로 호출할 수 있기 때문)
- **(collector 카드만) 한 바퀴 소요 시간 · 대상 법원 수 · 현재 로테이션 위치**
  (scale-collection-scheduling design.md D3, §4.1a) — 법원을 몇 곳으로 설정했든 전체를
  한 번씩 도는 데 걸리는 예상 시간과, 다음 회차가 어느 법원부터 시작할지를 보여준다.
  법원을 추가할 때 신선도가 얼마나 나빠지는지 여기서 바로 확인할 수 있다.
- 최근 회차 20건 목록(시작 시각, 결과 배지, 소요시간, 상세 — `RECENT_RUNS_LIMIT`). 상세
  열은 collector 회차라면 그 회차가 **실제로 처리한 법원**(`detail.targetCourts`)을
  대괄호로 먼저 보여주고 이어서 결과 수치를 보여준다 — 로테이션 도입 이후 회차마다 도는
  법원이 다를 수 있어서다. 전체 이력은 `GET /api/worker-runs`(페이지네이션)로 봐야 한다.

표시 판단(상태 → 라벨/심각도, 소요시간 포맷, `null` 성공률을 "0%"와 구별해서 보여주는
것 등)은 전부 `src/app/_lib/status-display.ts`의 순수 함수로 분리돼 있고 페이지는 그
결과를 렌더링만 한다.

상태는 `getWorkerStatus()`(`src/lib/db/worker-runs.ts`)가 매번 최신 기록에서 도출하며
저장되지 않는다(design.md D5) — 판정 순서대로:

| 상태 | 화면 라벨 | 뜻 |
| --- | --- | --- |
| `ok` | 정상 | 가장 최근 완료된 회차가 성공이다(위 세 상태 어디에도 해당 안 함). |
| `blocked` | 차단됨 | 가장 최근 **완료된** 회차가 로봇탐지 차단으로 중단됐다. 화면에 배지 색과 별도로 "차단 상태입니다 — 지금 확인이 필요합니다" 배너가 함께 뜬다. |
| `failed` | 실패 | 가장 최근 완료된 회차가 오류로 실패했다(차단이 아닌 일반 실패). |
| `stale` | 미실행 | **⚠️ "idle"(한가함)이 아니다.** 기록이 아예 없거나, 마지막 성공(또는 성공이 하나도 없으면 마지막 기록)이 `기대 주기 × observability.staleAfterIntervals`(기본 3배, §4.1)보다 오래됐다는 뜻 — **워커가 멈췄거나 죽었을 수 있다.** |

`stale`을 오해하면 안 되는 이유가 여기 있다: 이 상태는 "지금 처리할 게 없어서 쉬는 중"이
아니라 "워커가 그 어떤 새 회차도 기록하지 못하고 있다"는 뜻이다. `stale`을 "대기 중" 같은
문구로 보여주면 죽은 워커를 건강한 것처럼 안내하는 거짓 정보가 된다. 판정은 (1) 기록
없음 → `stale`, (2) 위 나이 조건 초과 → `stale`(회차 도중 죽어 `running`으로 영원히 남은
고아 회차도 결국 여기 걸린다), (3) 가장 최근 **완료된**(성공/실패/차단) 회차가 `blocked`
→ `blocked`, (4) 같은 조건에서 `failed` → `failed`, (5) 그 외 → `ok` 순으로 첫 번째로
맞는 것을 채택한다. `skipped`(중첩 실행 방지/백오프로 건너뜀) 회차는 "완료된 회차"로 치지
않으므로 3·4번 판정에서 제외된다 — 중첩 건너뜀은 정상 동작이고, 백오프 건너뜀은 그 앞의
`blocked` 회차가 이미 상태를 결정하기 때문이다.

기록이 하나도 없을 때(첫 실행 전)는 오류 대신 "아직 실행 기록이 없습니다"로 안내한다.

### 7.2 `changed` — 왜 지켜봐야 하는 값인가

collector가 회차마다 남기는 `저장 완료 — inserted=N, updated=N, changed=N` 로그와 회차
기록의 `detail.changed`(= 집계용 `itemsChanged` 컬럼)는 **감시 대상 필드(watched fields)가
실제로 바뀐 "물건 수"**다 — 이력 테이블에 쌓인 **행 수**가 아니고, 최초 저장 시의 기준점
(baseline)도 세지 않는다(§6.1). 이 숫자가 운영자가 지켜봐야 할 신호인 이유는 비용과
직결되기 때문이다: 아카이브된 `add-price-change-history` change의 design.md가 계산한
비용 리스크가, 소스가 같은 물건의 값을 회차마다 다르게(예: 유찰횟수가 일시적으로
틀어졌다 복구되는 패턴) 보고하면 그 물건 **하나**가 감시 필드 변경 조건에 걸려 매 회차
재분석 대상으로 재적격되고, 10분 주기 기준 하루 최대 144번의 유료 Claude 호출을 유발할
수 있다는 것이다(§6.2 "왜 쿨다운이 필요한가" 참고 — `reanalysisCooldownHours`가 이
낭비의 상한을 하루 1회로 줄이지만 노이즈 자체를 없애지는 않는다). `changed`가 물건 수
(대개 수백 건 규모)에 비해 비정상적으로 크거나 특정 회차마다 비슷한 값이 반복되면, 바로
이 소스 노이즈로 인한 스퓨리어스 변경이 의심되는 상황이다 — `/status`와
`GET /api/worker-runs`(개별 회차의 `detail.changed`) 양쪽에서 이 값을 볼 수 있다.

### 7.3 `pagesRequested` — 10분 주기가 지속 가능한가를 재는 값

collector 회차 기록의 `detail.pagesRequested`는 그 회차가 소스에 실제로 보낸 요청
페이지 수다 — 설정된 상한(`AUCTIONBOSS_COLLECT_MAX_PAGES`, 기본 50)이 아니라
`AuctionSource.fetchActiveItems()`가 실제로 수행한 요청 수 그대로다(design.md D1).
**로봇탐지 차단으로 회차가 중단된 경우에도, 차단 직전까지 실제로 보낸 페이지 수가 그대로
남는다**(`SourceError.pagesRequested`를 어댑터가 던지고 collector가 그 값으로 detail을
덮어쓴다) — 실패한 회차라고 이 수치가 0이나 설정값으로 뭉개지지 않는다.

이 값이 필요한 이유는 이 프로젝트에서 가장 오래된 미해결 질문 때문이다: **"10분 주기
상시 운용이 이 사이트에서 지속 가능한가"**(`src/lib/sources/courtauction/NOTES.md` §6.1 —
조사 당시 5분에 총 15회 미만의 요청으로도 로봇탐지 차단에 걸렸다). 이전에는 이 질문에
추정치(서울중앙 한 곳·매각기일 2개월 범위 기준 회차당 약 13요청)로만 답할 수 있었는데,
이제 `pagesRequested`가 회차마다 실측값으로 남으므로 `GET /api/worker-runs`로 실제 요청
수 추이를 쌓아 보고 판단할 수 있다(§11 "알려진 한계" 2번 참고).

### 7.4 ⚠️ 쓰기 API에 인증이 없다 — 전체 목록

**이 프로젝트의 인증 없는 쓰기 엔드포인트를 전부 여기 한곳에 모은다.** 현 단계가
로컬/개인 전용 실행이라는 전제(§1, §8, §11)에서만 허용된 것이며, **이 서버가 외부에
노출되는 순간 아래 엔드포인트는 전부 누구나 호출할 수 있는 쓰기 창구가 된다.**

| 엔드포인트 | 무엇을 조작할 수 있는가 | 도입된 change |
| --- | --- | --- |
| `POST /api/worker-runs` | 임의의 워커 회차를 새로 만들 수 있다 | (2회차) add-collection-observability |
| `PATCH /api/worker-runs/[id]` | 임의의 회차 결과(성공/실패/차단)를 조작할 수 있다 | (2회차) add-collection-observability |
| `POST /api/bookmarks` | 임의의 물건을 관심 목록에 등록할 수 있다 | (4회차) add-bookmarks-and-feed |
| `DELETE /api/bookmarks/[itemId]` | 임의의 물건을 관심 목록에서 해제할 수 있다 | (4회차) add-bookmarks-and-feed |
| `POST /api/bookmarks/toggle` | 위 등록/해제를 폼으로 조작할 수 있다(화면 전용, §5) | (4회차) add-bookmarks-and-feed |
| `POST /api/feed/read` | 변동 피드를 읽음 처리(미확인 개수를 0으로)할 수 있다 | (4회차) add-bookmarks-and-feed |
| `POST /api/feed/mark-read` | 위 읽음 처리를 폼으로 조작할 수 있다(화면 전용, §5) | (4회차) add-bookmarks-and-feed |

**`POST /api/worker-runs`/`PATCH /api/worker-runs/[id]`가 노출되면**: `/status` 화면과
`GET /api/worker-runs/summary` 집계는 전부 이 기록으로 계산되므로, 주입된 "성공" 기록이
실제로는 멈추거나 차단된 워커를 정상으로 둔갑시켜 진짜 장애를 감출 수 있다.

**관심 물건·피드 엔드포인트가 노출되면**: 단일 사용자 전제(§6.3)에서 관심 목록·읽음
시각은 전역이므로, 임의의 제3자가 다른 사람이 지켜보던 관심 목록을 마음대로 비우거나
채우고, 읽음 상태를 조작해 미확인 변동을 실제로는 안 읽은 채로 0으로 만들 수 있다 —
데이터 손실은 아니지만(물건 자체는 지워지지 않는다) 이 기능이 보여주려는 정보(무엇을
지켜보고 있었는지, 무엇을 아직 못 봤는지)를 제3자가 조용히 지울 수 있다는 뜻이다.

인증을 도입할 때 위 표의 엔드포인트를 **전부** 포함해야 한다(§11 "알려진 한계" 참고).

## 8. ⚠️ 수집 관련 주의사항

**이 섹션은 읽고 넘어가지 말 것.** 근거는 전부 실측이며
`src/lib/sources/courtauction/NOTES.md` §6.1 / §9와
`openspec/changes/archive/2026-09-07-auction-pipeline-mvp/design.md` D6에 원본 기록이 있다.

- **사이트에 IP 단위 로봇탐지가 있다.** 차단되면 **HTTP 200을 그대로 유지한 채** 본문만
  `{"status":200,"message":"해당 IP는 비정상적인 접속으로 ... 차단되었습니다.","data":{"ipcheck":false}}`
  로 바뀐다. 즉 **상태 코드로는 실패를 감지할 수 없다.** 어댑터는 응답을 3단으로 검사한다:
  (1) 본문이 `{`로 시작하는가(아니면 WAF의 HTML 차단 페이지), (2) `data.ipcheck === true`인가,
  (3) zod로 `data.dlt_srchResult` 스키마 검증.
- **차단은 짧지 않다.** 실측에서 **13분을 넘겨 지속**됐고(쿠키를 새로 받아도 안 풀림 = IP 단위),
  다른 실측에서는 13분 초과 ~ 26분 이하에 해제됐다. 정확한 해제 규칙은 모른다. 그래서 기본 백오프는
  보수적으로 **1시간**이다. 차단을 만나면 재시도는 무의미하다 — 어댑터가 회차를 즉시 중단하고,
  collector가 백오프 창이 닫힐 때까지 tick을 건너뛴다.
- **요청량이 임계에 가깝다.** 조사 때 **5분에 총 15회 미만**으로도 차단됐다. 그런데
  페이지 크기는 서버가 **40행**까지만 받는다(`pageSize=100`은 HTTP 400). 서울중앙 한 곳,
  매각기일 2개월 범위가 약 443~444행이므로 한 회차에 **쿠키 1회 + 페이지 12회 = 13요청**이 나간다
  (`src/lib/sources/courtauction/NOTES.md` §12.1, 2026-09-08 전체 수집 실측치).
  → **10분 주기 상시 운용은 1회차(57초) 기준으로는 지속 가능한 것으로 확인됐다.** 13요청이
  57초에 몰려 나가고 그 뒤 9분 넘게 요청이 전혀 없다 — 위 "5분에 15회 미만" 차단 임계와는
  밀도 자체가 다르다(NOTES.md §12.2). **다만 이것으로 증명된 범위는 딱 그만큼이다: 법원
  1곳 · 단발 1회차.** 며칠 연속 무인 운용에서도 안전한지(누적 요청에 대한 별도 장기 임계가
  있을 가능성), 그리고 법원을 여러 곳으로 늘렸을 때도 안전한지는 **여전히 미검증**이다
  (아래 §11 "알려진 한계" 2번). 차단이 실제로 발생하면 1차 대응은 (a) `intervalMs`를
  늘리거나 (b) `AUCTIONBOSS_COLLECT_BID_WINDOW_DAYS`를 줄여 행 수를 낮추는 것이다.
  - **여러 법원으로 늘렸을 때는 이 임계에 훨씬 가까워진다.** `scope.courts`에 법원을 여러 곳
    등록해도 회차당 예산은 **법원 수**로 잘려 있어서(`scope.maxCourtsPerRun`, §4.1a) 회차당
    요청 수 자체는 크게 안 늘지만, `scope.maxRequestsPerRun`(기본 13)은 여전히 **서울중앙
    1곳 기준 실측값**일 뿐 다른 법원·여러 법원 조합에서 안전하다고 검증된 수치가 아니다.
    법원을 늘렸으면 `GET /api/worker-runs`로 며칠간 `pagesRequested`(§7.3)와 차단(`blocked`)
    발생 여부를 관측한 뒤 `maxRequestsPerRun`을 조정할 것 — 안전한 예산은 아직 추측일 뿐
    실측되지 않았다.
- **브라우저 User-Agent가 필수다.** curl 기본 UA로 보내면 별도 WAF가 JSON 대신 HTML 차단 페이지를
  HTTP 200으로 돌려준다. 어댑터는 고정 UA를 쓰고, 페이지 사이에 기본 5초를 쉬며, 동시 요청을 하지 않는다.
  이 값들을 낮추는 방향으로 조정하지 말 것.
- **법적/약관 상태:** `robots.txt`는 **404**다(명시적 금지 지시자가 없다는 뜻이지, 허용이라는 뜻은 아니다).
  **사이트 이용약관은 아직 검토하지 않았다.** 현 단계는 **개인/내부 열람 용도**를 전제로 하며,
  수집한 데이터를 외부에 재배포·재판매하기 전에 별도의 법적 검토가 반드시 필요하다.

## 9. 개발

```bash
npm test        # vitest run — 실행 시점마다 정확한 개수는 다를 수 있다. 이 문서 작성 시점(scale-
                 # collection-scheduling 반영 후) 실측: 498 tests / 29 files. 최신 수치는 직접 돌려 확인할 것.
npm run typecheck   # tsc --noEmit
npm run lint        # eslint (설정: eslint.config.mjs, next/core-web-vitals + next/typescript)
```

- 테스트 위치 (`vitest.config.mts`가 `src/**/*.test.ts`, `src/**/__tests__/**/*.test.ts`, `workers/**/*.test.ts`를 수집. 개수는 위 참고 — 아래는 대표 파일 목록이며 전체 목록은 아님):
  - `src/lib/db/__tests__/client.test.ts`, `repository.test.ts`, `worker-runs.test.ts`, `collector-state.test.ts`(§4.1a 로테이션 위치 저장소)
  - `src/lib/domain/__tests__/config.test.ts`, `item-query.test.ts`, `types.test.ts`(`WATCHED_FIELDS`가 4개에서 늘지 않는 것을 고정하는 회귀 테스트 — design.md D2), `rotation.test.ts`(§4.1a 원형 로테이션 선택·한 바퀴 소요 시간 순수 함수)
  - `src/lib/sources/courtauction/__tests__/adapter.test.ts` (+ `fixtures.ts`)
  - `src/app/_lib/__tests__/change-history.test.ts`, `analysis-history.test.ts`, `item-extensions.test.ts`(확장 필드 표시·포맷 순수 함수), `item-query-url.test.ts`, `status-display.test.ts`
  - `src/app/api/items/__tests__/route.test.ts`, `src/app/api/items/[id]/changes/__tests__/route.test.ts`, `src/app/api/items/usage-types/__tests__/route.test.ts`
  - `src/app/api/worker-runs/__tests__/route.test.ts`, `src/app/api/worker-runs/[id]/__tests__/route.test.ts`, `src/app/api/worker-runs/summary/__tests__/route.test.ts`
  - `workers/__tests__/analyzer.test.ts`, `analyzer.integration.test.ts`(재분석 두 단계 선정을 실제 저장소·API 라우트로 구동하는 회귀 테스트), `collector.test.ts`(§4.1a 로테이션 연동 포함)
- 테스트는 **네트워크를 타지 않고 실제 DB 파일도 만들지 않는다.** `fetch`, `claude` 실행 함수,
  DB 경로가 전부 주입 지점으로 열려 있어 인메모리 DB와 가짜 fetch로 돈다.
- `npm run build`는 타입 체크와 린트를 함께 수행하므로, 커밋 전 최소 확인은 `npm test && npm run build`다.

### OpenSpec 워크플로

계획·스펙은 코드가 아니라 `openspec/`에서 관리한다.

```
openspec/
  config.yaml
  specs/                       # 확정된(배포된) 스펙
  changes/
    add-collection-observability/  # 진행 중인 change (예 — §7의 근거)
      proposal.md              # 왜 하는가
      design.md                # 설계 결정과 리스크
      specs/                   # 이 change가 더하는 스펙 델타
      tasks.md                 # 실행 단위 태스크 목록
    archive/                   # 완료된 change (예: 2026-09-07-auction-pipeline-mvp/,
                                #                    2026-09-07-add-item-search-filters/,
                                #                    2026-09-07-add-price-change-history/)
```

구현 전에 해당 change의 proposal / design / specs / tasks를 먼저 읽는다.
Claude Code 슬래시 커맨드가 `.claude/commands/opsx/`에 들어 있다:

- `/opsx:propose` — 새 change 제안 + 아티팩트 생성
- `/opsx:apply` — tasks.md의 태스크를 구현
- `/opsx:update` — 진행 중 change의 계획 문서 갱신
- `/opsx:archive` — 완료된 change를 archive로 이동
- `/opsx:sync` — change의 델타 스펙을 `openspec/specs/`에 반영

## 10. 프로젝트 구조

중요한 경로만 추렸다.

```
.
+- config/
|   +- collector.json              # 수집 범위/주기/분석 건수/관측 설정 (§4.1)
+- src/
|   +- app/                        # Next.js App Router
|   |   +- page.tsx                # 물건 목록 (/) — 관심 토글 열 포함 (§6.3)
|   |   +- items/[id]/page.tsx     # 물건 상세 + AI 분석(최신/이전) + 변경 이력 + 관심 토글 (/items/:id)
|   |   +- status/page.tsx         # 워커 상태 화면 (/status, §7.1)
|   |   +- bookmarks/page.tsx      # 관심 물건 목록 (/bookmarks, §6.3)
|   |   +- feed/page.tsx           # 변동 피드 (/feed, §6.3)
|   |   +- api/items/route.ts      # GET /api/items (page, pageSize, analyzed, needsAnalysis,
|   |   |                          #   promptVersion, usage, sido, sigungu, minPrice, maxPrice,
|   |   |                          #   minEok/minMan/maxEok/maxMan, minFailed, q, dateFrom, dateTo,
|   |   |                          #   excludePast, bookmarked, sort, dir — ux-overhaul-phase2)
|   |   +- api/items/[id]/route.ts # GET /api/items/:id
|   |   +- api/items/[id]/changes/route.ts  # GET /api/items/:id/changes
|   |   +- api/items/usage-types/route.ts   # GET /api/items/usage-types
|   |   +- api/analyses/route.ts   # POST /api/analyses
|   |   +- api/worker-runs/route.ts          # GET/POST /api/worker-runs
|   |   +- api/worker-runs/[id]/route.ts     # PATCH /api/worker-runs/:id
|   |   +- api/worker-runs/summary/route.ts  # GET /api/worker-runs/summary
|   |   +- api/bookmarks/route.ts            # GET/POST /api/bookmarks (§5, §6.3)
|   |   +- api/bookmarks/[itemId]/route.ts   # DELETE /api/bookmarks/:itemId
|   |   +- api/bookmarks/toggle/route.ts     # POST /api/bookmarks/toggle (화면 전용 폼, §5)
|   |   +- api/feed/route.ts                 # GET /api/feed
|   |   +- api/feed/read/route.ts            # POST /api/feed/read
|   |   +- api/feed/mark-read/route.ts       # POST /api/feed/mark-read (화면 전용 폼, §5)
|   |   +- _components/item-filter-form.tsx  # 목록 필터·정렬 폼(순수 <form method="get">)
|   |   +- _components/bookmark-toggle-form.tsx # 관심 토글 폼(목록 행·상세 공용, §6.3)
|   |   +- _lib/format.ts          # 금액/날짜 표시 포맷터
|   |   +- _lib/change-history.ts  # 변경 이력 표시 판단(기준점 구별, 가격 변화폭 등) — formatFieldChange를 feed-display.ts와 공유
|   |   +- _lib/feed-display.ts    # /feed 표시 판단(미확인 여부, 변동 요약 문구, §6.3)
|   |   +- _lib/analysis-history.ts # 분석 이력 표시 판단(최신/이전 분리)
|   |   +- _lib/item-query-url.ts  # ItemQuery -> 목록 페이지 URL 직렬화
|   |   +- _lib/filter-chips.ts    # 적용 중인 필터 칩 표시 판단(ux-overhaul-phase2)
|   |   +- _lib/price-input.ts     # 가격 폼(억/만원) 프리셋·입력 초기값 변환(ux-overhaul-phase2)
|   |   +- _lib/safe-redirect.ts   # 관심/피드 폼의 returnTo 검증(오픈 리다이렉트 방지, §6.3)
|   |   +- _lib/feed-query.ts      # GET /api/bookmarks, /api/feed 쿼리 파라미터 검증
|   |   +- _lib/status-display.ts  # /status 표시 판단(상태->라벨/심각도, 소요시간 포맷 등, §7.1)
|   |   +- _lib/worker-run-query.ts # GET /api/worker-runs(/summary) 쿼리 파라미터 검증
|   +- lib/
|       +- domain/                 # 정규화 도메인 모델 + config 로더
|       |   +- types.ts            # AuctionItem, Analysis, ItemChange, FeedEntry, CollectorConfig, WorkerRun ...
|       |   +- config.ts           # config/collector.json 로딩 + zod 검증
|       |   +- rotation.ts         # 법원 로테이션 순수 함수(selectRotationCourts) + computeLapDurationMs (§4.1a)
|       |   +- item-query.ts       # GET /api/items 쿼리 파라미터 파싱(ItemQuery, strict/lenient)
|       +- db/                     # SQLite 접근 (여기 밖으로 snake_case 컬럼명이 안 나간다)
|       |   +- client.ts           # 연결/WAL/싱글턴, AUCTIONBOSS_DB 해석
|       |   +- schema.ts           # items / analyses / item_changes / worker_runs / collector_state / bookmarks / feed_reads 테이블 DDL
|       |   +- repository.ts       # upsertItems, listItems, listUsageTypes, listSidoValues,
|       |   |                      #   listSigunguValues, insertAnalysis, listItemChanges ...
|       |   +- worker-runs.ts      # startRun, finishRun, listWorkerRuns, summarizeRuns, getWorkerStatus (§7)
|       |   +- collector-state.ts  # 로테이션 다음 위치 등 소규모 운영 상태 키-값 저장소 (§4.1a)
|       |   +- bookmarks.ts        # addBookmark, removeBookmark, listBookmarkedItems, listFeed, getUnreadCount, markFeedRead (§6.3, 단일 사용자 전제)
|       +- sources/                # 수집 소스 어댑터 경계
|           +- types.ts            # AuctionSource 인터페이스
|           +- errors.ts           # RobotDetectedError, WafBlockedError ...
|           +- courtauction/
|               +- adapter.ts      # 실제 수집 구현 (페이지 순회 + 3단 검사 + 행 접기)
|               +- schema.ts       # 응답 zod 스키마
|               +- courts.ts       # 법원 코드표 60개
|               +- NOTES.md        # ★ 사이트 내부 API 조사 노트 (수집을 건드리기 전에 읽을 것)
+- workers/
|   +- collector.ts                # 수집 워커 엔트리포인트
|   +- analyzer.ts                 # 분석 워커 엔트리포인트
|   +- lib/
|   |   +- api.ts                  # 서버 HTTP 클라이언트 (DB를 import 하지 않는다)
|   |   +- claude.ts               # claude CLI headless 호출 + 출력 파싱
|   |   +- prompt.ts               # 프롬프트 템플릿 로딩/렌더링, PROMPT_VERSION
|   +- prompts/analyze-item.md     # 분석 프롬프트 템플릿 ({{ITEM_JSON}} 토큰)
+- openspec/                       # 계획/스펙 (§9)
+- data/auctionboss.db             # 기본 DB 파일 (git ignore, 첫 실행 때 생성)
```

## 11. 알려진 한계 / 다음 단계

1. **"진행 중" 필터의 의미가 검증되지 않았다.** 사이트에 진행상태 전용 파라미터를 찾지 못해
   매각기일 범위(`오늘 ~ 오늘+60일`)로 대신하고 있다. 이것이 사이트가 말하는 "진행중"과 같은 개념인지는
   미확인이다(수신 행은 전부 `mulJinYn="Y"`였다). — NOTES §6.2 row 0, §9.3
2. **10분 주기 상시 운용은 "약 15분·법원 1곳" 범위까지만 검증됐다 — 며칠 단위는 여전히 안 됐다.**
   §8 참고. 2026-09-08 단발 실측(NOTES.md §12)에 이어, hardening-round2(11회차,
   NOTES.md §14)가 처음으로 서버+수집기+분석기를 **동시에 상주시켜 자동 반복**을
   관측했다 — 수집 범위를 60일에서 4일로 좁혀 회차를 가볍게 하고 주기(600000ms)는
   그대로 뒀다(design.md D1). 결과: 실제 수집 5회차(overlap 테스트 1회 포함)가
   차단 없이 성공했고, 중첩 방지·회차당 5건 분석 한도·보관 상한(`maxRunsPerWorker`)이
   전부 실제로 작동하는 것을 확인했다(자세한 수치는 NOTES.md §14). **그래도 이건 약
   15분·5회차의 결과일 뿐이다.** 아직 증명되지 않은 것:
   - **며칠 연속 무인 운용.** 누적 요청에 대한 별도의 장기 차단 임계가 있을 가능성을
     배제할 수 없다 — 이번 실측도 그 질문에 답하지 않는다. 필요한 것: 실제로 며칠간
     띄워 두고 `GET /api/worker-runs`로 차단·실패 여부를 관찰하는 것뿐이다(코드 변경
     불필요 — 회차 기록 인프라는 이미 있다).
   - **법원을 여러 곳으로 늘렸을 때 안전한 요청 예산.**(§4.1a, §8) 법원 수 단위 예산
     (`maxCourtsPerRun`)과 요청 수 안전장치(`maxRequestsPerRun`)를 둬서 구조적으로는 법원이
     늘어도 회차가 무한정 커지지 않게 만들었지만(scale-collection-scheduling),
     `maxRequestsPerRun`의 기본값 자체는 여전히 법원 1곳 기준 실측치다. 실제로 몇 곳까지
     늘려도 안전한지는 회차 기록이 며칠 쌓여야 정할 수 있다.
   - **실제 재수집에서 노이즈(가짜 변경)가 얼마나 나오는지.** 11회차의 반복 재수집
     3회차 전부 `changed=0`이었다 — 감시 필드가 소스 쪽에서 흔들리는 사례는 이번에도
     한 번도 관측되지 않았다. §11 8번의 노이즈 필터링 질문은 여전히 실데이터 부재로
     열려 있다.

   §7.3의 `pagesRequested`가 회차마다 실측값으로 남으므로, `GET /api/worker-runs`로 이
   질문들에 대한 데이터를 계속 쌓아 갈 수 있다.
3. **비공식 엔드포인트라 예고 없이 바뀔 수 있다.** zod 검증으로 즉시 감지·로그하지만, 바뀌면 수집은 멈춘다.
   대안인 **상용 데이터 API 어댑터는 아직 구현되어 있지 않다**(`AuctionSource` 인터페이스만 열려 있는 상태).
4. **프롬프트가 여전히 물건 JSON 한 덩어리만 보고 쓰는 요약이다(v2에서 확장 필드 활용은
   늘었다).** 시세 비교·등기부·권리관계·임차인 정보는 여전히 없다 — **권리관계·임차인·등기
   정보는 애초에 이 소스에 존재하지 않으므로**(§5 "확장 필드" 문단, `NOTES.md` §10.3) 프롬프트를
   더 다듬어도 이 정보는 얻을 수 없다.
   - 이전에 여기 적혀 있던 "모델이 `minArea` 등이 실제로 값을 갖고 있는데도 '정보 없음'으로
     응답한 사례"는 **모델 문제가 아니라 코드 결함이었고, 원인을 찾아 고쳤다**(2026-09-08,
     live-data-and-reports 4단계 — `NOTES.md` §12.4). analyzer가 쓰는 zod 스키마
     (`workers/lib/api.ts`)가 확장 필드 32개를 몰라 서버 응답에서 조용히 strip하고 있었다
     — 그래서 분석 23건이 전부 실제로는 있는 값을 "정보 없음"이라고 답했다. 수정 후 생성된
     5건은 실제 수치를 낸다. 프롬프트가 지시한 계산(면적당 가격, 차수별 저감 추이) 자체를
     모델이 안 따르는 문제는 아니었다는 뜻이다 — 다만 그 계산에 쓰이는 `minArea`/`maxArea`가
     186/389건(48%)에서 `minArea > maxArea`로 뒤바뀐 채 들어오는 **별도의 데이터 손상
     문제**가 있었다(`NOTES.md` §13.2). **ux-overhaul-phase1(§6.5)이 이 문제를 표시
     계층에서 정직하게 드러내는 데까지 해결했다** — 역전된 물건은 범위로 잇지 않고 두
     값을 병기하며, `computePricePerArea`가 반환하는 `basisArea`/`basisField`를 화면과
     분석 프롬프트 양쪽이 "어느 면적을 썼는지" 밝힌다. **그러나 `minArea`/`maxArea`가
     실제로 무엇을 뜻하는지(대지권/전유면적인지 토지/건물인지)는 여전히 미확인이다** —
     소스 재조사 없이는 어느 값이 "맞는" 면적인지 결정할 수 없고, 이번 change도 그 판단을
     의도적으로 미뤘다(design.md D2 Open Questions). 분석 본문에 담긴 사실 관계·서식
     문제 전반은 `NOTES.md` §13에 물건별 인용과 함께 정리해 뒀다.
   - 분석 본문은 markdown이지만, 실제 보고서 28건을 세어 보니 굵게(`**...**`, 25/28건)와
     인라인 코드(`` `...` ``, 6/28건) 둘만 쓰이고 목록·제목·표는 전혀 없었다 — 그래서
     마크다운 라이브러리 없이 이 두 구문만 처리하는 순수 파서를 만들었다
     (`src/app/_components/analysis-body-parse.ts`/`analysis-body.tsx`, XSS 안전성 테스트
     포함). **이 컴포넌트를 상세 페이지(`src/app/items/[id]/page.tsx`)에 배선하는 작업은
     hardening-round1(10회차) task 1에서 끝났다** — 8회차는 그 파일이 동시 진행 중인
     다른 change의 소유라 컴포넌트만 만들고 배선을 넘겼는데, 그 change가 아카이브된 뒤에도
     한 사이클(9회차) 동안 배선이 안 된 채로 남아 화면이 `<pre>`로 `**` 리터럴을 그대로
     보여주고 있었다. 지금은 굵게/인라인 코드가 실제 태그로 렌더되고,
     `<script>`처럼 보이는 텍스트는 항상 이스케이프된 텍스트로만 나온다(실서버 확인 완료,
     회귀 렌더 테스트로 고정: `src/app/items/[id]/__tests__/page.render.test.ts`).
5. **워커가 죽으면 수동 재시작이다.** 프로세스 매니저(pm2 등)나 재시작 정책이 없다. 시작/종료 로그로
   감지만 가능하다. 배포 단계에서 도입 예정. **워커가 회차 도중 죽으면 `worker_runs`에
   `outcome='running'`·`finished_at=NULL`인 고아 행이 영구히 남는다(11회차 실증,
   NOTES.md §14.4).** cycle 10이 우연히 발견한 사례를 11회차가 `SIGKILL`로 재현해
   확인했다 — `getWorkerStatus`는 이 고아 행이 아니라 그 뒤에 성공한 더 최신 회차를
   기준으로 판단하므로 워커 전체 상태(`/status`)는 오판되지 않고, 고아 행 자체는
   "최근 회차" 목록에 실행 경과 시간이 계속 늘어나는 "진행 중" 항목으로만 남는다.
   `observability.maxRunsPerWorker` 보관 상한이 결국 이 고아 행도 오래된 순으로
   지워 정리한다(정리 기준은 `outcome`이 아니라 `started_at` 순서이므로, 나중에
   추가되는 정상 회차들에 밀려 자연히 없어진다) — 다만 그 사이 시간 동안은 "진짜 죽은
   회차"와 "그냥 오래 걸리는 회차"를 사람이 시간 값을 보고 구별해야 한다는 한계는
   여전하다.
6. **목록 화면 필터에는 UI가 없는 조건도 있다.** 용도·지역(시/도·시/군/구)·가격대(억/만원
   입력+프리셋)·유찰횟수·소재지 키워드·매각기일 범위·지난 기일 제외·관심 물건·정렬·페이지
   크기는 `ItemFilterForm`(`src/app/_components/item-filter-form.tsx`)으로 붙어 있다(폼은
   `<details>`로 접혀 있다가 필터가 걸리면 펼쳐진다, ux-overhaul-phase2). 다만
   `analyzed`(분석 여부)는 URL로는 받아 유지하지만 폼에 입력칸이 없고, `needsAnalysis`는
   analyzer 전용이라 애초에 사람이 쓸 UI가 없다. `dong`(읍/면/동) 필터도 아직 없다(관악구만
   동이 수십 개라 체크박스가 감당하지 못한다).
7. **인증/권한이 없다.** 서버를 띄우면 접근 가능한 누구나 전체를 볼 수 있다. 로컬/내부망
   전제다. **인증 없는 쓰기 엔드포인트 전체 목록은 §7.4에 한곳에 모아 뒀다** — 워커 회차
   기록(§7.4)뿐 아니라 관심 물건 등록/해제·읽음 처리(§6.3, add-bookmarks-and-feed)까지
   전부 인증이 없다. 인증 도입 시 그 표의 엔드포인트를 전부 포함해야 한다.
8. **가짜 변경(노이즈)을 걸러내는 규칙이 없다.** 소스가 같은 물건을 다른 값으로 표기하는
   사례가 이미 관측됐다(`유찰횟수`와 `최저매각가격`이 어긋나는 행 — `openspec/changes/archive/
   2026-09-07-auction-pipeline-mvp/design.md`). 그런 노이즈도 지금은 감시 필드의 "실제
   변경"으로 그대로 기록되고 재분석을 유발한다 — §6.2의 `reanalysisCooldownHours`(기본
   24시간)가 **비용의 상한**(물건당 하루 최대 1회 재분석)은 실질적으로 막아 주지만, 노이즈
   자체를 감지·거부하거나 이력에서 지우지는 않는다. 즉 잘못된 값이 하루 한 번씩은 계속
   "실제 변경"으로 기록되고 화면에도 그대로 보인다 — 쿨다운은 지혈이지 치료가 아니다.
   필터링 규칙 자체는 여전히 미정이다(`openspec/changes/archive/2026-09-07-add-price-change-history/design.md`
   Open Questions) — 실제 변경 이력을 며칠 관측한 뒤에 정할 예정이다.
9. **"최근 변동" 기준 7일이 검증된 값은 아니다.** 매각기일 주기(보통 1개월 이상)를 감안하면
   더 길어야 할 수 있다. `src/app/_lib/change-history.ts`의 `RECENT_CHANGE_DAYS` 상수 하나만
   바꾸면 되므로 조정 자체는 쉽다.
10. **관심 목록·읽음 시각이 사용자 구분 없이 전역이다(§6.3).** 여러 사람이 같은 서버를
    쓰면 관심 목록도, "여기까지 읽었다"는 기준도 전부 공유된다. 다중 사용자를 지원하려면
    `bookmarks`/`feed_reads` 두 테이블에 `user_id`를 추가하고 `src/lib/db/bookmarks.ts`의
    모든 조회·쓰기에 그 조건을 더해야 한다 — 지금은 이 조건이 아예 없다.

## 12. Open Questions 최종 정산 (hardening-round2, 11회차, 2026-09-09)

아카이브된 모든 change(`openspec/changes/archive/*/design.md`)의 Open Questions를
전부 다시 훑어 최종 상태를 매겼다. 총 20개(각 change의 미해결 항목 합, hardening-round1
자신의 1개 포함) 중 **답함/결정됨 11개, 여전히 열림 9개**다. "여전히 열림"은 전부
**무엇이 있어야 답할 수 있는지**까지 적는다 — "미해결"만 남기면 다음 사람이 같은
고민을 반복한다(design.md D4).

**답함 / 이미 결정돼 구현됨(11개)**:

| # | 질문(출처) | 최종 상태 |
|---|---|---|
| 1 | 목록 기본 정렬(add-item-search-filters) | `auctionDate` asc 유지로 확정·구현됨(`DEFAULT_SORT_KEY`) |
| 2 | 목록 필터 우선순위(auction-pipeline-mvp) | 용도·가격대 모두 이후 change에서 구현됨(ux-overhaul-phase2) — 질문 자체가 무의미해짐 |
| 3 | `stale` 배수 3이 적절한가(add-collection-observability) | **11회차가 실측으로 답함**: 실제 회차 소요 시간(수집 15~16초, 분석 1~2분)이 주기(10분)에 비해 훨씬 짧아, 배수 3(임계 30분)은 정상 실행을 오탐하지 않는 충분히 넉넉한 값이다(NOTES.md §14.2) |
| 4 | 집계 기간 고정 여부(add-collection-observability) | "최근 24시간"으로 고정 구현됨(`/status`) |
| 5 | 피드 기본 범위(add-bookmarks-and-feed) | "전체 포함"으로 확정·구현됨(`src/app/api/feed/route.ts` 주석) |
| 6 | 저감률 구간 수(improve-item-discovery-ux) | 4단계→6단계로 실측 분포에 맞춰 확정·구현됨(ux-overhaul-phase1) |
| 7 | 면적당 가격 없는 물건 비율(improve-item-discovery-ux) | **11회차가 실측으로 답함**: 389건 중 면적 정보가 전혀 없는 물건은 4건(1%)뿐 — 열의 가치가 충분히 있다(단, 면적 역전 186건(48%)은 별개 문제로 이미 §6.5가 처리) |
| 8 | 면적당 가격 정렬 노출 여부(enrich-item-fields) | `pricePerArea` 정렬 키로 구현됨 |
| 9 | 마크다운 렌더링 도입 여부(live-data-and-reports) | hardening-round1이 도입 결정 + 구현·배선 완료 |
| 10 | 불일치 판정 임계(ux-overhaul-phase1) | 15퍼센트포인트로 확정·구현됨(`RATE_MISMATCH_THRESHOLD_PP`) |
| 11 | 렌더 테스트 도입 여부(hardening-round1 자체) | 도입 결정 + 유지 |

**여전히 열림(9개) — 무엇이 있어야 답할 수 있는지**:

| # | 질문(출처) | 왜 여전히 열려 있는가 | 무엇이 있어야 답하는가 |
|---|---|---|---|
| 1 | 가짜 변경(노이즈) 필터링 규칙(add-price-change-history) | 11회차가 실제 재수집을 3회차 돌렸지만 `changed=0`(NOTES.md §14.2) — 노이즈 사례 자체가 여전히 한 번도 관측되지 않았다 | 실제 노이즈가 발생하는 물건이 나타날 때까지 며칠~몇 주의 실제 수집 이력 |
| 2 | "최근 변동" 7일 기준(add-price-change-history) | 위와 같은 이유 — 판단할 실제 변경 사례 자체가 없다 | 위와 동일 |
| 3 | `yuchalCnt`/`minBidPrice` 어긋남의 원인(auction-pipeline-mvp) | 상세 엔드포인트(`selectAuctnCsSrchRslt.on`)를 이번에도 호출하지 않았다(NOTES.md §10 조사만 있음, 실호출 없음) | 그 엔드포인트를 실제로 호출해 사건별 이력을 대조 — 별도의 저강도 조사(NOTES.md §10.6 권고)가 선행돼야 함 |
| 4 | 안전한 다법원 `maxRequestsPerRun`(scale-collection-scheduling) | 11회차도 법원 1곳으로만 관측했다(design.md D1이 범위를 좁히라고 했지, 법원을 늘리라고 하지 않음) | 실제로 법원 2곳 이상을 설정하고 며칠 돌려 회차 소요·요청 수 실측 |
| 5 | 법원별 물건 수 편차로 인한 예산 비효율(scale-collection-scheduling) | 위와 같은 이유 — 다법원 실측 자체가 없다 | 위와 동일 |
| 6 | 차수별 최저가를 감시 대상에 넣을지(enrich-item-fields) | 실제 변경 이력이 없어(위 1·2와 같은 원인) 1차와 2차 이상이 실제로 어떻게 다르게 움직이는지 볼 데이터가 없다 | 위 1·2와 동일 — 실제 변경 이력 축적 |
| 7 | `min_area`/`max_area`의 진짜 의미(ux-overhaul-phase1) | 소스(courtauction.go.kr) 재조사가 전혀 진행되지 않았다 — 이번 사이클도 네트워크 조사를 안 했다 | 소스의 물건 상세/도움말 등을 다시 조사하거나, 알려진 몇 건을 실제 등기부·집합건축물대장과 대조 |
| 8 | 며칠 연속 무인 운용의 안전성(live-data-and-reports, scale-collection-scheduling) | 11회차가 최초로 다중 회차 연속 운용을 관측했지만 창이 **약 15분**뿐이었다(NOTES.md §14) | 실제로 며칠간 서버·수집기·분석기를 띄워 두고 `worker_runs`로 차단·실패 유무 관찰 — 코드·인프라는 이미 충분하다 |
| 9 | `dong`(읍/면/동) 필터가 필요한 시점(ux-overhaul-phase2) | **11회차가 부분적으로 답함**: 현재 규모(389건)에서는 `sido`+`sigungu`+용도+유찰횟수 조합만으로도 강남구 같은 큰 구가 24건까지 좁혀졌다(§6.4) — 지금 규모에서는 `dong` 없이도 충분하다. 다만 물건 수가 몇 배로 늘었을 때도 그런지는 미확인 | 물건 수가 지금보다 크게 늘었을 때(예: 법원이 여러 곳으로 늘어난 뒤) 같은 조합으로 좁혀지는지 재확인 |

이 정산 자체가 다음 사이클(있다면)의 시작점이다 — "여전히 열림" 9개 중 6개는 **결국
같은 조건**(실제 변경 이력이 쌓이는 것, 며칠 연속 운용)에 막혀 있다. 이 프로젝트를
계속 운영하면 시간이 지날수록 저절로 풀리는 질문들이지, 코드를 더 고쳐서 풀 수 있는
질문이 아니다.


---

## 13. 1단계: Spring Boot + MySQL 읽기 API (add-spring-mysql-backend, 2026-10-08)

이 절은 1단계(읽기 API 5종을 Spring Boot + MySQL로 옮기는 작업)가 끝난 시점의 실측값과 남은 공백을 적는다. 모든 수치는 이 절을 쓰는 날 직접 다시 센 값이다.

### 13.1 테스트 수

| 구분 | 시작 | 현재 | 비고 |
|---|---|---|---|
| TypeScript(`npm test`) | 766 | 791 | 53개 파일 통과 |
| 백엔드(`./gradlew clean check`) | 0 | 215 | 18개 클래스, 실패·건너뜀 0. 계약 테스트 90개와 N+1 회귀 테스트 5개(8.2)를 포함 |

줄어든 테스트는 없다.

### 13.2 계약 테스트

기존 Next.js 라우트 핸들러의 응답을 골든 90개로 저장해 두고(`backend/src/test/resources/contracts/`), Spring 응답을 같은 요청으로 받아 JSON 단위로 비교한다. 결과는 90개 중 불일치 0건이다. 분류는 파일 이름 접두어로 다시 센 값이다.

| 분류 | 개수 |
|---|---|
| 목록(`list-`) | 14 |
| 페이지 경계(`page-`) | 4 |
| 필터(`filter-`) | 35 |
| 상세(`detail-`) | 6 |
| 변경 이력(`changes-`) | 5 |
| 용도 목록(`usage-`) | 1 |
| 400 오류(`error-400-`) | 20 |
| 404 오류(`error-404-`) | 5 |
| 합계 | 90 |

커밋 메시지(09aa866)에 "필터 39종"이라고 적힌 것은 오기이고, 실제 필터 골든은 35개다.

골든에서 일부러 뺀 요청은 `excludePast`(지난 기일 제외)와 `needsAnalysis`(재분석 후보)의 정상 응답이다. 두 요청은 응답이 요청한 시각에 따라 달라져서, 오늘 만든 골든이 내일은 맞지 않는다. 두 요청의 400 사례(잘못된 값, `promptVersion` 누락)는 시각과 무관하므로 골든에 들어 있다. 제외한 정상 응답은 고정 `Clock`을 주입한 백엔드 단위 테스트(`ItemSearchRepositoryTest`)가 지킨다.

### 13.3 변이 시험

계약 테스트가 정말 어긋남을 잡는지 확인하려고 Spring 쪽 코드에 일부러 결함 10종을 넣어 봤다. 9종은 계약 테스트가 실패해서 포착했다. 생존한 1종은 "밀리초가 0인 시각"(`.000Z`가 `Z`로 줄어드는 직렬화 결함)이며, 골든 데이터에 밀리초가 0인 시각이 한 건도 없어서 계약 테스트는 통과했다. 이 결함은 시각 직렬화기 단위 테스트가 포착한다.

여기서 얻은 관찰은 계약 테스트가 "데이터에 있는 경우"만 지킨다는 점이다. 골든에 없는 값 모양은 계약 테스트로는 막을 수 없으므로 단위 테스트가 따로 맡아야 한다.

### 13.4 N+1 회귀 테스트(8.2)

`QueryCountTest`가 요청 1회가 실행한 SQL 문 수를 센다. 측정은 Hibernate `Statistics.getPrepareStatementCount()`로 하며, `generate_statistics=true`는 이 테스트 컨텍스트에만 켠다. 새 의존성이 필요 없고, 지연 로딩이 뒤에서 내는 쿼리도 같은 곳에서 잡히기 때문에 이 방식을 택했다. 같은 요청을 물건 4건과 30건(분석 2건짜리 15건, 이력 10건, 관심 8건이 섞임)에서 각각 재서 값이 같은지 확인한다.

| 요청 | SQL 문 수(4건) | SQL 문 수(30건) | 구성 |
|---|---|---|---|
| 기본 목록(`pageSize=50`) | 2 | 2 | 목록 SELECT 1 + COUNT 1 |
| `analyzed=false&sort=bidRatio&dir=desc` | 2 | 2 | 목록 SELECT 1 + COUNT 1 |
| `needsAnalysis=true&promptVersion=v3` | 2 | 2 | 목록 SELECT 1 + COUNT 1(30건 중 15건이 후보) |
| 상세 `GET /api/items/{id}` | 2 | 2 | 물건 SELECT 1(서브쿼리 컬럼 포함) + 최신 분석 SELECT 1 |
| 변경 이력 `GET /api/items/{id}/changes` | 2 | 2 | 존재 확인 1 + 이력 SELECT 1 |

목록의 `lastChangedAt`과 `bookmarked`는 스칼라 서브쿼리로 같은 SELECT에 들어 있어 행마다 쿼리가 생기지 않는다. 변이로 확인한 결과는 다음과 같다. 목록 변환 루프에서 행마다 분석 개수를 세는 쿼리를 일부러 넣으면 목록 3개 사례(기본, 필터·정렬, needsAnalysis)가 실패했고(2가 아니라 행 수만큼 늘어남), 코드를 원복하자 다시 통과했다.

### 13.5 EXPLAIN

시드 809건이 들어 있는 MySQL 8.4.11(개발용 컨테이너)에서, Hibernate가 실제로 만든 SQL(`spring.jpa.show-sql`)에 로그의 바인딩 값을 채워 `EXPLAIN FORMAT=TRADITIONAL`을 실행했다. 목록 SELECT 본문에는 물건 컬럼 전체와, 서브쿼리 컬럼 2개(`item_changes`의 `MAX(changed_at)`, `bookmarks` 존재 여부)가 들어 있다. `rows`는 MySQL의 추정치라 실제 809와 조금 다르다(787).

| 요청 | 주 테이블 type | key | rows | Extra |
|---|---|---|---|---|
| 기본(매각기일 정렬) | ALL | NULL | 787 | Using filesort |
| `sort=bidRatio&dir=desc` | ALL | NULL | 787 | Using filesort |
| `q=관악` | ALL | NULL | 787(filtered 29.76) | Using where; Using filesort |

세 쿼리 모두 서브쿼리 두 개는 DEPENDENT SUBQUERY이고 인덱스를 쓴다(`bookmarks`는 PRIMARY의 eq_ref, `item_changes`는 `idx_item_changes_item_id`의 ref, 추정 4행).

해석은 다음과 같다.

- 기본 정렬은 `auction_date` 인덱스를 쓰지 못했다. 정렬 키 맨 앞에 "NULL이면 1, 아니면 0"을 두는 식(`CASE WHEN auction_date IS NULL ...`, NULL을 방향과 무관하게 뒤로 보내려는 규칙)이 있어서 MySQL이 인덱스 순서를 정렬에 쓸 수 없다. `idx_items_auction_date`는 이 목록에서는 정렬용으로 쓰이지 않고, 기일 범위 필터에서나 쓰일 수 있다.
- `bidRatio` 정렬은 계산식(`min_bid_price / appraisal_price`)이 정렬 키라서 인덱스를 쓸 수 없고 filesort가 날 수밖에 없다. 이는 예상한 결과다.
- 키워드 검색은 `LIKE '%관악%'`처럼 앞에 와일드카드가 붙어 인덱스를 쓸 수 없고 전체 스캔이다.
- `idx_items_min_bid_price`, `idx_items_usage_type`을 쓰는 쿼리는 이 3개에 없어 이번에는 확인하지 못했다. 가격·용도 필터 쿼리는 따로 재야 한다.
- 809건 규모에서는 전체 스캔 + filesort도 응답 시간에 문제가 되지 않았다(13.6). 개선(예: 계산식을 생성 열로 두고 인덱스, NULL 순서를 인덱스에 맞게 바꾸기)은 건수가 크게 늘어 측정 근거가 생길 때 검토한다. 지금은 하지 않는다.

### 13.6 응답 시간

시드 809건, 맥 한 대, 로컬 Docker MySQL 8.4(Spring) 대 프로세스 안 SQLite(기존 Next 앱을 `next start`로 띄움, 원본 DB 복사본)에서 같은 요청을 직렬로 보냈다. 요청마다 워밍업 5회 후 `curl -w '%{time_total}'`로 30회를 쟀다. **부하 테스트가 아니다.** 단일 요청을 순서대로 보낸 값이며 동시성, 캐시 압박, 콜드 스타트는 반영하지 않았다. 두 구현은 같은 데이터(809건)를 쓴다.

| 요청 | Spring p50 | Spring p95 | Spring max | Next p50 | Next p95 | Next max |
|---|---|---|---|---|---|---|
| 기본 목록(`pageSize=20`) | 14.7 | 20.7 | 21.2 | 2.3 | 3.8 | 5.5 |
| `sort=bidRatio&dir=desc` | 13.1 | 16.6 | 20.2 | 2.1 | 2.4 | 2.4 |
| 키워드 검색(`q=관악`) | 13.6 | 15.2 | 16.2 | 2.3 | 2.6 | 2.6 |
| 상세(`/api/items/{id}`) | 9.9 | 15.1 | 16.2 | 1.6 | 2.0 | 2.1 |

단위는 밀리초다. 같은 측정을 한 번 더 했을 때도 비슷했다(Spring p50 8~13, Next p50 1~2). 두 번째 실행에서 Spring 목록의 max가 39.9로 한 번 튀었다.

Spring이 Next보다 p50 기준 약 6배(표의 p50 비율 5.9~6.4배) 길지만 절대값은 모두 한 자리~두 자리 밀리초다. 가능한 원인은 Spring 쪽이 네트워크(로컬 Docker) 너머의 MySQL을 불러야 하고(요청당 2회 왕복), JPA 엔티티 변환과 Jackson 직렬화를 거치며, Next는 같은 프로세스 안의 SQLite를 동기 호출한다는 점이다. 이 측정만으로 원인을 분리하지는 못했고, 시간이 문제가 될 때 프로파일링으로 가려야 한다. 두 구현의 차이를 크게 해석하지 않는다.

### 13.7 남은 방어 공백

지금까지 회귀 검증에서 나온, 아직 테스트나 장치가 막지 못하는 부분이다.

1. Dockerfile과 compose 구성은 스모크 스크립트(`scripts/docker-smoke.sh`)를 사람이 직접 돌릴 때만 검증된다. CI의 자동 게이트가 아니다.
2. 분석 워커가 쓰는 재분석 조회(`needsAnalysis`)의 정상 응답은 골든 밖이다. 백엔드 단위 테스트로만 지킨다.
3. 북마크와 사진 데이터는 시드에 0건이다. 이 값이 채워진 응답의 모양은 실데이터 골든으로는 비교한 적이 없다(단위 테스트로만 확인).
4. MySQL 기본 collation은 대소문자를 구분하지 않아, `promptVersion`처럼 대소문자가 다른 값이 같다고 비교될 수 있다. SQLite는 구분했다. 지금은 해당하는 데이터가 없어 드러나지 않는다.
5. 500 응답의 문구가 라우트마다 통일되어 있지 않다. 공통 오류 문구로 모으는 작업이 남았다.
6. 계약 테스트는 골든 데이터에 있는 값 모양만 지킨다(13.3의 밀리초 0 시각 사례).
7. 가격·용도 필터 쿼리의 실행 계획과 큰 규모에서의 응답 시간은 측정하지 않았다(13.5, 13.6).

### 13.8 마무리 중 고친 compose 결함 (2026-10-08)

7장 보고서를 쓰다가 compose의 필수 변수 검사(`${VAR:?}`)가 파일 전체에 적용된다는 것을 발견했다. compose는 파일을 한 번에 치환하므로 `.env`가 없으면 새 `mysql`·`backend`뿐 아니라 기존 `web`·`collector`·`analyzer`도 `docker compose config` 단계에서 실패했다. 스펙의 "기존 경로 무영향"을 어긴 것이고, 7장 회귀 검증은 `.env`를 숨겼을 때 오류가 나는지만 확인해 놓쳤다. `:-`(빈 기본값)로 바꿔, 값이 없으면 MySQL 컨테이너가 기동 시점에 "password option is not specified"로 스스로 실패하게 했다. 비밀번호는 여전히 저장소에 두지 않는다. 같은 때 `backend`의 8080 포트를 `127.0.0.1`에만 열도록 묶었다(인증 없는 API). 수정 후 `.env` 없이 `docker compose config web`이 성공하고, `.env`를 되돌린 뒤 `scripts/docker-smoke.sh`가 통과했다.

## 14. 1-B: 사진 워커와 배포 설정 결함 수정 (2026-10-08)

### 14.1 결함

- 완료로 체크되어 있었지만 구현되지 않았던 add-item-photos 항목: C.4(실패 물건이 매번 재시도되어 대기열을 막지 않는 조회), D.3(회차 기록), D.4(차단 백오프 공유), D.5(양방향 테스트). 사진 워커는 실패 물건을 매 회차 다시 요청했고, 회차 기록과 공유 백오프가 없었다.
- 사진 워커가 `AuctionSource` 어댑터를 우회해 소스를 직접 호출했다.
- compose와 K8s가 분석 워커에 넘긴 주소 값(`http://web:3000` 등)은 맞았지만, 변수 이름이 `BASE_URL`이라 코드가 읽는 `AUCTIONBOSS_API_BASE`와 달랐다. 그래서 코드는 기본값 `localhost:3000`으로 요청해 컨테이너 안에서 서버를 찾지 못했다.
- Next 이미지에 curl이 없는데 헬스체크가 curl을 썼다.
- Dockerfile이 `tsconfig`를 복사하지 않아 컨테이너의 analyzer가 기동 중 죽었다.
- 기본 분석 모델이 은퇴한 Claude 모델이었다.

### 14.2 고친 방식

- 사진 워커를 어댑터 경유, 상주 루프, 회차 기록, 재시도 간격(`items.photo_attempted_at`)으로 다시 썼다. 수집 워커와 사진 워커가 `collector_state.backoff_until` 하나를 공유한다.
- 설정은 `config/collector.json`의 `photos` 절과 `AUCTIONBOSS_PHOTOS_*` 환경 변수로 뺐다.
- compose에 `photos` 서비스를 추가하고, web 헬스체크를 Node 전역 `fetch`(200만 정상)로 바꿨다. 분석 워커 주소를 변수로 받는다. Dockerfile에 `tsconfig`를 추가했다.
- Claude API 호출을 공식 SDK로 바꾸고 기본 모델을 `claude-opus-5-5`로 했다.
- CI에 OpenSpec 스펙·change 검증 단계를 추가했다.

### 14.3 검증

- 테스트 수: TypeScript 796 → 884, 백엔드 215 → 216.
- 변이 시험: 구현 변이 10종과 회귀 검증 단계의 변이 15종을 모두 테스트가 잡았다.
- 실측: 소스에 사진 1건을 요청하는 데 요청 2회, 사진 16장을 받았다. 공유 백오프는 실제 차단이 아니라 `collector_state.backoff_until`을 30분 뒤로 직접 기록하는 방식으로 확인했다. 그 상태에서 수집 워커와 사진 워커를 한 번씩 실행하자 둘 다 `skipped(backoff)`로 기록했고 외부 요청은 나가지 않았다. 실제 차단에서 양방향으로 전파되는 것은 단위 테스트(양쪽 변이 포착)로만 확인했다.

### 14.4 남은 공백

- MySQL V2 마이그레이션을 데이터가 있는 DB에 적용하는 경로를 검증하는 테스트가 없다.
- 수집 워커에 `--once` 옵션이 없다.
- 한쪽 워커의 차단이 다른 쪽에 전파되는 것을 확인하는 통합 테스트가 없다(실측으로만 확인).

## 15. 2단계: Spring 쓰기 API와 분석 워커 연결 (add-spring-write-api, 2026-10-09)

이 절은 2단계(쓰기·나머지 API 이식과 분석 워커 무수정 연결 검증)가 끝난 시점의 실측값과 남은 공백을 적는다. 수치는 이 절을 쓰는 날 직접 다시 센 값이다.

### 15.1 계약 비교

기존 Next 핸들러와 Spring에 같은 요청을 같은 순서, 같은 고정 시각으로 보내 응답을 비교하는 시나리오 골든을 만들었다. 시나리오 7개, 115단계다(`worker-runs-lifecycle`, `worker-runs-errors`, `worker-runs-prune`, `bookmarks-feed`, `bookmarks-errors`, `analyses`, `photos`). 최종 결과는 115단계 모두 일치다. 1단계의 읽기 골든 90개도 계속 일치한다.

- 불일치 1건: `worker-runs-lifecycle` 19단계(`summary?since=...+09:00`). 원인은 Next 쪽 버그였다. `since`를 SQLite에서 문자열로 비교해 시간대 오프셋을 UTC로 바꾸지 않았고, 같은 순간의 `...Z`와 결과가 달랐다(Next 0건, Spring 4건). Spring이 아니라 Next를 고쳤다(`since`를 UTC ISO로 정규화). 계약 테스트가 기존 구현의 버그를 찾은 사례다. 이식 실수로 생긴 불일치는 0건이다.
- 컬럼 길이 차이: Next(SQLite)가 받는 입력을 MySQL 컬럼 길이 때문에 Spring이 500으로 거부했다(`prompt_version` 20자, `model` 100자, `body` 약 65KB). Flyway V3로 넓혔다(VARCHAR(255), VARCHAR(255), MEDIUMTEXT).
- 의도된 차이: 회차 종료 `detail.changed`의 소수와 INT 초과 값. 호출자는 항상 0 이상 정수이므로 맞추지 않았다(design.md D4).
- 변이 3종(관심 정렬 방향, 읽음 응답의 `lastReadAt` 출처, 분석 저장 상태 코드 201→200)을 모두 시나리오 테스트가 잡았다.

### 15.2 EXPLAIN (관심 목록·피드)

개발용 MySQL 8.4(시드 809건)에 Spring을 `local,seed` 프로필로 띄우고, `spring.jpa.show-sql`과 바인딩 로그로 Hibernate가 실제로 낸 SQL을 얻었다. 관심 0건이면 계획이 무의미해서 관심 물건 9건(변경 이력이 있는 물건)을 담고 `EXPLAIN`을 실행한 뒤 모두 지웠다. 물건 컬럼 전체는 계획에 영향이 없어 일부 줄였고, 조인·정렬·조건·서브쿼리는 로그 그대로다. `rows`는 추정치다.

| 쿼리 | 테이블 | type | key | rows | Extra |
|---|---|---|---|---|---|
| 관심 목록 SELECT(`bookmarks` join `items`, `created_at desc, item_id desc`) | bookmarks | ALL | NULL | 9 | Using filesort |
| | items | eq_ref | PRIMARY | 1 | |
| | 서브쿼리: item_changes (마지막 변경 시각) | ref | idx_item_changes_item_id | 4 | Using where |
| | 서브쿼리: bookmarks (담김 여부) | eq_ref | PRIMARY | 1 | Using index |
| 관심 목록 COUNT | bookmarks | index | PRIMARY | 9 | Using index |
| 피드 목록 SELECT(`item_changes` join `bookmarks` join `items`, `changed_at desc, id desc`) | bookmarks | ALL | NULL | 9 | Using temporary; Using filesort |
| | item_changes | ref | idx_item_changes_item_id | 4 | Using where |
| | items | eq_ref | PRIMARY | 1 | |
| 피드 전체 COUNT | bookmarks | index | PRIMARY | 9 | Using index |
| | item_changes | ref | idx_item_changes_item_id | 4 | Using where |
| 피드 미확인 COUNT(`feed_reads` 서브쿼리 2개) | bookmarks | index | PRIMARY | 9 | Using index |
| | item_changes | ref | idx_item_changes_item_id | 4 | Using where |
| | feed_reads 서브쿼리 | (const) | - | - | no matching row in const table (읽음 행이 없을 때) |

해석: 관심 테이블이 구동 테이블(driving table)이라 `ALL`이지만 행이 관심 건수(9)뿐이고, 물건·이력 쪽은 모두 인덱스로 찾는다. 물건 수에 비례해 커지는 곳이 없다. 피드 목록의 임시 테이블과 filesort는 정렬 키(`changed_at`)가 이력 테이블의 인덱스 순서와 다른 조인 결과를 정렬하기 때문이다. 관심·이력이 수만 건으로 늘면 다시 재야 하고, 지금 규모에서는 개선하지 않는다. 관심 9건, 이력 약 36건 규모의 계획이라 큰 규모를 보장하지 않는다.

### 15.3 쓰기 API 응답 시간

시드 809건, 맥 한 대, 로컬 Docker MySQL 8.4 + `bootRun`(local,seed)에서 쓰기 요청을 직렬로 보냈다. 요청마다 워밍업 5회를 버리고 30회를 `curl -w '%{time_total}'`로 쟀다. **부하 테스트가 아니다.** 단일 요청을 순서대로 보낸 값이며 동시성은 반영하지 않는다. 측정으로 생긴 행은 모두 지웠다(15.5).

| 요청 | p50 | p95 | max |
|---|---|---|---|
| 분석 저장 `POST /api/analyses` | 10.9 | 14.3 | 15.5 |
| 회차 시작 + 종료(`POST` 후 `PATCH`, 두 요청 합) | 23.8 | 31.6 | 38.9 |
| 관심 등록 `POST /api/bookmarks` | 9.6 | 14.9 | 15.4 |
| 피드 읽음 `POST /api/feed/read` | 6.1 | 9.4 | 13.8 |

단위는 밀리초다. p95는 30개 중 29번째 값이다. 회차 행은 두 요청의 합이라 다른 행보다 약 2배다.

### 15.4 분석 워커 무수정 연결(7.3)

`scripts/dev/verify-analyzer-on-spring.sh`를 개발 환경에서 1회 실행했다. 시드 MySQL + Spring(`local,seed`) + 분석 워커(`AUCTIONBOSS_API_BASE=http://localhost:8080`, 가짜 CLI `scripts/dev/fake-claude`, `ANTHROPIC_API_KEY` 비움).

- 분석 12 → 15건(신규 2, 재분석 1, 모델 `fake-claude`). `analyzer` 회차 success, `detail`은 `{"newCount":2,"reanalysisCount":1,"succeeded":3,"failed":0}`. `GET /api/items/{id}`의 최신 분석이 새 행이었다. 약 3초.
- `git diff --stat adda943 -- workers/` 0줄. 분석 워커 코드 변경 없음.
- Claude 호출 0건(가짜 CLI). compose·K8s 분석 워커의 기본 주소는 Next 그대로다(운영 경로 유지).

### 15.5 테스트 수와 개발 DB 상태

| 구분 | 1단계 끝 | 2단계 끝 | 비고 |
|---|---|---|---|
| TypeScript(`npm test`) | 885 | 923 | 61개 파일 |
| 백엔드(`./gradlew clean check`) | 216 | 332 | 31개 클래스, 실패·건너뜀 0 |

(885 → 904는 2단계 변경, 904 → 923(+19)은 2단계 구현 뒤 들어간 returnTo 오픈 리다이렉트 수정(826f033)의 테스트다. 13.1의 791은 1단계 종료 시점이고, 1-B(14절)를 거쳐 2단계 시작 때 885였다.) 줄어든 테스트는 없다.

측정 뒤 개발 DB는 측정 전과 같다(`analyses` 15, `worker_runs` 8, `bookmarks` 0, `feed_reads` 0, 두 테이블 행 덤프가 바이트 단위로 같음). 7.3 실행의 가짜 분석 3건과 회차 1건은 시드 재적재 전까지 남아 있다.

### 15.6 남은 공백

1. 분석 워커 연결 검증은 수동 스크립트다. CI가 실행하지 않는다. 주소와 계약이 바뀌면 사람이 다시 돌려야 한다.
2. 1단계 읽기 골든 생성기는 운영 DB에 의존해서 다시 만들면 값이 흔들린다. 2단계 시나리오 생성기는 시드 기반이라 결정적이다(생성을 두 번 돌려 바이트가 같음).
3. 쓰기 API가 인증 없이 열려 있다. Spring 포트는 compose에서 루프백에만 열리며, 인증은 7단계다.
4. 운영은 여전히 Next + SQLite다. MySQL에는 시드만 있다. 운영 전환은 5단계에서 데이터 이전과 함께 한다.

## 16. 3단계: 화면 데이터 포트와 spring 모드 (switch-web-to-data-port, 2026-10-09)

이 절은 3단계(화면의 데이터 접근을 데이터 포트 한 곳으로 모으고, 같은 화면이 SQLite와 Spring 양쪽에서 나오는 것을 증명하는 작업)가 끝난 시점의 실측값과 남은 공백을 적는다. 수치는 이 절을 쓰는 날 직접 다시 센 값이다. 운영 기본값은 그대로 `sqlite`이고, 운영 화면 전환은 5단계다.

### 16.1 화면별 Spring 요청 수

`AUCTIONBOSS_DATA_SOURCE=spring`일 때 화면 하나를 그리며 Spring(테스트에서는 Next 핸들러 대역 `fetch`)으로 보낸 HTTP 요청 수다. 데이터 행이 4건일 때와 30건일 때를 모두 쟀고, 같아야 통과한다(물건·회차마다 요청을 보내는 N+1이 생기면 30건 쪽이 늘어 실패한다). 요청은 화면 안에서 병렬로 보낸다(상세는 물건 1회 뒤 병렬).

| 화면 | 상한(design D7) | 4건 | 30건 |
|---|---|---|---|
| `/` | 6 | 6 | 6 |
| `/items/{id}` (사진 상태 `collected`) | 5 | 5 | 5 |
| `/bookmarks` | 2 | 2 | 2 |
| `/feed` | 2 | 2 | 2 |
| `/status` | 11 | 11 | 11 |
| 관심 토글·읽음 처리·사진 파일 | 1 | 1 | - |

측정값이 모두 상한과 같다. 상한은 느슨한 여유가 아니라 지금 필요한 요청 수 그대로다. 줄일 여지는 있다(피드는 `GET /api/feed` 응답에 미확인 개수가 이미 있어 1회로 줄일 수 있다). 포트 메서드를 화면에 맞추지 않는다는 원칙을 지켜 늘리지 않았다. 설계상 상세 화면은 사진 상태가 `collected`가 아니면 사진 목록 요청이 빠진다(이번에 따로 재지 않았다). 변이 확인: 관심 목록 화면이 물건마다 `getItemById`를 부르게 바꾸면 테스트가 실패한다.

### 16.2 새 읽기 API 5개의 SQL 문 수와 EXPLAIN

`QueryCountTest`가 요청당 SQL 문 수를 고정한다(행 수를 바꿔도 같다).

| API | SQL 문 수 | 내용 |
|---|---|---|
| `GET /api/items/filter-options` | 4 | 용도, 시도, 시군구, 법원 `DISTINCT` |
| `GET /api/items/{id}/analyses` | 3 | 물건 존재, 목록(`limit`), 건수 |
| `GET /api/items/{id}/photos` | 2 | 물건 존재, 목록 |
| `GET /api/worker-runs/status` | 3 | 마지막 회차, 마지막 성공, 마지막 완료(성공·실패·차단) |
| `GET /api/collector-state/rotation` | 1 | 키 하나 |

`EXPLAIN`은 임시 `mysql:8.4` 컨테이너(기존 개발 DB 볼륨과 별개)에 Spring을 `local,seed`로 띄워 시드(물건 809건, 분석 12건, 회차 7건)를 넣고 실행했다. 사진은 시드에 없어 임시 DB에 3건을 넣었다. `rows`는 추정치다. 측정 뒤 컨테이너를 지웠다.

| 쿼리 | type | key | rows | Extra |
|---|---|---|---|---|
| 용도 선택지(`DISTINCT usage_type`) | range | idx_items_usage_type | 5 | Using index for group-by |
| 시도·시군구 선택지(`DISTINCT … COLLATE utf8mb4_0900_bin ORDER BY`) | ALL | NULL | 810 | Using where; Using temporary; Using filesort |
| 법원 선택지 | index | uq_items_court_case_item | 810 | Using index; Using temporary; Using filesort |
| 물건 존재(`id`) | const | PRIMARY | 1 | Using index |
| 분석 목록(`item_id`, `analyzed_at desc, id desc`, limit 11) | ref | idx_analyses_item_id | 2 | Using filesort |
| 분석 건수 | ref | idx_analyses_item_id | 2 | Using index |
| 사진 목록(`item_id`, `seq`) | ref | uq_item_photos_item_seq | 3 | - |
| 워커 마지막 회차 3종 | ref | idx_worker_runs_worker_started_at | 3 | Using filesort(성공·완료 조회는 Using where 추가) |
| 로테이션(`key`) | const | PRIMARY | 1 | - |

해석: 물건 하나를 기준으로 하는 쿼리(분석·사진·존재)와 워커 상태는 모두 인덱스를 탄다. 분석 목록과 워커 상태에 `filesort`가 남는 것은 정렬에 `id`를 더한 동률 해소 때문이고, 대상 행이 물건당 분석 수·워커당 회차 수뿐이라 지금(분석 12건, 회차 7건)은 무시할 수준이다. 비용이 큰 것은 시도·시군구·법원 선택지다. 시도·시군구는 전체 스캔, 법원은 전체 인덱스 스캔에 임시 테이블과 filesort가 붙는다. `COLLATE utf8mb4_0900_bin`(SQLite의 바이트 비교와 같은 구분을 하려는 선택, 16.3)이 컬럼 기본 정렬 규칙과 달라 인덱스 순서를 못 쓰는 것으로 보이지만, 규칙을 빼고 비교해 확인하지는 않았다. 809건에서는 문제가 없고, 물건이 수십만 건이 되면 다시 재야 한다(선택지 전용 테이블이나 캐시가 후보). 지금 개선하지 않았다.

### 16.3 계약 시나리오

시나리오 골든은 7개 115단계에서 10개 171단계로 늘었다. 새 것은 `screen-reads`(21단계), `worker-status`(24단계), `port-requests`(11단계)이고, 기존 7개는 재생성 결과가 바이트 단위로 같다. 1단계 읽기 골든 90개도 계속 일치한다. 3장에서 시나리오 2개를 더해 160단계였고, 5장에서 `port-requests`를 더해 171단계가 됐다.

- 불일치 1건: 원인은 Spring이 아니라 테스트 하네스의 사진 id 카운터 미초기화였다. 이식 실수로 생긴 불일치는 0건이다.
- 골든 형식에 단계별 `advanceMs`(그 단계부터 서버 시각을 뒤로 밀기)와 `config`의 `intervalMs`·`staleAfterIntervals` 덮어쓰기를 더했다. 워커 상태 판정은 지금 시각에 따라 달라서, Spring은 주입된 `Clock`(테스트에서 `MutableClock`), 생성기는 고정 시계를 쓴다.
- 선택지 정렬 규칙: SQLite `DISTINCT … ORDER BY`는 바이트 비교다. MySQL 기본 `utf8mb4_0900_ai_ci`는 `A법원`과 `a법원`을 합치고, `utf8mb4_bin`은 뒤쪽 공백만 다른 `A법원 `를 합친다. 그래서 `COLLATE utf8mb4_0900_bin`을 쓰고, `A법원`/`a법원`/`A법원 `/빈 문자열 사례를 Next 저장소 테스트와 Spring 통합 테스트에 같이 둔다. 변이 확인: `utf8mb4_bin`으로 바꾸면 뒤쪽 공백 사례가, 기본 규칙으로 두면 대소문자 사례가 실패한다.

### 16.4 포트 계약과 두 원천 동등성

세 단계로 증명한다. (1) Spring ≡ Next 핸들러: 16.3의 시나리오 골든(Java, 매 CI). (2) Spring 구현체 ≡ SQLite 구현체: 시드를 적재한 임시 SQLite에서 SQLite 구현체와, Next 핸들러를 대역 `fetch`로 쓴 Spring 구현체를 같은 사례로 불러 `toStrictEqual`로 비교하는 포트 계약 테스트 49개(`port-contract.test.ts`; 목록 조건 15종 이상, 상세, 분석 이력, 변경 이력, 사진, 워커 상태·집계·회차, 로테이션, 쓰기 후 읽기). (3) 화면 렌더 테스트 5개 파일을 `describe.each(["sqlite", "spring"])`로 두 원천에서 돌린다(기대값은 하나).

두 증명 사이의 빈틈은 골든 포함 검사가 막는다. 대역 `fetch`가 받은 요청을 `(메서드, 경로 틀, 쿼리 키 집합)`으로 기록하고, 모두 커밋된 골든에 있어야 통과한다. 미확인 개수 요청에 새 쿼리 키를 붙이면 이 검사가 실패한다(변이 확인). 목록 화면은 워커 전용 조건(`needsAnalysis` 등)을 포트로 넘기지 않는다. 1~2장의 회귀 검증이 찾은 문제(주소에 그 필드가 있으면 500)를 링크 생성 전에 제거해 고쳤고, 테스트가 이를 고정한다. 실패 처리도 테스트로 고정했다: Spring이 500, 형식이 다른 본문, 연결 실패를 돌려주면 페이지가 던지고(부분 렌더 없음), 없는 물건은 `notFound()`다. `spring` 모드가 SQLite를 열지 않는 것은 `getDb`가 던지는 상태로 Spring 구현체 테스트를 돌려 확인한다.

### 16.5 개발 환경 spring 모드 비교 (8장)

`scripts/dev/compare-screens.sh` 1회 실행(종료 코드 0). 임시 `mysql:8.4` 컨테이너(포트 3399)에 Spring jar(`local,seed`)를 붙여 시드를 넣고, 같은 시드 SQL을 `seed-to-sqlite`로 임시 SQLite에 넣었다. `next start`를 둘 띄웠다. sqlite 인스턴스(3100)와 spring 인스턴스(3101)이고, spring 쪽은 `AUCTIONBOSS_DB`를 존재하지 않는 디렉터리로 뒀다. 기존 개발 DB 볼륨은 건드리지 않았다.

- 비교 35건(쓰기 전 15, 읽음 처리 전 2, 쓰기 후 18): HTML 차이 0건. 폼 5회(관심 등록 3, 해제 1, 읽음 처리 1)의 응답 코드는 두 인스턴스 모두 303이다. 실행 뒤에도 `AUCTIONBOSS_DB` 경로가 계속 없었다(spring 인스턴스가 SQLite를 열지 않음). 코드 결함은 찾지 못해 고친 것이 없다.
- Spring을 멈춘 뒤 spring 인스턴스의 `/`, `/items/1`, `/bookmarks`, `/feed`, `/status`는 모두 HTTP 500이고, 임시 SQLite에 809건이 있는데도 시드 물건의 사건번호가 응답에 0회 나왔다. 다른 원천으로 대신 동작하지 않는다.

응답 시간(ms, 같은 머신 루프백, 워밍업 1회 제외 10회, 중앙값/최댓값. **부하 테스트가 아니다**):

| 화면 | sqlite | spring |
|---|---|---|
| `/` 기본 | 11/12 | 23/26 |
| `/` 정렬+2페이지 | 11/13 | 22/25 |
| `/` 용도·유찰 필터 | 11/12 | 22/29 |
| `/` 시도·법원·정렬 | 11/13 | 23/33 |
| `/` 분석 있음 | 8/9 | 18/21 |
| `/` 결과 없음 | 7/8 | 17/20 |
| `/` 잘못된 값 | 10/11 | 23/50 |
| `/items/1` 분석 있음 | 6/8 | 20/24 |
| `/items/3` 분석 없음·사진 대기 | 5/5 | 19/20 |
| `/items/2` 사진 조회 불가 | 5/6 | 19/20 |
| `/items/999999` 404 | 3/4 | 11/50 |
| `/items/abc` | 4/5 | 4/4 |
| `/bookmarks` | 4/4 | 11/18 |
| `/feed` | 4/4 | 12/15 |
| `/status` | 5/6 | 17/19 |

spring 모드는 sqlite 모드의 약 2~4배(중앙값 +7~14ms, 두 모드가 같은 `/items/abc` 제외)다. HTTP 요청이 6~11개 늘고 JSON 직렬화가 더해진 값이다. 루프백이라 네트워크 지연은 반영되지 않는다. 느리면 그때 손본다(캐시는 이 단계의 범위가 아니다).

**정규화에 대해.** 비교 스크립트는 HTML을 그대로 비교하지 않고 세 가지만 정규화한다. (N1) 빌드 ID 경로. (N2) `self.__next_f.push` 스트리밍 조각은 이어 붙여 해석한 뒤 조각 번호·참조 번호(`4:`, `$L10`)를 지우고 줄을 정렬한다. (N3) Suspense 번호. 정규화 없이는 35건 중 33건이 달랐다(실측). 보이는 DOM은 같고 RSC flight 데이터의 조각 나누기·번호만 달랐는데, sqlite 모드는 데이터가 동기로 와서 한 덩어리로, spring 모드는 비동기라 여러 조각으로 스트리밍되기 때문이다. 값(문자열·속성·숫자)은 그대로 비교하고 DOM은 한 글자도 바꾸지 않는다. `scripts/dev/__tests__/normalize-html.test.ts`가 값·DOM 차이는 잡고 조각 나누기만 무시함을 확인한다. 시각 의존 문구(경과 시간·D-day·담은 시각)는 정규화하지 않았다. 같은 URL을 두 인스턴스에 연달아 보내 차이를 수 ms로 줄였고, 이번 실행에서 차이는 0건이었다. 정규화 규칙이 동작 차이를 가릴 수 있다는 것이 이 방식의 한계다.

### 16.6 lint 경계

`eslint.config.mjs`의 `no-restricted-imports`가 `better-sqlite3`, `@/lib/db`, `@/lib/db/*`, `@/lib/storage/*`와 같은 상대 경로 가져오기를 막는다. 대상은 `src/app/**`(페이지·컴포넌트·`_lib`)와 `src/lib/data-port/spring/**`이고, 화면용 라우트 3개(`bookmarks/toggle`, `feed/mark-read`, `photos`)는 `src/app/api/**` 안에 있지만 다시 포함한다. 제외는 테스트와 나머지 기존 JSON API 라우트뿐이다. 기존 JSON API 라우트는 운영 분석 워커와 수집 경로가 쓰므로 5단계까지 SQLite를 직접 쓰는 것이 맞다. 그래서 ROADMAP의 완료 기준을 "화면 코드가 SQLite를 가져오지 않고, SQLite 접근은 포트의 SQLite 구현체 한 곳(린트로 강제)"으로 고쳤다. 화면이 SQLite를 직접 열지 못하게 하는 것이 목적이다. 라우트 파일 규칙은 파일 경로 목록이라, 새 화면용 라우트를 만들면 목록에 추가해야 한다(자동으로 잡히지 않는다). 운영 원천은 `sqlite`로 유지한다. compose·K8s의 웹 서비스가 `AUCTIONBOSS_DATA_SOURCE=spring`을 설정하지 않음을 `deploy-config.test.ts`가 고정한다.

### 16.7 테스트 수

| 구분 | 2단계 끝(15.5) | 3단계 끝 | 비고 |
|---|---|---|---|
| TypeScript(`npm test`) | 923 | 1212 | 61 → 84개 파일. 화면 렌더 테스트가 두 원천으로 돌아 늘었다 |
| 백엔드(`./gradlew clean check`) | 332 | 370 | 31 → 34개 클래스, 실패·건너뜀 0 |

줄어든 테스트는 없다. 기준값은 3단계 시작 커밋 `faf9897`(2단계 아카이브, 3단계 코드 커밋 `030aaed`의 부모)의 값이고 2단계 끝(15.5)의 값과 같다. tasks.md 1.1이 요구한 시작 기준 메모(커밋·테스트 수)는 tasks.md 하단에 한 번도 적히지 않았다(`6b08841`부터 `969848a`까지 모든 판을 확인). 그래서 `faf9897` 트리를 따로 풀어 `npx vitest run`을 돌려 TS 923개·61개 파일을 다시 확인했고, Java 332개·31개 클래스는 15.5의 값을 그대로 썼다. 게이트 5종(`npx tsc --noEmit`, `npm test`, `npm run build`, `npm run lint`, `cd backend && ./gradlew check`)이 모두 통과한다. `npm run lint`에는 경고 6개(오류 0)가 있다.

### 16.8 남은 공백

1. 실제 Spring을 붙인 화면 비교는 수동 스크립트다. CI가 실행하지 않는다(Docker·JDK·Next 빌드가 필요하다). CI는 대역 `fetch`와 골든 포함 검사로 두 증명을 잇는다.
2. 응답 시간은 루프백, 시드 809건, 단일 요청 기준이다. 동시성과 네트워크 지연은 반영하지 않았다.
3. 선택지 쿼리(시도·시군구·법원)는 물건 전체를 훑는다(16.2). 규모가 커지면 다시 재야 한다.
4. 운영 화면은 여전히 `sqlite`다. `spring` 전환과 기존 JSON API·SQLite 구현체 은퇴는 5단계(데이터 이전)에서 한다. 새 읽기 API 5개의 Next 라우트도 그때 함께 은퇴한다.

## 17. 4단계: 수집·사진 워커 Spring 이식 (port-collector-to-spring, 2026-10-09)

이 절은 4단계(TypeScript 수집 워커·사진 워커·소스 어댑터를 Spring으로 옮기고, 같은 입력에서 같은 요청과 같은 저장 결과가 나오는 것을 증명하는 작업)가 끝난 시점의 실측값과 남은 공백을 적는다. 운영의 수집·사진은 여전히 TS 워커이고, Spring의 수집·사진 스케줄러는 기본 꺼짐이다. 운영 전환은 5단계다. 수치는 tasks.md 하단 메모와 이 절을 쓰는 날 다시 돌린 게이트에서 가져왔다.

### 17.1 동등성 골든과 불일치

TS가 하는 일을 정답으로 뽑아 두고 Java가 같은 입력에서 같은 결과를 내는지 비교한다. 정답 생성기는 기존 코드를 고치지 않는다(`git diff --stat 9f01ce5 -- workers/ src/lib/sources/` 출력 없음, 9.1에서 다시 확인).

| 골든 | 규모 | 입력 | 비교 대상 | 불일치 |
|---|---|---|---|---|
| 어댑터(`contracts/source/`) | 34사례 | 실제 응답 샘플과 합성 경계 사례를 Node 루프백 서버로 재생 | 정규화 물건, 오류 종류, 실제 전송 요청(메서드·경로·헤더·본문), 요청 뒤 대기, 서버가 본 동시 요청 수 | 0 |
| 저장(`contracts/collector/`) | 10시나리오·44단계 | 같은 소스 응답 시퀀스를 TS 워커(임시 SQLite)에 넣어 단계마다 스냅숏 | `items`(id 포함)·`item_changes`·`worker_runs`·`collector_state`·`item_photos`, 사진 파일(경로·크기·SHA-256), 가짜 소스가 받은 호출, 물건 사이 대기, 틱 결과 | 0 |

어댑터 34사례는 검색(정상·3페이지·빈 페이지 조기 종료·페이지 상한·일괄매각·확장 필드 없음 등), 차단(WAF, `ipcheck`, 2페이지·두 번째 법원), 형식 오류 4종, HTTP 500·연결 끊김, 사진 조회 8종이다. 저장 10시나리오는 `collect-insert-baseline`(1단계), `collect-update-change`(2), `collect-duplicate-in-batch`(3), `collect-rotation-budget`(6), `collect-court-removed`(3), `collect-blocked`(4), `collect-failed`(4), `photos-outcomes`(7), `photos-blocked-and-retry`(7), `shared-backoff`(7)다. 두 골든 모두 두 번 생성해 바이트가 같고, 어댑터 골든은 서버 시간대를 UTC·Seoul·Los_Angeles로 바꿔도 같다(`TZ=... npx vitest run scripts/collector-golden`으로 수동 확인, 자동 테스트는 아니다).

**최종 불일치 0건이지만 중간에 실패가 있었다.** 원인은 모두 구현·골든이 아니라 테스트 쪽이었다.

- 어댑터 첫 실행에서 6건 실패. 대기 시간을 `equals`로 비교하는데 JSON의 정수 노드가 `IntNode`와 `LongNode`로 갈려 값이 같아도 다르다고 나왔다. 비교기를 `ContractTest.diff`로 바꿔 해결했다(어댑터 수정 없음).
- 저장 첫 실행에서 시나리오 7개 실패. 동적 테스트는 `@BeforeEach`가 한 번만 돌아 시나리오 사이에 DB가 안 비워졌다. 시나리오마다 직접 비우게 고쳤다.
- 저장 골든 생성기의 첫 시도는 전 시나리오에 사진 준비 작업을 넣었다가 물건을 못 찾아 생성 자체가 실패했다.

골든이 틀렸다고 볼 근거는 한 번도 없어 골든·생성기는 이식 중에 고치지 않았다. 대신 시작 전에 TS 동작을 실측해 설계의 전제를 확인했고, 어긋난 것은 구현 전에 설계를 고쳤다(1.2).

- 숫자 필드: 설계는 면적·최저가율을 `BigDecimal`/`Double`로 가정했으나, TS 변환이 전부 `Math.trunc`라 정수뿐이다. 운영 원본과 같은 범위의 시드 809건에서 감정가·최저가는 767,000~51,005,255,120(32비트 초과), 소수·음수 저장 0건이었다. 그래서 숫자는 전부 `Long`, 좌표와 코드는 `String`으로 고쳤다.
- 자동증가 id: SQLite `ON CONFLICT` 갱신도 id를 한 칸 쓴다. MySQL 8.4 `ON DUPLICATE KEY UPDATE`도 같다(둘 다 X=1, Y=4, Z=6). 골든이 `id`를 비교하므로 Java도 기존 행에 INSERT를 시도한다.
- 저장 실패 회차의 로테이션 위치, 같은 배치 중복 키의 이력과 `changed` 수는 설계와 실측이 일치했다. 법원 콜레이션 충돌은 시드 809건에서 0건이었다.

### 17.2 의도된 차이

같은 결과를 내지만 같을 수 없는 지점은 따로 적고, 비교에서 무엇을 어떻게 다루는지 정했다.

| 차이 | 내용 | 비교·방어 |
|---|---|---|
| 헤더 순서 | Node는 코드가 정한 헤더가 앞, 런타임 헤더가 뒤다. JDK `HttpClient`는 해시 순서로 쓴다(예: `Cookie`가 맨 끝). 순서는 JDK에서 통제할 수 없다 | 비교는 이름 소문자화 후 값만 본다. WAF가 순서를 본다는 증거는 없다. 8.4 실제 사이트 확인에서 차단되지 않았다 |
| `connection` 헤더 | TS 골든에는 `connection: keep-alive`가 있고 JDK는 HTTP/1.1 기본값이라 헤더로 쓰지 않는다. JDK 실제 전송과 TS 골든의 헤더 이름 차이는 이 하나뿐이고 나머지 값은 모두 같다 | 비교에서 제외 |
| 타임아웃·본문 마감 | 연결 10초, 응답 60초, 리다이렉트 안 따라감은 TS와 같다. 다만 JDK의 `HttpRequest.timeout`은 응답 헤더 수신까지라 본문이 늘어지면 안 끊겼다 | 요청 전체에 응답 타임아웃 마감을 걸었다. 초당 10바이트로 늘어지는 본문 테스트가 있고, 마감을 1시간으로 바꾸면 실패한다 |
| 오류 메시지 | 형식 위반 이슈 문구를 zod와 같은 문장으로 만들 수 없다 | 첫 줄만 비교한다 |
| `Long` 범위 | `"1e30"`처럼 `Long` 밖의 값을 TS는 그대로 통과시킨다. Java는 변환 불가(없음)로 다룬다. 사진 순번이 비정수면 Java는 `Long`으로 버린다 | 골든 사례 밖이다. 운영 데이터 범위(최대 약 5.1e10)에서는 실현되지 않는다 |
| 설정 검증 범위 | TS는 설정 파일 전체를 한 번에 검증하고, Java는 읽는 섹션만 검증한다 | 다른 섹션이 깨져도 수집 설정 읽기는 동작 |
| 백오프 저장값 파싱 | 설계는 `STR_TO_DATE`였으나 MySQL strict 모드에서 맞지 않는 문자열이 NULL이 아니라 오류가 된다(테스트 2건 실패로 확인) | 정규식 + 문자열 비교. `toISOString()` 형식에서는 시각 순서와 같다. 달력상 불가능한 날(2월 30일)은 정규식을 통과하는 한계가 있다 |

숫자 변환 경계는 JS의 `Number()` 의미를 그대로 재현한다(`"0x10"`→16, `"1e3"`→1000, `"1,234"`→1234, 전각 숫자·`"1_000"`→없음, `-0.5`→0, JS `trim` 공백 집합). `RowFolderTest` 55개가 담는다.

### 17.3 회차 저장 시간

`ItemUpsertTimingTest`, Docker MySQL 8.4, 이 개발 맥, 법원 1곳 규모 500건이다. 이력을 건별로 넣던 처음 구현은 신규 500건 1721ms, 시드 위 갱신(절반 변경) 1049, 712, 661, 610, 626ms였다. 1초를 넘는 값이 있어 이력 INSERT를 모아 같은 트랜잭션 끝에서 `batchUpdate`로 넣게 바꿨다.

| 구분 | 신규 500건 | 갱신(연속 5회) |
|---|---|---|
| 처음(이력 건별 INSERT) | 1721ms | 1049, 712, 661, 610, 626ms |
| 이력 배치 INSERT | 1334ms | 894, 633, 636, 639, 613ms |

예열 뒤 갱신은 약 0.6초로 1초 안이다. 물건당 사전 SELECT와 UPSERT 두 번의 왕복이 대부분이라 더 줄이지 않았다. 첫 배치가 1초 안팎인 것은 빈 DB의 첫 회차 정도에만 해당하고 주기가 수십 분이다. 테스트의 상한은 3초(느슨한 값)다. 처음에 두었던 "콜드 첫 배치 단언"은 JVM 예열 편차로 흔들려 빼고 예열 뒤 중앙값으로 판정한다. `rewriteBatchedStatements`는 전역 설정을 바꾸게 되어 켜지 않았다. 저장 원자성은 같은 배치의 세 번째 물건에서 이력 INSERT를 실패시켜, 앞선 갱신·신규와 이력이 하나도 남지 않음을 확인한다(`@Transactional`을 지우면 이 테스트가 실패).

### 17.4 두 인스턴스 잠금

서버 인스턴스가 둘이어도 같은 워커의 회차가 겹치지 않아야 한다. 잠금은 MySQL `GET_LOCK(name, 0)`이고 못 얻으면 실행하지 않고 `skipped(overlap)`를 기록한다. 두 번 확인했다.

| 확인 | 조건 | 결과 |
|---|---|---|
| 5.3 `TwoInstanceTickTest`(Testcontainers, CI) | 연결 풀 2개씩 둘, 같은 시각 틱 20회 | 시작된 회차 정확히 1, 나머지는 overlap, 최대 동시 실행 1 |
| 8.1 `verify-collector-on-spring.sh` 단계 2(개발 환경, 수동) | Spring 둘이 같은 MySQL, 가짜 서버가 검색을 5초 늦춰 회차(약 5초)가 주기(2초)보다 길게 | 새 성공 회차 6, overlap 건너뜀 27, 그 밖의 건너뜀 0, 실행 구간이 겹친 회차 쌍 0, 가짜 서버가 본 동시 요청 최대 1 |

8.1에서 인스턴스별 회차 수는 실행마다 달랐다(a 2·b 4, a 6·b 0 등). 한쪽이 잠금을 계속 잡는 것도 정상이다. 변이 확인: 잠금 이름을 인스턴스마다 다르게(인스턴스 범위 잠금, 메모리 플래그와 같은 효과) 하면 `TwoInstanceTickTest`가 실패한다.

### 17.5 개발 환경 전체 경로(8.1)와 실제 사이트 확인(8.4)

**8.1 가짜 소스 전체 경로.** 임시 mysql:8.4(볼륨 없음)와 루프백 가짜 소스 서버(어댑터 골든 픽스처를 계속 재생)에 Spring 실제 jar를 붙였다. 3회 연속 실행했고 마지막 값은 다음과 같다. 단계 1(Spring 하나, 스케줄러 켬)에서 수집 success 5·사진 success 1·실패/차단 0, `GET /api/items` 3건이 DB 3건과 같고, 사진 파일 API 6건의 SHA-256이 가짜 서버가 보낸 바이트와 같았다. 가짜 서버가 받은 검색 요청 수는 수집 회차 수와 같다(회차당 세션 1·검색 1). 사진 회차 요청은 4(세션 1 + 상세 3)다.

외부 요청이 없었다는 것은 어댑터가 요청 호스트를 로그로 남기지 않아 네 가지로 판정했다. (1) Spring 로그에 "외부 요청이 허용되지 않았습니다" 0건, (2) 로그의 URL 호스트가 루프백뿐, (3) 실행 중 Spring 프로세스의 TCP 연결 상대 표본 약 700개가 전부 루프백(MySQL과 가짜 서버), (4) 가짜 서버가 본 요청 26건의 Host·접속 주소가 전부 루프백. 단계 1에서 동시 요청 최대가 2였다(수집과 사진은 별개 워커라 한 인스턴스 안에서도 겹칠 수 있고 TS도 같은 구조). 처음에 "최대 1"로 단언했다가 이 실행에서 깨져 단계 1은 2 이하로, 같은 워커끼리의 동시 없음은 수집만 도는 단계 2에서 1로 판정하도록 고쳤다.

**8.4 실제 사이트 최소 확인(1회, 사람이 승인).** 사전 확인은 TS collector·photos 컨테이너와 워커 프로세스가 없고, 백오프 기록이 없고, 직전 TS 회차 이후 957분이 지났음을 본다. 하나라도 실패하면 컨테이너도 만들지 않고 종료하는 스크립트(`live-check-collector.sh`)로 실행했다.

| 항목 | 결과 |
|---|---|
| 요청 합계 | 4(수집: 세션 1 + 검색 1, 사진: 세션 1 + 상세 1), 대기 60초 포함 83초 |
| 회차 | 수집·사진 성공, 실패·차단 0 |
| 확인용 DB(빈 임시 MySQL) | 물건 39건(법원 1곳·1페이지), 사진 행 41, 파일 41 |
| TS SQLite와 비교(정규화 컬럼 41개) | 같은 물건 37건, TS에 없는 물건 2건(새로 올라온 물건), 불일치 0건 |

헤더 순서·`connection` 차이(17.2)로 차단되지 않았다. 확인용 DB와 사진 디렉터리는 스크립트가 삭제했고, TS 워커는 원래 정지 상태라 재개하지 않았다. 비교 대상 TS SQLite는 읽기 전용으로만 열었고 건수·컬럼 이름만 출력했다. 이 확인은 요청 4개짜리 표본이라 장기간 차단률은 알 수 없다(17.9).

### 17.6 아키텍처 규칙

ArchUnit 규칙 5개(`CollectArchitectureTest`, 메인 클래스만)와 소스 필드명 누출 검사 3개(`SourceFieldLeakTest`)가 어댑터 격리를 코드로 강제한다.

1. `..collect.source.courtauction..` 밖은 그 패키지에 의존하지 않는다.
2. `..collect.source..`는 JPA·`org.springframework.jdbc`·`org.springframework.data`·`item`·`worker`·`photo` 패키지에 의존하지 않는다(어댑터는 DB에 닿지 않는다).
3. `java.net.http`는 어댑터 패키지 밖에서 쓰지 않는다(HTTP 클라이언트는 어댑터 안에만).
4. `org.springframework.scheduling..`은 `..collect.run..` 밖에서 쓰지 않는다.
5. `collect` 아래 슬라이스(`source`·`collector`·`photos`·`run`·`runonce`)의 순환 금지.

누출 검사는 어댑터 응답 record의 컴포넌트 이름과 record가 아닌 키 9개(`dlt_srchResult`, `dma_pageInfo`, `ipcheck`, `csPicLst`, `cortOfcCd` 등)가 `backend/src/main/java`의 어댑터 밖 파일에 단어 단위로 나타나는지 본다(주석 포함). 목록이 어댑터 소스에 실제로 있는지도 확인해 낡음을 막는다. 변이 확인은 규칙마다 했고 각 변이는 해당 규칙 하나만 실패했다: (a) `CollectorRun`이 어댑터 클래스 참조 -> 규칙 1, (b) 어댑터가 `ItemRepository` 참조 -> 규칙 2, (c) `CollectorRun`이 `HttpClient` 참조 -> 규칙 3, (d) `BackoffStore`에 `"ipcheck"` 문자열 -> 누출 검사, (e) `WorkerTicker`가 `CollectorRun` 참조 -> 규칙 5, (f) `CollectorRun`이 `TaskScheduler` 참조 -> 규칙 4.

### 17.7 안전장치 두 겹

운영에서 두 수집기가 동시에 도는 것이 가장 큰 위험이다. 두 수집기는 서로 다른 DB(SQLite와 MySQL)의 백오프와 로테이션 위치를 보므로 어떤 잠금으로도 서로를 막을 수 없다. 그래서 켜지 않는 쪽에 장치를 둔다.

- **첫째 겹, 스케줄러 기본 꺼짐.** `auctionboss.collector.enabled`·`auctionboss.photos.enabled`가 `true`가 아니면 스케줄러 빈조차 만들어지지 않는다(`@EnableScheduling`도 두지 않았다). `SchedulingDefaultOffTest`가 주기를 100ms로 줘도 600ms 뒤 회차가 0건임을 확인한다.
- **둘째 겹, 외부 요청 기본 꺼짐.** `auctionboss.source.external-requests-allowed`가 `false`이면 어댑터는 루프백이 아닌 주소로 소켓을 열기 전에 거절한다(`failed`, `SourceRequestError`, 백오프 행 없음). 호스트를 직접 파싱해 `localhost.evil.com`·`127.0.0.1.evil.com`·`0.0.0.0`·`[::ffff:8.8.8.8]`·`user@host`·TEST-NET 주소를 거절한다. 테스트 프로필의 소스 주소는 `http://127.0.0.1:9`다.
- **배포 파일 테스트.** `deploy-config.test.ts`가 compose·K8s·configmap 어디에도 세 설정을 켜는 문자열이 없고(이름·점·값 표기 변형 포함), 외부 요청 허용 이름과 1회 실행 모드 이름이 아예 없으며, 운영 수집·사진은 기존 TS 서비스가 맡음을 고정한다. 이 파일은 11개에서 17개로 늘었다.
- **켜질 때의 경고.** 스케줄러가 켜지면 "기존(TS) 수집기·사진 워커가 같은 소스에 요청하고 있으면 안 된다"는 경고 로그를 남기고, 기동 로그에 두 워커와 외부 요청 허용 상태를 항상 적는다.

변이 확인: 수집 스케줄러 설정에 `matchIfMissing=true`를 주면 `SchedulingDefaultOffTest`가, 사진도 같다. compose에 `AUCTIONBOSS_COLLECTOR_ENABLED: "true"`를 넣어 보면 `deploy-config.test.ts` 2개가 실패한다(복원 확인). 루프백 검사를 `if (false)`로 바꾸면 소켓 열기 전 거절 테스트가 실패한다. 이 변이는 외부로 실제 연결이 나가지 않게 비네트워크 사례(`ftp://127.0.0.1`)만 남긴 임시 테스트로 돌렸다.

1회 실행 모드(`auctionboss.run-once=collector|photos`)는 스케줄러 없이 틱 하나만 돌리고 종료 코드를 돌려준다(성공 0, 건너뜀·차단·실패·시간 초과 1). 스케줄러를 켜는 설정과 같이 지정하면 기동이 실패하고, 외부 요청 허용 설정은 건드리지 않는다. 배포 구성에 이 이름이 없어야 한다는 것도 위 테스트가 고정한다.

### 17.8 테스트 수

| 구분 | 3단계 끝(16.7) | 4단계 끝 | 비고 |
|---|---|---|---|
| TypeScript(`npm test`) | 1212 | 1262 | 84 → 89개 파일 |
| 백엔드(`./gradlew cleanTest check`) | 370 | 723 | 34 → 65개 클래스, 실패·건너뜀 0 |

TS +50: 픽스처 추출 4, 어댑터 골든 9, 저장 골든 13, 실제 사이트 비교 13(`compare-live.test.ts`), 배포 파일 6, 실제 사이트 확인 스크립트 가드 5(`live-guard.test.ts`, 9.5). Java +353: 2장 어댑터 +155(`SourceContractTest` 34, `RowFolderTest` 55, `CourtAuctionHttpTest` 34 등), 3장 저장 +22, 4장 회차 본체 +68, 5장 스케줄러·잠금 +25, 6장 사진 워커 +43, 7장·8.2 아키텍처·1회 실행 +18, 9.5 환경 변수 바인딩 +22(`EnvironmentVariableBindingTest`: REFERENCE 8절 표의 환경 변수 이름이 실제 속성에 묶이는지). 줄어든 테스트는 없다. 4장에서 `UpsertGoldenTest` 3개를 지웠으나 `StoreContractTest`가 같은 단계를 같은 비교로 포함해 새 테스트로 대체한 것이다(그 장의 증가분에 반영). 게이트 5종이 모두 통과한다. `npm run lint`에는 경고 6개(오류 0)가 있고 3단계와 같다. `git diff --stat 9f01ce5 -- workers/ src/lib/sources/`는 출력이 없다.

테스트 환경 변경 하나: 테스트 컨텍스트가 늘어 전체 실행에서 MySQL `Too many connections`(기본 `max_connections` 151, 풀 10 × 컨텍스트 15개 이상)가 나서 `application-test.yml`에 Hikari 풀 5를 추가했다(테스트 프로필 전용).

### 17.9 변이 확인 요약

골든·테스트가 실제로 깨짐을 잡는지 장마다 일부러 구현을 깨 보고 되돌렸다. 모두 원본과 diff 없음을 확인했다.

| 변이 | 잡은 테스트 |
|---|---|
| 수집 단계에서 `upsert` 건너뛰기(생성기) | 저장 골든 단언 5개 |
| 페이지 수를 `groupTotalCount` 기준으로 | 어댑터 골든 4건 |
| 첫 페이지 `totalYn`을 `N`으로 | 어댑터 골든 24건 |
| User-Agent 한 글자 변경 | 어댑터 골든 34건 전부 |
| 페이지 대기 5초를 4초로 | 어댑터 골든 6건(대기 있는 사례 전부) |
| `data` 검사를 `ipcheck` 뒤로 | 파서 테스트 2건 + 골든 1건 |
| 요청 상한 비교 `>=`를 `>`로 | `collect-rotation-budget` + 회차 테스트 2건 |
| 실패·차단 시 위치를 다음 법원으로 | `collect-blocked` + 회차 테스트 2건 |
| 백오프 비교 방향 뒤집기 | `BackoffStoreTest` 5, `CollectorRunTest` 1, `StoreContractTest` 2 |
| 차단된 사진 물건도 `failed`로 기록 | `photos-blocked-and-retry`·`shared-backoff` + 사진 회차 1건 |
| PNG를 `.jpg`로 저장 | `photos-outcomes`·`photos-blocked-and-retry` + 파일 쓰기 1건 |
| 사진 대기 쿼리 `<=`를 `<`로 | `PendingPhotoQueryTest` 1건(골든은 정확히 24시간 경계를 담지 않아 단위 테스트가 잡는다) |
| 회차를 틱 스레드에서 직접 실행 | `WorkerTickerTest` 5 + `WorkerSchedulerTest` 4 |
| 단일 실행 잠금 이름을 인스턴스마다 다르게 | `TwoInstanceTickTest` |
| 가림 단계 제거(픽스처 추출) | 가림 검사 |

골든이 못 잡는 것도 확인했다. `collect-failed`는 법원 1곳이라 위치가 같아 위치 변이를 못 잡고(`collect-blocked`가 잡는다), 저장 값 `Long` 비교 변이는 DB 입력이 모두 `Long`이라 서비스·골든이 아니라 비교 함수 단위 테스트에서만 잡힌다.

### 17.10 남은 공백

1. **전환은 하지 않았다.** 운영 수집·사진은 TS 워커다. 두 수집기가 동시에 돌면 요청 예산이 두 배가 되고 서로의 백오프를 못 본다. 장치는 두 겹 기본 꺼짐·배포 파일 테스트·경고 로그·런북(REFERENCE 8절 D14 요약)이고, 전환은 5단계다.
2. **실제 사이트 확인은 요청 4개짜리 1회다.** 차단이 없었다는 것 외에 장기간 차단률·가짜 변경 건수는 모른다(6단계 운영 기록 몫).
3. **어댑터 요청 호스트 로그가 없다.** 외부 요청이 없었다는 것을 네 가지 간접 증거로 판정했다. 요청 로그를 더하는 안은 범위 밖이라 하지 않았다.
4. **한 인스턴스 안의 수집·사진 동시 요청.** 별개 워커라 겹칠 수 있다(최대 2). TS도 같은 구조고, 공유 백오프가 차단 시 둘을 함께 멈춘다.
5. **어댑터의 매각기일 창은 프로세스 로컬 날짜다.** UTC 컨테이너에서는 한국 00~09시에 하루 전 날짜가 나간다. TS 동작 그대로이며 안전 결함은 아니다(골든은 UTC 정오로 시간대 무관하게 고정).
6. **백오프 저장값 파싱 한계.** 달력상 불가능한 날과 소수점 6자리 이상·`+09:00` 표기는 "읽을 수 없는 값"으로 보고 덮어쓴다. TS가 쓰는 형식에서는 어긋나지 않는다.
7. **저장 시간은 개발 맥 1대, 500건 기준이다.** 운영 규모·MySQL 서버 설정에서는 다시 재야 한다.
