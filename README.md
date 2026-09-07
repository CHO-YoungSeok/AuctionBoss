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

핵심 경계 두 가지 (`openspec/changes/auction-pipeline-mvp/design.md` D3/D5):

- **수집 소스는 어댑터 뒤로 격리한다.** 사이트 고유 필드명(`jiwonNm`, `srnSaNo` 등)은
  `src/lib/sources/courtauction/` 밖으로 나가지 않는다. 소스를 갈아끼워도 나머지 코드는 그대로다.
- **analyzer는 DB를 직접 열지 않는다.** 서버와는 HTTP로만 통신하므로, 분석기를 다른 머신으로
  옮기거나 여러 대로 늘려도 서버 코드는 바뀌지 않는다. 대신 **서버가 떠 있어야만 분석이 돈다.**

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
    "intervalMs": 600000
  }
}
```

| 필드 | 기본값 | 의미와 바꿨을 때의 효과 |
| --- | --- | --- |
| `scope.courts[]` | 서울중앙지방법원 1곳 | 수집 대상 법원 목록. 최소 1곳 필요(빈 배열이면 시작 시 `CollectorConfigError`). 법원을 늘리면 **법원 수만큼 요청이 배로 늘어난다** — 로봇탐지 위험이 그만큼 커진다(§6). |
| `scope.courts[].name` | `"서울중앙지방법원"` | 법원 이름. DB `items.court`에 그대로 저장되는 값이다. |
| `scope.courts[].courtCode` | `"B000210"` | 사이트의 `cortOfcCd`. 빈 문자열이면 어댑터가 `name`으로 `src/lib/sources/courtauction/courts.ts`의 60개 코드표에서 찾는다. 다른 법원 코드는 그 파일 참조. |
| `intervalMs` | `600000` (10분) | collector 수집 주기. **늘리는 것이 안전한 방향이다** — §6 참고. 이전 회차가 아직 안 끝났으면 이번 tick은 건너뛴다(중첩 실행 없음). |
| `analysis.maxItemsPerRun` | `5` | analyzer 한 회차에 분석할 최대 물건 수. Claude 호출 비용의 상한이다. 올리면 회차당 비용과 소요 시간이 비례해 늘어난다(호출은 순차 실행). |
| `analysis.intervalMs` | `600000` (10분) | analyzer 주기. 미분석 물건이 없으면 `[analyzer] 미분석 물건 없음`만 찍고 아무것도 호출하지 않는다. |

설정이 없거나 JSON이 깨졌거나 스키마에 안 맞으면 **기본값으로 조용히 넘어가지 않고 즉시 종료한다**
(수집 범위가 의도와 다르게 도는 것이 더 나쁘다는 판단). 로딩은 프로세스 수명 동안 캐시되므로
설정을 고쳤으면 워커를 재시작해야 한다.

### 4.2 환경 변수

전부 선택 사항이다. 값이 있으면 `config/collector.json`보다 **우선**한다
(설정 파일을 건드리지 않고 일회성 실행·검증을 하기 위한 장치).

| 변수 | 적용 프로세스 | 기본값 | 용도 |
| --- | --- | --- | --- |
| `AUCTIONBOSS_DB` | 앱, collector | `<cwd>/data/auctionboss.db` | SQLite 파일 경로. 상대 경로면 cwd 기준으로 절대화된다. `:memory:`도 받는다(테스트용). |
| `AUCTIONBOSS_CONFIG` | 앱, collector, analyzer | `<cwd>/config/collector.json` | 설정 파일 경로. |
| `AUCTIONBOSS_COLLECT_INTERVAL_MS` | collector | `config.intervalMs` | 수집 주기(ms). 양의 정수. |
| `AUCTIONBOSS_COLLECT_BACKOFF_MS` | collector | `3600000` (1시간) | 로봇탐지 차단 감지 시 tick을 건너뛸 시간(ms). |
| `AUCTIONBOSS_COLLECT_PAGE_SIZE` | collector | `40` | 한 요청으로 가져올 **행** 수. **40이 서버 상한이고, 넘기면 경고 후 40으로 클램프된다**(§6). |
| `AUCTIONBOSS_COLLECT_PAGE_DELAY_MS` | collector | `5000` | 페이지 사이 대기(ms). 줄이면 차단 위험이 커진다. |
| `AUCTIONBOSS_COLLECT_BID_WINDOW_DAYS` | collector | `60` | 매각기일 조회 범위(오늘 ~ 오늘+N일). 줄이면 대상 행 수와 요청 횟수가 함께 줄어든다. |
| `AUCTIONBOSS_COLLECT_MAX_PAGES` | collector | `50` | 폭주 방지용 페이지 상한. 여기 걸리면 경고 로그를 남기고 그 회차를 중단한다. |
| `AUCTIONBOSS_API_BASE` | analyzer | `http://localhost:3000` | 서버 주소. 서버 포트를 바꿨으면 필수. |
| `AUCTIONBOSS_ANALYZE_MAX` | analyzer | `config.analysis.maxItemsPerRun` (5) | 회차당 최대 분석 건수. |
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

