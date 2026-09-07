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
이 change는 완료되어 archive로 이동했다, §8 참고):

- **수집 소스는 어댑터 뒤로 격리한다.** 사이트 고유 필드명(`jiwonNm`, `srnSaNo` 등)은
  `src/lib/sources/courtauction/` 밖으로 나가지 않는다. 소스를 갈아끼워도 나머지 코드는 그대로다.
- **analyzer는 DB를 직접 열지 않는다.** 서버와는 HTTP로만 통신하므로, 분석기를 다른 머신으로
  옮기거나 여러 대로 늘려도 서버 코드는 바뀌지 않는다. 대신 **서버가 떠 있어야만 분석이 돈다.**

analyzer는 한 회차에 서버를 **두 번** 조회한다: 먼저 `GET /api/items?analyzed=false`로 신규
미분석 물건을, 그다음 `GET /api/items?needsAnalysis=true&promptVersion=<현재 버전>`로 재분석
대상을 가져온다(§6 "변경 이력과 재분석" 참고). 신규 조회가 항상 먼저이고 전량 처리되므로,
재분석 대상이 아무리 쌓여도 신규 분석 물건이 뒤로 밀리지 않는다.

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
    "intervalMs": 600000
  }
}
```

| 필드 | 기본값 | 의미와 바꿨을 때의 효과 |
| --- | --- | --- |
| `scope.courts[]` | 서울중앙지방법원 1곳 | 수집 대상 법원 목록. 최소 1곳 필요(빈 배열이면 시작 시 `CollectorConfigError`). 법원을 늘리면 **법원 수만큼 요청이 배로 늘어난다** — 로봇탐지 위험이 그만큼 커진다(§7). |
| `scope.courts[].name` | `"서울중앙지방법원"` | 법원 이름. DB `items.court`에 그대로 저장되는 값이다. |
| `scope.courts[].courtCode` | `"B000210"` | 사이트의 `cortOfcCd`. 빈 문자열이면 어댑터가 `name`으로 `src/lib/sources/courtauction/courts.ts`의 60개 코드표에서 찾는다. 다른 법원 코드는 그 파일 참조. |
| `intervalMs` | `600000` (10분) | collector 수집 주기. **늘리는 것이 안전한 방향이다** — §7 참고. 이전 회차가 아직 안 끝났으면 이번 tick은 건너뛴다(중첩 실행 없음). |
| `analysis.maxItemsPerRun` | `5` | analyzer 한 회차에 분석할 최대 **신규** 물건 수(아직 분석 결과가 하나도 없는 물건). Claude 호출 비용의 상한이다. 올리면 회차당 비용과 소요 시간이 비례해 늘어난다(호출은 순차 실행). |
| `analysis.maxReanalysisPerRun` | `2` | analyzer 한 회차에 재분석할 최대 물건 수(§6 참고). `maxItemsPerRun`과는 **독립된 별도 한도**다 — 회차당 총 Claude 호출 수 상한은 두 값의 **합**(`maxItemsPerRun + maxReanalysisPerRun`, 기본 5+2=7)이지, 하나의 한도를 나눠 쓰는 게 아니다. |
| `analysis.intervalMs` | `600000` (10분) | analyzer 주기. 신규 미분석 물건도 재분석 대상도 없으면 `[analyzer] 미분석 물건도 재분석 대상도 없음`만 찍고 아무것도 호출하지 않는다. |

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
| `AUCTIONBOSS_COLLECT_PAGE_SIZE` | collector | `40` | 한 요청으로 가져올 **행** 수. **40이 서버 상한이고, 넘기면 경고 후 40으로 클램프된다**(§7). |
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

다섯 개다(`find src/app/api -name route.ts` 기준: `/api/items`, `/api/items/[id]`,
`/api/items/[id]/changes`, `/api/items/usage-types`, `/api/analyses`). analyzer는 이 중
`GET /api/items`(§1의 두 단계 조회에 각각 한 번씩)와 `POST /api/analyses`를 계약으로
쓰므로 응답 형태를 임의로 바꾸면 안 된다 — 나머지(`/api/items/[id]`, `.../changes`,
`.../usage-types`)는 웹 UI 전용이라 analyzer와 무관하다.

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
      "lastChangedAt": "2026-09-06T07:05:12.000Z"  // 감시 필드의 가장 최근 "실제" 변경 시각.
                                                     // 기준점(최초 저장)은 세지 않는다. 변경이
                                                     // 한 번도 없으면 null(§6 참고).
    }
  ],
  "total": 8,
  "page": 1,
  "pageSize": 20
}
```

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

