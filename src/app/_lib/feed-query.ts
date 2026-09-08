/**
 * `GET /api/bookmarks`(관심 물건 목록)와 `GET /api/feed`(변동 피드)의 URL 파라미터 검증
 * (add-bookmarks-and-feed task 3.2).
 *
 * `src/app/_lib/worker-run-query.ts`와 같은 원칙을 따른다: 인식되는 파라미터가 잘못된
 * 값으로 오면(오탈자, 범위 밖 숫자 등) 조용히 기본값으로 넘어가지 않고 400과
 * `{field, message}` 형태의 이유를 돌려준다 — 이 두 라우트는 사람이 손으로 고치는 화면
 * URL이 아니라 API 클라이언트를 위한 것이라 lenient 복구가 필요 없다.
 *
 * `src/lib/**`가 아니라 `src/app/_lib`에 두는 이유도 `worker-run-query.ts`와 같다 — 이
 * 검증 규칙은 이 두 라우트(조회 API)만을 위한 것이라 도메인 계층에 둘 이유가 없다.
 */
import { z } from "zod";

/** 목록 API의 페이지 크기 상한. 저장소(`src/lib/db/bookmarks.ts`)의 상한과 같은 값이다. */
export const MAX_PAGE_SIZE = 200;

export interface QueryIssue {
  field: string;
  message: string;
}

export type QueryParseResult<T> =
  | { success: true; query: T }
  | { success: false; issues: QueryIssue[] };

export interface PageQuery {
  page?: number;
  pageSize?: number;
}

export interface FeedListQuery extends PageQuery {
  sinceBookmarkedAt?: boolean;
}

function integerParam(label: string) {
  return z
    .string()
    .regex(/^\d+$/, `${label}은(는) 정수여야 합니다`)
    .transform((value) => Number(value))
    .refine(Number.isSafeInteger, `${label}이(가) 너무 큽니다`);
}

/** 인식되는 파라미터만 골라내고, 값이 비어 있으면(`?page=`) 이슈로 남긴다(`item-query.ts`의
 * strict 파서와 같은 판단 — 인식된 파라미터가 빈 값으로 오는 것은 실수일 가능성이 높다). */
function readParam(params: URLSearchParams, name: string): string | undefined {
  if (!params.has(name)) return undefined;
  return params.get(name)?.trim();
}

const pageQuerySchema = z.object({
  page: integerParam("page")
    .refine((value) => value >= 1, "page는 1 이상이어야 합니다")
    .optional(),
  pageSize: integerParam("pageSize")
    .refine((value) => value >= 1, "pageSize는 1 이상이어야 합니다")
    .refine((value) => value <= MAX_PAGE_SIZE, `pageSize는 ${MAX_PAGE_SIZE} 이하여야 합니다`)
    .optional(),
});

const feedQuerySchema = pageQuerySchema.extend({
  sinceBookmarkedAt: z
    .enum(["true", "false"], {
      errorMap: () => ({ message: "sinceBookmarkedAt은 true 또는 false여야 합니다" }),
    })
    .transform((value) => value === "true")
    .optional(),
});

function toIssues(error: z.ZodError): QueryIssue[] {
  return error.issues.map((issue) => ({
    field: issue.path.length > 0 ? String(issue.path[0]) : "(root)",
    message: issue.message,
  }));
}

/** `?page=&pageSize=`를 검증해 `listBookmarkedItems`에 그대로 넘길 수 있는 형태로 만든다. */
export function parsePageQuery(params: URLSearchParams): QueryParseResult<PageQuery> {
  const raw = { page: readParam(params, "page"), pageSize: readParam(params, "pageSize") };
  const result = pageQuerySchema.safeParse(raw);
  if (!result.success) return { success: false, issues: toIssues(result.error) };

  const query: PageQuery = {};
  if (result.data.page !== undefined) query.page = result.data.page;
  if (result.data.pageSize !== undefined) query.pageSize = result.data.pageSize;
  return { success: true, query };
}

/** `?page=&pageSize=&sinceBookmarkedAt=`를 검증해 `listFeed`에 그대로 넘길 수 있는 형태로
 * 만든다. */
export function parseFeedListQuery(params: URLSearchParams): QueryParseResult<FeedListQuery> {
  const raw = {
    page: readParam(params, "page"),
    pageSize: readParam(params, "pageSize"),
    sinceBookmarkedAt: readParam(params, "sinceBookmarkedAt"),
  };
  const result = feedQuerySchema.safeParse(raw);
  if (!result.success) return { success: false, issues: toIssues(result.error) };

  const query: FeedListQuery = {};
  if (result.data.page !== undefined) query.page = result.data.page;
  if (result.data.pageSize !== undefined) query.pageSize = result.data.pageSize;
  if (result.data.sinceBookmarkedAt !== undefined) {
    query.sinceBookmarkedAt = result.data.sinceBookmarkedAt;
  }
  return { success: true, query };
}
