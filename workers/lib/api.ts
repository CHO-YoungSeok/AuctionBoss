/**
 * 분석 워커가 쓰는 서버 HTTP 클라이언트.
 *
 * 워커는 DB를 직접 열지 않고 이 엔드포인트들로만 서버와 통신한다 (design.md D5).
 * 그래서 여기서 `better-sqlite3`나 `@/lib/db`를 import하지 않는다 — 타입만
 * `@/lib/domain`에서 가져온다. `startWorkerRun`/`finishWorkerRun`(design.md D3,
 * add-collection-observability)도 같은 이유로 이 파일에 있다 — 분석 워커의 회차 기록은
 * `POST`/`PATCH /api/worker-runs`를 거쳐야만 하고, 그 HTTP 클라이언트가 여기다.
 *
 * 응답은 zod로 검증한다. 형식이 바뀌면 undefined가 조용히 흘러다니는 대신
 * 파싱 시점에 터지게 하려는 것이다.
 */
import { z } from "zod";

import type { AnalyzerRunDetail, AuctionItem, RunOutcome, WorkerKind } from "@/lib/domain";

/** 주입 가능한 fetch. 테스트는 여기에 가짜를 넣어 네트워크를 쓰지 않는다. */
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export const DEFAULT_API_BASE = "http://localhost:3000";