이전 분석 이력 전체(최신 포함, 최신순)는 이 엔드포인트가 아니라 물건 상세 페이지
(`/items/[id]`)가 서버 컴포넌트 안에서 `listAnalyses(itemId)`로 직접 읽어 렌더링한다 —
이력 전용 API는 없다.

### `GET /api/items/[id]/changes` — 물건 변경 이력

물건의 감시 대상 필드(최저매각가격, 유찰횟수, 매각기일, 진행상태) 변경 이력을 시간순으로
전부 반환한다.

- 없는 `id`(숫자가 아니거나 물건이 없음)면 **404**.
- **`changes`는 필터링되지 않는다 — 최초 저장 시의 기준점 행(baseline)도 그대로 포함된
  전체 이력이다.** 물건이 처음 수집될 때 감시 대상 필드(값이 `NULL`이 아닌 것)마다
  `oldValue: null`인 기준점 행이 만들어지고(§6.1 D2), 이후 실제 값이 바뀔 때마다
  `oldValue`가 채워진 행이 추가된다. 두 종류가 같은 배열에 시간순으로 섞여서 나온다 —
  **`"changes": []`는 감시 필드가 전부 `NULL`인 물건에서만 나온다(진짜 빈 이력)**. 두 번
  수집된 보통 물건이면 감시 필드 4개의 기준점 4행 + 실제 변경 수만큼이 반환된다(예:
  `src/app/api/items/[id]/changes/__tests__/route.test.ts`는 최초 수집 1회 + 실제 변경
  1회 뒤 **6건**(기준점 4 + 변경 2)을 기대한다 — 실측으로도 확인했다: `npm run build` 후
  스크래치 DB에 위 시나리오를 재현해 `curl`한 결과 정확히 6건이 돌아왔다).
  클라이언트가 "진짜 변경"만 보고 싶으면 **`oldValue !== null`인 행만 걸러야 한다**
  (`src/app/_lib/change-history.ts`의 `isRealChange`가 하는 일과 같다).

```jsonc
// 200 OK — 두 번 수집된 물건의 실제 응답 예 (baseline 4건 + 실제 변경 2건)
{
  "changes": [
    { "id": 1, "itemId": 1, "field": "minBidPrice", "oldValue": null, "newValue": "400000000",
      "changedAt": "2026-01-01T00:00:00.000Z" },      // ← 기준점(최초 저장). oldValue가 null이면 기준점.
    { "id": 2, "itemId": 1, "field": "failedBidCount", "oldValue": null, "newValue": "1",
      "changedAt": "2026-01-01T00:00:00.000Z" },      // ← 기준점
    { "id": 3, "itemId": 1, "field": "auctionDate", "oldValue": null, "newValue": "2026-10-01",
      "changedAt": "2026-01-01T00:00:00.000Z" },      // ← 기준점
    { "id": 4, "itemId": 1, "field": "status", "oldValue": null, "newValue": "진행",
      "changedAt": "2026-01-01T00:00:00.000Z" },      // ← 기준점
    { "id": 5, "itemId": 1, "field": "minBidPrice",       // WatchedField: minBidPrice | failedBidCount | auctionDate | status
      "oldValue": "400000000",      // 문자열로 저장된다(§6.1 참고). null이 아니므로 실제 변경.
      "newValue": "300000000",
      "changedAt": "2026-01-02T00:00:00.000Z" },
    { "id": 6, "itemId": 1, "field": "failedBidCount", "oldValue": "1", "newValue": "2",
      "changedAt": "2026-01-02T00:00:00.000Z" }
  ]
}
```

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

