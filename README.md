# AuctionBoss

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
    ]
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
| `scope.courts[]` | 서울중앙지방법원 1곳 | 수집 대상 법원 목록. 최소 1곳 필요(빈 배열이면 시작 시 `CollectorConfigError`). 법원을 늘리면 **법원 수만큼 요청이 배로 늘어난다** — 로봇탐지 위험이 그만큼 커진다(§8). |
| `scope.courts[].name` | `"서울중앙지방법원"` | 법원 이름. DB `items.court`에 그대로 저장되는 값이다. |
| `scope.courts[].courtCode` | `"B000210"` | 사이트의 `cortOfcCd`. 빈 문자열이면 어댑터가 `name`으로 `src/lib/sources/courtauction/courts.ts`의 60개 코드표에서 찾는다. 다른 법원 코드는 그 파일 참조. |
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
| `usage` | 문자열, **반복 파라미터** | (없음 = 전체) | 용도(`usageType`) 필터. 하나라도 일치하면 통과(OR), 저장된 값과 **정확히** 일치해야 한다. **`usage=a&usage=b`처럼 이름을 반복해서 보낸다 — 쉼표로 합쳐 보내면 안 된다.** 실제 수집 데이터의 용도 문자열 자체에 쉼표가 들어 있는 경우가 있다(예: 실측값 `"상가,오피스텔,근린시설"` — `src/lib/sources/courtauction/NOTES.md` §8). 쉼표 구분으로 인코딩하면 이 값이 존재하지 않는 용도 3개로 쪼개져 아무것도 매칭되지 않는다. 최대 `MAX_USAGE_TYPES`(50)개, 초과 시 400. |
| `minPrice` | 정수 ≥ 0(원) | (없음) | 최저매각가격(`minBidPrice`) 하한, 포함. 값이 `NULL`인 물건은 제외된다. `maxPrice`보다 크면 둘 다 400. |
| `maxPrice` | 정수 ≥ 0(원) | (없음) | 최저매각가격 상한, 포함. |
| `minFailed` | 정수 ≥ 0 | (없음) | 유찰횟수(`failedBidCount`) 하한, 포함. 값이 `NULL`인 물건은 제외된다. |
| `q` | 문자열(비어 있지 않음) | (없음) | 소재지(`address`) 부분 일치 키워드(`LIKE`, 대소문자·특수문자 이스케이프 처리). |
| `sort` | `auctionDate` \| `minBidPrice` \| `bidRatio` \| `failedBidCount` | `auctionDate`(`DEFAULT_SORT_KEY`) | 정렬 기준. `bidRatio`는 최저매각가격/감정가 비율. |
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