export class AnalyzerApiError extends Error {
  override readonly name = "AnalyzerApiError";
  constructor(
    message: string,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

const auctionItemSchema = z.object({
  id: z.number(),
  court: z.string(),
  caseNo: z.string(),
  itemNo: z.string(),
  address: z.string().nullable(),
  usageType: z.string().nullable(),
  appraisalPrice: z.number().nullable(),
  minBidPrice: z.number().nullable(),
  auctionDate: z.string().nullable(),
  failedBidCount: z.number().nullable(),
  status: z.string().nullable(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  lastChangedAt: z.string().nullable().optional(),
  // hardening-round1 task 2 발견: AuctionItem(도메인 타입)에는 있는데 이 스키마엔 없어서
  // 조용히 strip되고 있었다 — 아래 KeysEqual 검사가 이 정확한 종류의 누락을 잡아낸다.
  // analyzer가 bookmarked 값을 쓰지는 않지만, "응답에 실제로 있는 필드가 파싱 후
  // 사라진다"는 사실 자체가 이 파일 상단에 적힌 원래 결함(32개 필드 strip)과 같은
  // 클래스라 다른 필드와 동일하게 스키마에 선언한다.
  bookmarked: z.boolean().optional(),

  // 확장 필드 (enrich-item-fields, design.md D1~D4, src/lib/domain/types.ts의
  // AuctionItemInput과 동일한 32개). live-data-and-reports 실측(task 3.1) 중 발견한
  // 결함 수정: 이 schema가 이 필드들을 몰라 zod가 조용히 strip해 왔다 — 그래서
  // GET /api/items 응답에는 minArea/minBidPriceRound1/note 등이 실제로 들어 있는데도
  // analyzer가 파싱한 뒤에는 전부 undefined가 됐고, `computeDerivedFigures`가 항상
  // "계산 불가"를 반환하고 프롬프트의 물건 JSON에도 이 필드들이 아예 없었다(§9 실측
  // 참고). 분석 본문이 "면적 또는 최저매각가격 정보 없음"이라고 실제로는 존재하는
  // 값을 없다고 말하는 것은 design.md D5가 즉시 고치라는 "사용자에게 틀린 정보를
  // 보여주는 결함"에 해당한다.
  minArea: z.number().nullable().optional(),
  maxArea: z.number().nullable().optional(),
  buildingDescription: z.string().nullable().optional(),
  minBidPriceRound1: z.number().nullable().optional(),
  minBidPriceRound2: z.number().nullable().optional(),
  minBidPriceRound3: z.number().nullable().optional(),
  minBidPriceRound4: z.number().nullable().optional(),
  minBidPriceRateRound1: z.number().nullable().optional(),
  minBidPriceRateRound2: z.number().nullable().optional(),
  usageCodeLarge: z.string().nullable().optional(),
  usageCodeMedium: z.string().nullable().optional(),
  usageCodeSmall: z.string().nullable().optional(),
  sido: z.string().nullable().optional(),
  sigungu: z.string().nullable().optional(),
  dong: z.string().nullable().optional(),
  lotNumber: z.string().nullable().optional(),
  buildingName: z.string().nullable().optional(),
  buildingUnit: z.string().nullable().optional(),
  coordinateX: z.string().nullable().optional(),
  coordinateY: z.string().nullable().optional(),
  coordinateLevel: z.string().nullable().optional(),
  auctionTime: z.string().nullable().optional(),
  auctionPlace: z.string().nullable().optional(),
  auctionDecisionDate: z.string().nullable().optional(),
  auctionRound: z.number().nullable().optional(),
  note: z.string().nullable().optional(),
  duplicateCaseNo: z.string().nullable().optional(),
  mergedCaseNo: z.string().nullable().optional(),
  courtDepartment: z.string().nullable().optional(),
  courtPhone: z.string().nullable().optional(),
  statusCode: z.string().nullable().optional(),
  itemStatusCode: z.string().nullable().optional(),

  // 상세 조회 식별자 (add-item-photos stage A, src/lib/domain/types.ts). 위 확장 필드와
  // 같은 이유(zod strip 결함 재발 방지)로 여기도 선언한다 — 아래 KeysEqual 검사가
  // 이 선언을 빠뜨리면 컴파일 시점에 잡아 준다.
  internalCaseNo: z.string().nullable().optional(),
  courtCode: z.string().nullable().optional(),

  // 사진 수집 (add-item-photos)
  photoStatus: z.enum(["uncollected", "collected", "empty", "failed"]).optional(),
  photoCount: z.number().optional(),
  photoCollectedAt: z.string().nullable().optional(),
});

// zod 스키마와 도메인 타입이 어긋나면 컴파일 시점에 잡는다(config.ts와 같은 방식).
type Assert<T extends true> = T;
export type ItemSchemaMatchesType = Assert<
  z.infer<typeof auctionItemSchema> extends AuctionItem ? true : false
>;
export type ItemTypeMatchesSchema = Assert<
  AuctionItem extends z.infer<typeof auctionItemSchema> ? true : false
>;

/**
 * hardening-round1 task 2 — 위 두 Assert만으로는 불충분하다는 것을 실제로 확인했다.
 * TypeScript의 구조적 타이핑은 "옵셔널 필드가 한쪽에만 더 있는 것"을 assignability
 * 위반으로 보지 않는다 — `AuctionItem`에 옵셔널 필드를 하나 추가해도(예: 실제로
 * `bookmarked`가 그랬다) 위 두 Assert는 계속 통과했다. 이 프로젝트의 확장 필드
 * 32개가 전부 옵셔널이라, 새 옵셔널 필드가 스키마 없이 추가되는 경우가 정확히
 * 원래 결함(zod strip)이 재발하는 경로다.
 *
 * `keyof`로 필드 "이름의 집합"만 떼어 비교하면 옵셔널 여부와 무관하게 양쪽 필드
 * 이름이 정확히 같은지 확인할 수 있다 — 한쪽에만 있는 필드는(옵셔널이어도) 그 필드
 * 이름 자체가 다른 쪽 keyof 집합에 없으므로 `extends`가 깨진다.
 */
type KeysEqual<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A]
    ? true
    : false
  : false;
export type ItemSchemaKeysMatchType = Assert<
  KeysEqual<z.infer<typeof auctionItemSchema>, AuctionItem>
>;

export const itemsResponseSchema = z.object({
  items: z.array(auctionItemSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});

export type ItemsResponse = z.infer<typeof itemsResponseSchema>;

/** 끝의 슬래시를 없애 `${base}/api/...` 조립이 항상 같은 URL이 되게 한다. */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

async function readBodyForError(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 500);
  } catch {
    return "(본문을 읽을 수 없음)";
  }
}

/** 공통 요청 로직. 두 조회 함수(`fetchUnanalyzedItems`/`fetchReanalysisCandidates`)가 공유한다. */
async function fetchItemsResponse(url: string, fetchFn: FetchFn): Promise<ItemsResponse> {
  let response: Response;
  try {
    response = await fetchFn(url, { headers: { accept: "application/json" } });
  } catch (cause) {
    throw new AnalyzerApiError(`물건 목록 요청 실패: ${url}`, undefined, { cause });
  }

  if (!response.ok) {
    throw new AnalyzerApiError(
      `물건 목록 조회가 ${response.status}로 실패했습니다: ${await readBodyForError(response)}`,
      response.status,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new AnalyzerApiError("물건 목록 응답이 JSON이 아닙니다", response.status, { cause });
  }

  const parsed = itemsResponseSchema.safeParse(payload);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join(", ");
    throw new AnalyzerApiError(`물건 목록 응답 형식이 예상과 다릅니다 — ${details}`, response.status);
  }

  return parsed.data;
}

/** 분석 결과가 없는 물건을 회차 최대 건수만큼 가져온다. */
export async function fetchUnanalyzedItems(options: {
  baseUrl: string;
  pageSize: number;
  fetchFn: FetchFn;
}): Promise<ItemsResponse> {
  const { baseUrl, pageSize, fetchFn } = options;
  const url = `${normalizeBaseUrl(baseUrl)}/api/items?analyzed=false&pageSize=${pageSize}`;
  return fetchItemsResponse(url, fetchFn);
}

/**
 * 재분석이 필요한 물건을 회차 최대 건수만큼 가져온다(design.md D4).
 * `promptVersion`은 워커의 현재 `PROMPT_VERSION`이다 — 서버는 저장된 최신 분석의
 * 버전과 다르면(같음/다름만 비교) 재분석 대상으로 본다.
 */
export async function fetchReanalysisCandidates(options: {
  baseUrl: string;
  pageSize: number;
  promptVersion: string;
  fetchFn: FetchFn;
}): Promise<ItemsResponse> {
  const { baseUrl, pageSize, promptVersion, fetchFn } = options;
  const url =
    `${normalizeBaseUrl(baseUrl)}/api/items?needsAnalysis=true` +
    `&promptVersion=${encodeURIComponent(promptVersion)}&pageSize=${pageSize}`;
  return fetchItemsResponse(url, fetchFn);
}

export interface AnalysisPayload {
  itemId: number;
  body: string;
  promptVersion: string;
  model?: string;
}

/** 분석 결과를 서버에 저장한다. 2xx가 아니면 throw해서 호출자가 실패로 세게 한다. */
export async function postAnalysis(options: {
  baseUrl: string;
  payload: AnalysisPayload;
  fetchFn: FetchFn;
}): Promise<void> {
  const { baseUrl, payload, fetchFn } = options;
  const url = `${normalizeBaseUrl(baseUrl)}/api/analyses`;

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (cause) {
    throw new AnalyzerApiError(`분석 결과 전송 실패: ${url}`, undefined, { cause });
  }

  if (!response.ok) {
    throw new AnalyzerApiError(
      `분석 결과 저장이 ${response.status}로 거절됐습니다: ${await readBodyForError(response)}`,
      response.status,
    );
  }
}

// ---------------------------------------------------------------------------
// 회차 기록 (add-collection-observability, design.md D3)
//
// 분석 워커는 DB를 직접 쓰지 않으므로(D5) 회차 기록도 API를 거친다 — collector가
// 저장소 함수를 직접 호출하는 것과 대비된다. 두 경로가 같은 저장소 함수
// (`startRun`/`finishRun`)를 호출하는 얇은 라우트(`src/app/api/worker-runs/**`) 뒤에서
// 만나므로 기록 규칙 자체는 갈라지지 않는다.
//
// 이 두 함수는 실패하면 그대로 throw한다 — "기록 실패가 워커를 죽이면 안 된다"(design.md
// D4)는 규칙은 호출자(analyzer.ts)의 책임이다. 여기서 삼키면 analyzer.ts가 기록 성공
// 여부를 알 방법이 없어진다(예: 시작 기록이 실패했는데 종료 기록을 시도하는 것을 막을
// 수 없다).
// ---------------------------------------------------------------------------

const startWorkerRunResponseSchema = z.object({ id: z.number() });

/** `POST /api/worker-runs` — 회차 시작 기록. 실패하면 `AnalyzerApiError`를 던진다. */
export async function startWorkerRun(options: {
  baseUrl: string;
  worker: WorkerKind;
  fetchFn: FetchFn;
}): Promise<number> {
  const { baseUrl, worker, fetchFn } = options;
  const url = `${normalizeBaseUrl(baseUrl)}/api/worker-runs`;

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worker }),
    });
  } catch (cause) {
    throw new AnalyzerApiError(`회차 시작 기록 요청 실패: ${url}`, undefined, { cause });
  }

  if (!response.ok) {
    throw new AnalyzerApiError(
      `회차 시작 기록이 ${response.status}로 실패했습니다: ${await readBodyForError(response)}`,
      response.status,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new AnalyzerApiError("회차 시작 기록 응답이 JSON이 아닙니다", response.status, { cause });
  }

  const parsed = startWorkerRunResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new AnalyzerApiError("회차 시작 기록 응답 형식이 예상과 다릅니다", response.status);
  }
  return parsed.data.id;
}

/** `PATCH /api/worker-runs/[id]`로 보낼 회차 종료 입력. analyzer 전용이라 detail이 `AnalyzerRunDetail`로 고정된다. */
export interface FinishWorkerRunInput {
  outcome: Exclude<RunOutcome, "running" | "skipped">;
  errorKind?: string | null;
  errorMessage?: string | null;
  detail?: AnalyzerRunDetail | null;
}

/** `PATCH /api/worker-runs/[id]` — 회차 종료 기록. 실패하면 `AnalyzerApiError`를 던진다. */
export async function finishWorkerRun(options: {
  baseUrl: string;
  runId: number;
  input: FinishWorkerRunInput;
  fetchFn: FetchFn;
}): Promise<void> {
  const { baseUrl, runId, input, fetchFn } = options;
  const url = `${normalizeBaseUrl(baseUrl)}/api/worker-runs/${runId}`;

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch (cause) {
    throw new AnalyzerApiError(`회차 종료 기록 요청 실패: ${url}`, undefined, { cause });
  }

  if (!response.ok) {
    throw new AnalyzerApiError(
      `회차 종료 기록이 ${response.status}로 실패했습니다: ${await readBodyForError(response)}`,
      response.status,
    );
  }
}