## 7. ⚠️ 수집 관련 주의사항

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

## 8. 개발

```bash
npm test        # vitest run — 239 tests / 12 files
npm run typecheck   # tsc --noEmit
npm run lint        # eslint (설정: eslint.config.mjs, next/core-web-vitals + next/typescript)
```

- 테스트 위치 (`vitest.config.mts`가 `src/**/*.test.ts`, `src/**/__tests__/**/*.test.ts`, `workers/**/*.test.ts`를 수집):
  - `src/lib/db/__tests__/client.test.ts`, `repository.test.ts`
  - `src/lib/domain/__tests__/config.test.ts`, `item-query.test.ts`
  - `src/lib/sources/courtauction/__tests__/adapter.test.ts` (+ `fixtures.ts`)
  - `src/app/_lib/__tests__/change-history.test.ts`, `analysis-history.test.ts`, `item-query-url.test.ts`
  - `src/app/api/items/__tests__/route.test.ts`, `src/app/api/items/[id]/changes/__tests__/route.test.ts`, `src/app/api/items/usage-types/__tests__/route.test.ts`
  - `workers/__tests__/analyzer.test.ts`
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
    add-price-change-history/  # 진행 중인 change (예)
      proposal.md              # 왜 하는가
      design.md                # 설계 결정과 리스크
      specs/                   # 이 change가 더하는 스펙 델타
      tasks.md                 # 실행 단위 태스크 목록
    archive/                   # 완료된 change (예: 2026-09-07-auction-pipeline-mvp/,
                                #                    2026-09-07-add-item-search-filters/)