세 개뿐이고, analyzer가 이 중 둘을 계약으로 쓰므로 응답 형태를 임의로 바꾸면 안 된다.

### `GET /api/items` — 물건 목록

| 쿼리 파라미터 | 타입 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `page` | 정수 ≥ 1 | `1` | 페이지 번호 |
| `pageSize` | 정수 1~200 | `20` | 페이지 크기 |
| `analyzed` | `true` \| `false` | (없음 = 전체) | 분석 결과 유무 필터. analyzer는 `analyzed=false`를 쓴다. |

정렬은 매각기일 오름차순(값이 없는 물건은 뒤로). 잘못된 파라미터는 보정하지 않고 **400**으로 거절한다.

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
      "lastSeenAt": "2026-09-06T06:55:48.709Z"
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
  "analysis": {                 // 분석이 아직 없으면 null
    "id": 1,
    "itemId": 1,
    "body": "**요약 평가** — ...",   // markdown 원문
    "model": "claude-sonnet-5",      // CLI 출력에서 못 알아내면 null
    "promptVersion": "v1",
    "analyzedAt": "2026-09-06T06:56:57.086Z"
  }
}
```

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

물건당 분석은 여러 건 쌓일 수 있고, 조회는 항상 최신 1건을 돌려준다.

## 6. ⚠️ 수집 관련 주의사항

**이 섹션은 읽고 넘어가지 말 것.** 근거는 전부 실측이며
`src/lib/sources/courtauction/NOTES.md` §6.1 / §9와 `design.md` D6에 원본 기록이 있다.

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

## 7. 개발

```bash
npm test        # vitest run — 78 tests / 5 files
npm run typecheck   # tsc --noEmit
npm run lint        # eslint (설정: eslint.config.mjs, next/core-web-vitals + next/typescript)
```

- 테스트 위치 (`vitest.config.mts`가 `src/**/*.test.ts`, `src/**/__tests__/**/*.test.ts`, `workers/**/*.test.ts`를 수집):
  - `src/lib/db/__tests__/client.test.ts`, `repository.test.ts`
  - `src/lib/domain/__tests__/config.test.ts`
  - `src/lib/sources/courtauction/__tests__/adapter.test.ts` (+ `fixtures.ts`)
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
    auction-pipeline-mvp/      # 진행 중인 change
      proposal.md              # 왜 하는가
      design.md                # 설계 결정(D1~D7)과 리스크
      specs/                   # 이 change가 더하는 스펙 델타
      tasks.md                 # 실행 단위 태스크 목록
    archive/                   # 완료된 change
```

구현 전에 해당 change의 proposal / design / specs / tasks를 먼저 읽는다.
Claude Code 슬래시 커맨드가 `.claude/commands/opsx/`에 들어 있다:

- `/opsx:propose` — 새 change 제안 + 아티팩트 생성
- `/opsx:apply` — tasks.md의 태스크를 구현
- `/opsx:update` — 진행 중 change의 계획 문서 갱신
- `/opsx:archive` — 완료된 change를 archive로 이동
- `/opsx:sync` — change의 델타 스펙을 `openspec/specs/`에 반영

