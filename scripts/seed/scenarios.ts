/**
 * 시나리오 골든 정의 (add-spring-write-api D10).
 * 요청 순서가 상태를 바꾸는 시나리오 7개. 응답은 generate-scenarios.ts가 Next 핸들러를 불러 채운다.
 */

export interface StepDef {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** `{변수}`는 앞 단계 capture 값으로 치환된다. */
  path: string;
  /** 이미 퍼센트 인코딩된 쿼리 문자열(앞의 ? 제외). */
  query?: string;
  /** JSON.stringify해서 보내는 본문. */
  body?: unknown;
  /** 그대로 보내는 본문(JSON이 아닌 경우). body와 함께 쓰지 않는다. */
  rawBody?: string;
  /** 변수명 -> 응답 본문의 `$.a.b` 경로. */
  capture?: Record<string, string>;
}

export interface PhotoFixture {
  itemId: number;
  seq: number;
  /** 사진 디렉터리 기준 상대 경로(`..`로 디렉터리 밖을 가리킬 수 있다). */
  filePath: string;
  fileSize: number;
  mimeType: string;
  collectedAt: string;
  /** `contracts/photos/` 안의 픽스처 파일명. null이면 파일을 만들지 않는다(파일 없음). */
  fixture: string | null;
}

export interface ScenarioConfig {
  /** `observability.maxRunsPerWorker` 덮어쓰기. */
  maxRunsPerWorker?: number;
  /** `analysis.reanalysisCooldownHours` 덮어쓰기. */
  reanalysisCooldownHours?: number;
}

export interface ScenarioDef {
  name: string;
  config: ScenarioConfig;
  photos?: PhotoFixture[];
  steps: StepDef[];
}

export const CLOCK = { start: "2026-10-08T00:00:00.000Z", stepMs: 1000 } as const;

const ANALYZER_DETAIL = { newCount: 2, reanalysisCount: 1, succeeded: 3, failed: 0 };
const COLLECTOR_DETAIL = {
  targetCourts: ["서울중앙지방법원"],
  pagesRequested: 12,
  itemsFetched: 389,
  inserted: 0,
  updated: 389,
  changed: 7,
};

const post = (path: string, body?: unknown, capture?: Record<string, string>): StepDef => ({
  method: "POST",
  path,
  ...(body !== undefined ? { body } : {}),
  ...(capture ? { capture } : {}),
});
const get = (path: string, query?: string): StepDef => ({ method: "GET", path, ...(query ? { query } : {}) });

const workerRunsLifecycle: ScenarioDef = {
  name: "worker-runs-lifecycle",
  config: {},
  steps: [
    post("/api/worker-runs", { worker: "analyzer" }, { run1: "$.id" }),
    { method: "PATCH", path: "/api/worker-runs/{run1}", body: { outcome: "success", detail: ANALYZER_DETAIL } },
    post("/api/worker-runs", { worker: "collector" }, { run2: "$.id" }),
    { method: "PATCH", path: "/api/worker-runs/{run2}", body: { outcome: "success", detail: COLLECTOR_DETAIL } },
    post("/api/worker-runs", { worker: "analyzer" }, { run3: "$.id" }),
    {
      method: "PATCH",
      path: "/api/worker-runs/{run3}",
      body: { outcome: "failed", errorKind: "cli", errorMessage: "분석 CLI가 비정상 종료했습니다" },
    },
    post("/api/worker-runs", { worker: "collector" }, { run4: "$.id" }),
    {
      method: "PATCH",
      path: "/api/worker-runs/{run4}",
      body: { outcome: "blocked", errorKind: "blocked", errorMessage: "차단 응답" },
    },
    post("/api/worker-runs", { worker: "analyzer" }, { run5: "$.id" }),
    get("/api/worker-runs"),
    get("/api/worker-runs", "worker=analyzer"),
    get("/api/worker-runs", "outcome=success&worker=collector"),
    get("/api/worker-runs", "outcome=running"),
    get("/api/worker-runs", "page=2&pageSize=3"),
    get("/api/worker-runs/summary"),
    get("/api/worker-runs/summary", "worker=collector"),
    get("/api/worker-runs/summary", "since=2026-10-01"),
    get("/api/worker-runs/summary", "since=2026-10-08T00:00:01.000Z"),
    get("/api/worker-runs/summary", "since=2026-10-08T09:00:02.000%2B09:00"),
  ],
};

