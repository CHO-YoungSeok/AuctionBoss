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
});

// zod 스키마와 도메인 타입이 어긋나면 컴파일 시점에 잡는다(config.ts와 같은 방식).
type Assert<T extends true> = T;
export type ItemSchemaMatchesType = Assert<
  z.infer<typeof auctionItemSchema> extends AuctionItem ? true : false
>;
export type ItemTypeMatchesSchema = Assert<
  AuctionItem extends z.infer<typeof auctionItemSchema> ? true : false
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