## 8. 프로젝트 구조

중요한 경로만 추렸다.

```
.
+- config/
|   +- collector.json              # 수집 범위/주기/분석 건수 (§4.1)
+- src/
|   +- app/                        # Next.js App Router
|   |   +- page.tsx                # 물건 목록 (/)
|   |   +- items/[id]/page.tsx     # 물건 상세 + AI 분석 (/items/:id)
|   |   +- api/items/route.ts      # GET /api/items
|   |   +- api/items/[id]/route.ts # GET /api/items/:id
|   |   +- api/analyses/route.ts   # POST /api/analyses
|   |   +- _lib/format.ts          # 금액/날짜 표시 포맷터
|   +- lib/
|       +- domain/                 # 정규화 도메인 모델 + config 로더
|       |   +- types.ts            # AuctionItem, Analysis, CollectorConfig ...
|       |   +- config.ts           # config/collector.json 로딩 + zod 검증
|       +- db/                     # SQLite 접근 (여기 밖으로 snake_case 컬럼명이 안 나간다)
|       |   +- client.ts           # 연결/WAL/싱글턴, AUCTIONBOSS_DB 해석
|       |   +- schema.ts           # items / analyses 테이블 DDL
|       |   +- repository.ts       # upsertItems, listItems, insertAnalysis ...
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
+- openspec/                       # 계획/스펙 (§7)
+- data/auctionboss.db             # 기본 DB 파일 (git ignore, 첫 실행 때 생성)
```

## 9. 알려진 한계 / 다음 단계

1. **"진행 중" 필터의 의미가 검증되지 않았다.** 사이트에 진행상태 전용 파라미터를 찾지 못해
   매각기일 범위(`오늘 ~ 오늘+60일`)로 대신하고 있다. 이것이 사이트가 말하는 "진행중"과 같은 개념인지는
   미확인이다(수신 행은 전부 `mulJinYn="Y"`였다). — NOTES §6.2 row 0, §9.3
2. **10분 주기 상시 운용이 미검증이다.** §6 참고. 장시간 무인 운용 로그가 아직 없다.
3. **비공식 엔드포인트라 예고 없이 바뀔 수 있다.** zod 검증으로 즉시 감지·로그하지만, 바뀌면 수집은 멈춘다.
   대안인 **상용 데이터 API 어댑터는 아직 구현되어 있지 않다**(`AuctionSource` 인터페이스만 열려 있는 상태).
4. **재분석 기능이 없다.** 분석은 "분석 결과가 하나도 없는 물건"에만 한 번 붙는다. 물건 정보가
   갱신돼도 다시 분석하지 않는다. `analyses` 테이블은 물건당 여러 행을 허용하도록 이미 설계돼 있으므로
   스키마 변경 없이 후속 change에서 명시적 트리거로 붙일 수 있다.
5. **프롬프트가 1단계 수준이다.** 시세·등기부·권리관계·임차인 정보 없이 물건 JSON 한 덩어리만 보고 쓴 요약이다.
   분석 본문은 markdown이지만 화면에서는 렌더링 없이 원문 그대로 표시한다.
6. **가격 변동 이력이 없다.** `items`는 물건당 1행을 upsert만 하므로 최저매각가격이 저감돼도
   현재 값만 남고 과거 값은 사라진다. 유찰에 따른 가격 추이를 보려면 이력 테이블이 필요하다.
7. **워커가 죽으면 수동 재시작이다.** 프로세스 매니저(pm2 등)나 재시작 정책이 없다. 시작/종료 로그로
   감지만 가능하다. 배포 단계에서 도입 예정.
8. **목록 화면에 필터가 없다.** 용도별·가격대별 필터, 정렬 선택 같은 것은 붙어 있지 않다(페이지네이션만 있다).
9. **인증/권한이 없다.** 서버를 띄우면 접근 가능한 누구나 전체를 볼 수 있다. 로컬/내부망 전제다.