```jsonc
// 200 OK
{ "usageTypes": ["아파트", "오피스텔", "상가,오피스텔,근린시설"] }
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
- 최근 회차 20건 목록(시작 시각, 결과 배지, 소요시간, 상세 — `RECENT_RUNS_LIMIT`).
  전체 이력은 `GET /api/worker-runs`(페이지네이션)로 봐야 한다.

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

### 7.4 ⚠️ 쓰기 API에 인증이 없다

`POST /api/worker-runs`와 `PATCH /api/worker-runs/[id]`(§5)는 인증 없이 누구나 호출할 수
있다. 현 단계가 로컬/개인 전용 실행이라는 전제에서만 허용된 것이며, **이 서버가 외부에
노출되면 누구나 임의의 회차 기록을 주입할 수 있다.** `/status` 화면과
`GET /api/worker-runs/summary` 집계는 전부 이 기록으로 계산되므로, 주입된 "성공" 기록이
실제로는 멈추거나 차단된 워커를 정상으로 둔갑시켜 진짜 장애를 감출 수 있다. 인증을
도입할 때 반드시 포함해야 할 엔드포인트로 지금부터 명시해 둔다(§11 "알려진 한계" 참고).

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
  매각기일 2개월 범위가 444행이므로 한 회차에 **쿠키 1회 + 페이지 12회 = 약 13요청**이 나간다.
  → **10분 주기 상시 운용이 지속 가능한지는 아직 검증되지 않았다.** 실운영 전에 관측이 필요하고,
  차단이 반복되면 1차 대응은 (a) `intervalMs`를 늘리거나 (b) `AUCTIONBOSS_COLLECT_BID_WINDOW_DAYS`를
  줄여 행 수를 낮추는 것이다.
- **브라우저 User-Agent가 필수다.** curl 기본 UA로 보내면 별도 WAF가 JSON 대신 HTML 차단 페이지를
  HTTP 200으로 돌려준다. 어댑터는 고정 UA를 쓰고, 페이지 사이에 기본 5초를 쉬며, 동시 요청을 하지 않는다.
  이 값들을 낮추는 방향으로 조정하지 말 것.
- **법적/약관 상태:** `robots.txt`는 **404**다(명시적 금지 지시자가 없다는 뜻이지, 허용이라는 뜻은 아니다).
  **사이트 이용약관은 아직 검토하지 않았다.** 현 단계는 **개인/내부 열람 용도**를 전제로 하며,
  수집한 데이터를 외부에 재배포·재판매하기 전에 별도의 법적 검토가 반드시 필요하다.

## 9. 개발

```bash
npm test        # vitest run — 400 tests / 21 files
npm run typecheck   # tsc --noEmit
npm run lint        # eslint (설정: eslint.config.mjs, next/core-web-vitals + next/typescript)
```

- 테스트 위치 (`vitest.config.mts`가 `src/**/*.test.ts`, `src/**/__tests__/**/*.test.ts`, `workers/**/*.test.ts`를 수집. 실측: `npx vitest run` 400 tests / 21 files, `npx vitest list --filesOnly` 아래 21개):
  - `src/lib/db/__tests__/client.test.ts`, `repository.test.ts`, `worker-runs.test.ts`
  - `src/lib/domain/__tests__/config.test.ts`, `item-query.test.ts`, `types.test.ts`(`WATCHED_FIELDS`가 4개에서 늘지 않는 것을 고정하는 회귀 테스트 — design.md D2)
  - `src/lib/sources/courtauction/__tests__/adapter.test.ts` (+ `fixtures.ts`)
  - `src/app/_lib/__tests__/change-history.test.ts`, `analysis-history.test.ts`, `item-extensions.test.ts`(확장 필드 표시·포맷 순수 함수), `item-query-url.test.ts`, `status-display.test.ts`
  - `src/app/api/items/__tests__/route.test.ts`, `src/app/api/items/[id]/changes/__tests__/route.test.ts`, `src/app/api/items/usage-types/__tests__/route.test.ts`
  - `src/app/api/worker-runs/__tests__/route.test.ts`, `src/app/api/worker-runs/[id]/__tests__/route.test.ts`, `src/app/api/worker-runs/summary/__tests__/route.test.ts`
  - `workers/__tests__/analyzer.test.ts`, `analyzer.integration.test.ts`(재분석 두 단계 선정을 실제 저장소·API 라우트로 구동하는 회귀 테스트), `collector.test.ts`
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
|   |   +- page.tsx                # 물건 목록 (/)
|   |   +- items/[id]/page.tsx     # 물건 상세 + AI 분석(최신/이전) + 변경 이력 (/items/:id)
|   |   +- status/page.tsx         # 워커 상태 화면 (/status, §7.1)
|   |   +- api/items/route.ts      # GET /api/items (page, pageSize, analyzed, needsAnalysis,
|   |   |                          #   promptVersion, usage, minPrice, maxPrice, minFailed, q, sort, dir)
|   |   +- api/items/[id]/route.ts # GET /api/items/:id
|   |   +- api/items/[id]/changes/route.ts  # GET /api/items/:id/changes
|   |   +- api/items/usage-types/route.ts   # GET /api/items/usage-types
|   |   +- api/analyses/route.ts   # POST /api/analyses
|   |   +- api/worker-runs/route.ts          # GET/POST /api/worker-runs
|   |   +- api/worker-runs/[id]/route.ts     # PATCH /api/worker-runs/:id
|   |   +- api/worker-runs/summary/route.ts  # GET /api/worker-runs/summary
|   |   +- _components/item-filter-form.tsx # 목록 필터·정렬 폼(순수 <form method="get">)
|   |   +- _lib/format.ts          # 금액/날짜 표시 포맷터
|   |   +- _lib/change-history.ts  # 변경 이력 표시 판단(기준점 구별, 가격 변화폭 등)
|   |   +- _lib/analysis-history.ts # 분석 이력 표시 판단(최신/이전 분리)
|   |   +- _lib/item-query-url.ts  # ItemQuery -> 목록 페이지 URL 직렬화
|   |   +- _lib/status-display.ts  # /status 표시 판단(상태->라벨/심각도, 소요시간 포맷 등, §7.1)
|   |   +- _lib/worker-run-query.ts # GET /api/worker-runs(/summary) 쿼리 파라미터 검증
|   +- lib/
|       +- domain/                 # 정규화 도메인 모델 + config 로더
|       |   +- types.ts            # AuctionItem, Analysis, ItemChange, CollectorConfig, WorkerRun ...
|       |   +- config.ts           # config/collector.json 로딩 + zod 검증
|       |   +- item-query.ts       # GET /api/items 쿼리 파라미터 파싱(ItemQuery, strict/lenient)
|       +- db/                     # SQLite 접근 (여기 밖으로 snake_case 컬럼명이 안 나간다)
|       |   +- client.ts           # 연결/WAL/싱글턴, AUCTIONBOSS_DB 해석
|       |   +- schema.ts           # items / analyses / item_changes / worker_runs 테이블 DDL
|       |   +- repository.ts       # upsertItems, listItems, insertAnalysis, listItemChanges ...
|       |   +- worker-runs.ts      # startRun, finishRun, listWorkerRuns, summarizeRuns, getWorkerStatus (§7)
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
2. **10분 주기 상시 운용이 미검증이다.** §8 참고. 다만 §7.3의 `pagesRequested`가 회차마다
   실측값으로 남기 시작했으므로, 이제 로그가 아니라 `GET /api/worker-runs`로 실제 요청 수
   추이를 관측할 수 있다 — 장시간 무인 운용 데이터 자체는 아직 없다.
3. **비공식 엔드포인트라 예고 없이 바뀔 수 있다.** zod 검증으로 즉시 감지·로그하지만, 바뀌면 수집은 멈춘다.
   대안인 **상용 데이터 API 어댑터는 아직 구현되어 있지 않다**(`AuctionSource` 인터페이스만 열려 있는 상태).
4. **프롬프트가 여전히 물건 JSON 한 덩어리만 보고 쓰는 요약이다(v2에서 확장 필드 활용은
   늘었다).** 시세 비교·등기부·권리관계·임차인 정보는 여전히 없다 — **권리관계·임차인·등기
   정보는 애초에 이 소스에 존재하지 않으므로**(§5 "확장 필드" 문단, `NOTES.md` §10.3) 프롬프트를
   더 다듬어도 이 정보는 얻을 수 없다. 실사용 검증(2026-09-08, `AUCTIONBOSS_ANALYZE_MODEL=sonnet`,
   물건 1건 실측)에서 모델이 `minArea`·`minBidPriceRound1`·`minBidPriceRateRound1`이 실제로 값을
   갖고 있는데도 "정보 없음"으로 응답한 사례가 있었다 — 프롬프트가 지시한 계산(면적당 가격, 차수별
   저감 추이)을 모델이 항상 정확히 따른다고 보장할 수 없다는 뜻이다. 분석 본문은 markdown이지만
   화면에서는 렌더링 없이 원문 그대로 표시한다.
5. **워커가 죽으면 수동 재시작이다.** 프로세스 매니저(pm2 등)나 재시작 정책이 없다. 시작/종료 로그로
   감지만 가능하다. 배포 단계에서 도입 예정.
6. **목록 화면 필터에는 UI가 없는 조건도 있다.** 용도·가격대·유찰횟수·소재지 키워드·정렬은
   `ItemFilterForm`(`src/app/_components/item-filter-form.tsx`)으로 붙어 있다. 다만
   `analyzed`(분석 여부)는 URL로는 받아 유지하지만 폼에 입력칸이 없고, `needsAnalysis`는
   analyzer 전용이라 애초에 사람이 쓸 UI가 없다.
7. **인증/권한이 없다.** 서버를 띄우면 접근 가능한 누구나 전체를 볼 수 있다. 로컬/내부망
   전제다. **특히 `POST /api/worker-runs`/`PATCH /api/worker-runs/[id]`(§5, §7.4)는 인증
   없는 쓰기 API라 외부에 노출되면 누구나 임의의 회차 기록을 주입해 `/status` 화면과
   집계를 속일 수 있다** — 인증 도입 시 반드시 포함해야 할 엔드포인트다.
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