```

구현 전에 해당 change의 proposal / design / specs / tasks를 먼저 읽는다.
Claude Code 슬래시 커맨드가 `.claude/commands/opsx/`에 들어 있다:

- `/opsx:propose` — 새 change 제안 + 아티팩트 생성
- `/opsx:apply` — tasks.md의 태스크를 구현
- `/opsx:update` — 진행 중 change의 계획 문서 갱신
- `/opsx:archive` — 완료된 change를 archive로 이동
- `/opsx:sync` — change의 델타 스펙을 `openspec/specs/`에 반영

## 9. 프로젝트 구조

중요한 경로만 추렸다.

```
.
+- config/
|   +- collector.json              # 수집 범위/주기/분석 건수 (§4.1)
+- src/
|   +- app/                        # Next.js App Router
|   |   +- page.tsx                # 물건 목록 (/)
|   |   +- items/[id]/page.tsx     # 물건 상세 + AI 분석(최신/이전) + 변경 이력 (/items/:id)
|   |   +- api/items/route.ts      # GET /api/items (page, pageSize, analyzed, needsAnalysis,
|   |   |                          #   promptVersion, usage, minPrice, maxPrice, minFailed, q, sort, dir)
|   |   +- api/items/[id]/route.ts # GET /api/items/:id
|   |   +- api/items/[id]/changes/route.ts  # GET /api/items/:id/changes
|   |   +- api/items/usage-types/route.ts   # GET /api/items/usage-types
|   |   +- api/analyses/route.ts   # POST /api/analyses
|   |   +- _components/item-filter-form.tsx # 목록 필터·정렬 폼(순수 <form method="get">)
|   |   +- _lib/format.ts          # 금액/날짜 표시 포맷터
|   |   +- _lib/change-history.ts  # 변경 이력 표시 판단(기준점 구별, 가격 변화폭 등)
|   |   +- _lib/analysis-history.ts # 분석 이력 표시 판단(최신/이전 분리)
|   |   +- _lib/item-query-url.ts  # ItemQuery -> 목록 페이지 URL 직렬화
|   +- lib/
|       +- domain/                 # 정규화 도메인 모델 + config 로더
|       |   +- types.ts            # AuctionItem, Analysis, ItemChange, CollectorConfig ...
|       |   +- config.ts           # config/collector.json 로딩 + zod 검증
|       |   +- item-query.ts       # GET /api/items 쿼리 파라미터 파싱(ItemQuery, strict/lenient)
|       +- db/                     # SQLite 접근 (여기 밖으로 snake_case 컬럼명이 안 나간다)
|       |   +- client.ts           # 연결/WAL/싱글턴, AUCTIONBOSS_DB 해석
|       |   +- schema.ts           # items / analyses / item_changes 테이블 DDL
|       |   +- repository.ts       # upsertItems, listItems, insertAnalysis, listItemChanges ...
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
+- openspec/                       # 계획/스펙 (§8)
+- data/auctionboss.db             # 기본 DB 파일 (git ignore, 첫 실행 때 생성)
```

## 10. 알려진 한계 / 다음 단계

1. **"진행 중" 필터의 의미가 검증되지 않았다.** 사이트에 진행상태 전용 파라미터를 찾지 못해
   매각기일 범위(`오늘 ~ 오늘+60일`)로 대신하고 있다. 이것이 사이트가 말하는 "진행중"과 같은 개념인지는
   미확인이다(수신 행은 전부 `mulJinYn="Y"`였다). — NOTES §6.2 row 0, §9.3
2. **10분 주기 상시 운용이 미검증이다.** §7 참고. 장시간 무인 운용 로그가 아직 없다.
3. **비공식 엔드포인트라 예고 없이 바뀔 수 있다.** zod 검증으로 즉시 감지·로그하지만, 바뀌면 수집은 멈춘다.
   대안인 **상용 데이터 API 어댑터는 아직 구현되어 있지 않다**(`AuctionSource` 인터페이스만 열려 있는 상태).
4. **프롬프트가 1단계 수준이다.** 시세·등기부·권리관계·임차인 정보 없이 물건 JSON 한 덩어리만 보고 쓴 요약이다.
   분석 본문은 markdown이지만 화면에서는 렌더링 없이 원문 그대로 표시한다.
5. **워커가 죽으면 수동 재시작이다.** 프로세스 매니저(pm2 등)나 재시작 정책이 없다. 시작/종료 로그로
   감지만 가능하다. 배포 단계에서 도입 예정.
6. **목록 화면 필터에는 UI가 없는 조건도 있다.** 용도·가격대·유찰횟수·소재지 키워드·정렬은
   `ItemFilterForm`(`src/app/_components/item-filter-form.tsx`)으로 붙어 있다. 다만
   `analyzed`(분석 여부)는 URL로는 받아 유지하지만 폼에 입력칸이 없고, `needsAnalysis`는
   analyzer 전용이라 애초에 사람이 쓸 UI가 없다.
7. **인증/권한이 없다.** 서버를 띄우면 접근 가능한 누구나 전체를 볼 수 있다. 로컬/내부망 전제다.
8. **가짜 변경(노이즈) 필터링 규칙이 없다.** 소스가 같은 물건을 다른 값으로 표기하는 사례가
   이미 관측됐다(`유찰횟수`와 `최저매각가격`이 어긋나는 행 — `openspec/changes/archive/
   2026-09-07-auction-pipeline-mvp/design.md`). 그런 노이즈도 지금은 "실제 변경"으로
   기록되고 재분석을 유발해 비용이 된다. 1차 방어는 `maxReanalysisPerRun` 상한뿐이고,
   필터링 규칙은 실제 변경 이력을 며칠 관측한 뒤에 정할 예정이다
   (`openspec/changes/add-price-change-history/design.md` Risks / Open Questions).
9. **"최근 변동" 기준 7일이 검증된 값은 아니다.** 매각기일 주기(보통 1개월 이상)를 감안하면
   더 길어야 할 수 있다. `src/app/_lib/change-history.ts`의 `RECENT_CHANGE_DAYS` 상수 하나만
   바꾸면 되므로 조정 자체는 쉽다.