const bad = (body: unknown): StepDef => ({ method: "PATCH", path: "/api/worker-runs/{run1}", body });

const workerRunsErrors: ScenarioDef = {
  name: "worker-runs-errors",
  config: {},
  steps: [
    post("/api/worker-runs", { worker: "bogus" }),
    post("/api/worker-runs", {}),
    post("/api/worker-runs", ["analyzer"]),
    { method: "POST", path: "/api/worker-runs", rawBody: "not json" },
    post("/api/worker-runs", { worker: "analyzer" }, { run1: "$.id" }),
    { method: "PATCH", path: "/api/worker-runs/999999", body: { outcome: "success" } },
    { method: "PATCH", path: "/api/worker-runs/abc", body: { outcome: "success" } },
    bad({ outcome: "nope" }),
    bad({ outcome: "success", errorKind: "" }),
    bad({ outcome: "success", detail: { newCount: 1 } }),
    bad({ outcome: "success", detail: { ...ANALYZER_DETAIL, succeeded: "3" } }),
    bad({ outcome: "success", detail: { photoTargets: 1, saved: 1 } }),
    bad({}),
    { method: "PATCH", path: "/api/worker-runs/{run1}", rawBody: "{" },
    bad({
      outcome: "success",
      extra: 1,
      detail: { ...ANALYZER_DETAIL, succeeded: 3.0, extra: 2 },
    }),
    get("/api/worker-runs", "worker=bogus"),
    get("/api/worker-runs", "page=0"),
    get("/api/worker-runs", "pageSize=201"),
    get("/api/worker-runs", "outcome=nope&page=abc"),
    get("/api/worker-runs/summary", "worker=bogus"),
    get("/api/worker-runs/summary", "since=abc"),
  ],
};

const workerRunsPrune: ScenarioDef = {
  name: "worker-runs-prune",
  // 시드: analyzer 4건, collector 3건. 상한 2는 둘 다보다 작다.
  config: { maxRunsPerWorker: 2 },
  steps: [
    post("/api/worker-runs", { worker: "analyzer" }, { run1: "$.id" }),
    get("/api/worker-runs", "worker=analyzer&pageSize=50"),
    post("/api/worker-runs", { worker: "analyzer" }, { run2: "$.id" }),
    get("/api/worker-runs", "worker=analyzer&pageSize=50"),
    get("/api/worker-runs", "worker=collector&pageSize=50"),
    get("/api/worker-runs", "pageSize=50"),
    get("/api/worker-runs/summary"),
  ],
};

const bookmarksFeed: ScenarioDef = {
  name: "bookmarks-feed",
  config: {},
  steps: [
    get("/api/bookmarks"),
    get("/api/feed"),
    post("/api/bookmarks", { itemId: 1 }),
    post("/api/bookmarks", { itemId: 3 }),
    post("/api/bookmarks", { itemId: 1 }),
    get("/api/bookmarks"),
    get("/api/bookmarks", "pageSize=1&page=2"),
    get("/api/items", "bookmarked=true&pageSize=50"),
    get("/api/feed"),
    get("/api/feed", "pageSize=2&page=2"),
    get("/api/feed", "sinceBookmarkedAt=true"),
    post("/api/feed/read"),
    get("/api/feed"),
    post("/api/feed/read"),
    { method: "DELETE", path: "/api/bookmarks/1" },
    get("/api/bookmarks"),
    get("/api/feed"),
    { method: "DELETE", path: "/api/bookmarks/3" },
    get("/api/bookmarks"),
    get("/api/feed"),
  ],
};

const bookmarksErrors: ScenarioDef = {
  name: "bookmarks-errors",
  config: {},
  steps: [
    post("/api/bookmarks", { itemId: 999999 }),
    { method: "DELETE", path: "/api/bookmarks/999999" },
    { method: "DELETE", path: "/api/bookmarks/abc" },
    { method: "DELETE", path: "/api/bookmarks/1" },
    post("/api/bookmarks", { itemId: "1" }),
    post("/api/bookmarks", { itemId: 0 }),
    post("/api/bookmarks", { itemId: 1.5 }),
    post("/api/bookmarks", {}),
    post("/api/bookmarks", [1]),
    { method: "POST", path: "/api/bookmarks", rawBody: "{" },
    get("/api/bookmarks", "page=0"),
    get("/api/bookmarks", "pageSize=abc&page=-1"),
    get("/api/feed", "pageSize=201"),
    get("/api/feed", "sinceBookmarkedAt=maybe"),
    get("/api/bookmarks"),
    get("/api/feed"),
  ],
};

