/**
 * Spring HTTP 클라이언트(switch-web-to-data-port D3, 4.2). 서버에서만 쓴다.
 *
 * - `cache: "no-store"`, 요청마다 시간 제한(기본 5초).
 * - 허용 상태(대부분 200, 쓰기는 200·201)와 허용된 404만 값으로 돌려주고, 연결 실패·시간 초과·
 *   그 밖의 상태·JSON이 아닌 본문·스키마 불일치는 `DataSourceError`다. 다른 원천으로 대신 읽지 않는다.
 * - 로그와 오류에는 메서드·경로·원인만 남긴다. 쿼리 값(주소 검색어 등)은 어디에도 담지 않는다.
 */
import "server-only";

import type { z } from "zod";

import { DataSourceError } from "../port";

export const DEFAULT_TIMEOUT_MS = 5000;

/** 보낸 요청의 기록. 쿼리는 값 없이 키만 담는다(테스트의 요청 수·모양 확인용). */
export interface SpringRequestRecord {
  method: string;
  path: string;
  queryKeys: string[];
}

export interface SpringClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  onRequest?: (record: SpringRequestRecord) => void;
}

export interface JsonRequest<S extends z.ZodTypeAny> {
  method: "GET" | "POST" | "DELETE";
  /** 쿼리를 제외한 경로. 예: `/api/items/3/analyses` */
  path: string;
  search?: URLSearchParams;
  /** JSON으로 보내는 본문. */
  body?: unknown;
  schema: S;
  /** 성공으로 보는 상태. 기본 `[200]`. */
  okStatuses?: readonly number[];
  /** `true`면 404를 오류가 아니라 `{ found: false }`로 돌려준다. */
  allowNotFound?: boolean;
}

export type JsonResult<T> = { found: true; data: T } | { found: false };

export interface RawResponse {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
}

export interface SpringClient {
  json<S extends z.ZodTypeAny>(request: JsonRequest<S>): Promise<JsonResult<z.infer<S>>>;
  /** 본문을 해석하지 않고 상태·헤더·바이트를 그대로 돌려준다(사진 파일). */
  raw(method: "GET", path: string): Promise<RawResponse>;
}

export function createSpringClient(options: SpringClientOptions): SpringClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function send(
    method: string,
    path: string,
    search: URLSearchParams | undefined,
    body?: unknown,
  ): Promise<Response> {
    const url = new URL(path, options.baseUrl);
    if (search !== undefined) url.search = search.toString();
    options.onRequest?.({ method, path, queryKeys: [...new Set(search?.keys() ?? [])].sort() });
    try {
      const doFetch = options.fetch ?? fetch;
      return await doFetch(url, {
        method,
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
        headers:
          body === undefined
            ? { accept: "application/json" }
            : { accept: "application/json", "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      throw fail(method, path, null, cause);
    }
  }

  return {
    async json(request) {
      const { method, path } = request;
      const response = await send(method, path, request.search, request.body);
      if (request.allowNotFound === true && response.status === 404) {
        await drain(response);
        return { found: false };
      }
      const ok = request.okStatuses ?? [200];
      if (!ok.includes(response.status)) {
        await drain(response);
        throw fail(method, path, response.status, new Error("기대하지 않은 상태 코드"));
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (cause) {
        throw fail(method, path, response.status, new Error("응답 본문이 JSON이 아닙니다", { cause }));
      }
      const parsed = request.schema.safeParse(payload);
      if (!parsed.success) {
        // 어느 필드가 틀렸는지만 남긴다(값은 남기지 않는다).
        const where = parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
          .join("; ");
        throw fail(method, path, response.status, new Error(`응답 형식이 다릅니다 (${where})`));
      }
      return { found: true, data: parsed.data };
    },

    async raw(method, path) {
      const response = await send(method, path, undefined);
      try {
        return {
          status: response.status,
          headers: response.headers,
          bytes: new Uint8Array(await response.arrayBuffer()),
        };
      } catch (cause) {
        throw fail(method, path, response.status, cause);
      }
    },
  };
}

async function drain(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    // 본문을 못 읽어도 상태로 이미 판단했다.
  }
}

function fail(method: string, path: string, status: number | null, cause: unknown): DataSourceError {
  const error = new DataSourceError(method, path, status, cause);
  console.error(`[data-port] ${error.message}`);
  return error;
}