const analysisBody = "## 요약\n개발 검증용 분석 본문입니다.\n\n- 항목 1\n- 항목 2";
const save = (body: unknown): StepDef => post("/api/analyses", body);

const analyses: ScenarioDef = {
  name: "analyses",
  config: {},
  steps: [
    get("/api/items", "analyzed=true&pageSize=1"),
    get("/api/items", "needsAnalysis=true&promptVersion=v3&pageSize=5"),
    save({ itemId: 207, body: analysisBody, promptVersion: "v3", model: "claude-opus-5-5" }),
    save({ itemId: 891, body: analysisBody, promptVersion: "v3" }),
    save({ itemId: 1, body: `${analysisBody}\n재분석`, promptVersion: "v4", model: "claude-opus-5-5" }),
    // 시드에서 재분석 대상(변경 이력이 분석보다 늦다)인 물건. 같은 버전으로 저장하면 대상에서 빠진다.
    save({ itemId: 30, body: analysisBody, promptVersion: "v3", model: "claude-opus-5-5" }),
    get("/api/items/207"),
    get("/api/items/891"),
    get("/api/items/1"),
    get("/api/items", "analyzed=true&pageSize=50"),
    get("/api/items", "needsAnalysis=true&promptVersion=v3&pageSize=5"),
    get("/api/items", "needsAnalysis=true&promptVersion=v4&pageSize=5"),
    save({ itemId: 999999, body: analysisBody, promptVersion: "v3" }),
    save({ itemId: "207", body: analysisBody, promptVersion: "v3" }),
    save({ itemId: 0, body: analysisBody, promptVersion: "v3" }),
    save({ itemId: 207, body: "", promptVersion: "v3" }),
    save({ itemId: 207, body: analysisBody, promptVersion: "" }),
    save({ itemId: 207, body: analysisBody, promptVersion: "v3", model: "" }),
    save({}),
    save([1]),
    { method: "POST", path: "/api/analyses", rawBody: "not json" },
    get("/api/items", "analyzed=true&pageSize=1"),
  ],
};

const MIN_PNG = "sample.png";
const MIN_JPG = "sample.jpg";
const COLLECTED = "2026-10-07T00:00:00.000Z";

const photos: ScenarioDef = {
  name: "photos",
  config: {},
  photos: [
    { itemId: 1, seq: 1, filePath: "1/1.png", fileSize: 70, mimeType: "image/png", collectedAt: COLLECTED, fixture: MIN_PNG },
    { itemId: 1, seq: 2, filePath: "1/2.jpg", fileSize: 22, mimeType: "image/jpeg", collectedAt: COLLECTED, fixture: MIN_JPG },
    { itemId: 1, seq: 3, filePath: "1/3.png", fileSize: 70, mimeType: "image/png", collectedAt: COLLECTED, fixture: null },
    // 파일은 실제로 존재하지만 사진 디렉터리 밖이다. 막히지 않으면 200이 나온다.
    { itemId: 1, seq: 4, filePath: "../outside.png", fileSize: 70, mimeType: "image/png", collectedAt: COLLECTED, fixture: MIN_PNG },
  ],
  steps: [
    get("/api/photos/1/1"),
    get("/api/photos/1/2"),
    get("/api/photos/1/9"),
    get("/api/photos/1/3"),
    get("/api/photos/1/4"),
    get("/api/photos/2/1"),
    get("/api/photos/abc/1"),
    get("/api/photos/1/abc"),
    get("/api/photos/12abc/1"),
    get("/api/photos/1abc/1"),
  ],
};

export const SCENARIOS: ScenarioDef[] = [
  workerRunsLifecycle,
  workerRunsErrors,
  workerRunsPrune,
  bookmarksFeed,
  bookmarksErrors,
  analyses,
  photos,
];
