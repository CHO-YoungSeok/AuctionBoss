/**
 * `GET /api/worker-runs`(목록)와 `GET /api/worker-runs/summary`(집계)의 URL 파라미터
 * 검증(design.md 스펙 "회차 기록 조회").
 *
 * `src/lib/domain/item-query.ts`의 strict 파서와 같은 원칙을 따른다: 인식되는 파라미터가
 * 잘못된 값으로 오면(오탈자, 범위 밖 숫자 등) 조용히 기본값으로 넘어가지 않고 400과
 * `{field, message}` 형태의 이유를 돌려준다 — 이 두 라우트는 사람이 손으로 고치는 화면
 * URL이 아니라 API 클라이언트(운영자의 curl, 향후 모니터링 도구)를 위한 것이므로
 * lenient 복구가 필요 없다.
 *
 * 이 파일이 `src/lib/**`가 아니라 `src/app/_lib`에 있는 이유: 이번 그룹(5)의 작업
 * 범위가 `src/lib/**`를 건드리지 않기로 되어 있고, 이 검증 규칙은 순전히 이 두 라우트
 * (조회 API)만을 위한 것이라 도메인 계층에 둘 이유가 없다.
 */
import { z } from "zod";

import { RUN_OUTCOMES, WORKER_KINDS, type RunOutcome, type WorkerKind } from "@/lib/domain";

/** 목록 API의 페이지 크기 상한. 저장소(`src/lib/db/worker-runs.ts`)의 상한과 같은 값이다
 * — API 경계에서 먼저 거절해 저장소가 조용히 clamp하기 전에 호출자가 실수를 알게 한다. */
export const MAX_PAGE_SIZE = 200;

export interface QueryIssue {
  field: string;
  message: string;
}

export type QueryParseResult<T> =
  | { success: true; query: T }
  | { success: false; issues: QueryIssue[] };

export interface WorkerRunListQuery {
  worker?: WorkerKind;
  outcome?: RunOutcome;
  page?: number;
  pageSize?: number;
}

export interface WorkerRunSummaryQuery {
  worker?: WorkerKind;
  since?: string;
}

function integerParam(label: string) {
  return z
    .string()
    .regex(/^\d+$/, `${label}은(는) 정수여야 합니다`)
    .transform((value) => Number(value))
    .refine(Number.isSafeInteger, `${label}이(가) 너무 큽니다`);
}

/** 인식되는 파라미터만 골라내고, 값이 비어 있으면(`?worker=`) 이슈로 남긴다 — 인식된
 * 파라미터가 빈 값으로 오는 것은 "지정 안 함"이 아니라 실수일 가능성이 높다
 * (`src/lib/domain/item-query.ts`의 strict 파서와 같은 판단). */
function readParam(params: URLSearchParams, name: string): string | undefined {
  if (!params.has(name)) return undefined;
  return params.get(name)?.trim();
}

const listQuerySchema = z.object({
  worker: z
    .enum(WORKER_KINDS, {
      errorMap: () => ({ message: `worker는 ${WORKER_KINDS.join(", ")} 중 하나여야 합니다` }),
    })
    .optional(),
  outcome: z
    .enum(RUN_OUTCOMES, {
      errorMap: () => ({ message: `outcome은 ${RUN_OUTCOMES.join(", ")} 중 하나여야 합니다` }),
    })
    .optional(),
  page: integerParam("page")
    .refine((value) => value >= 1, "page는 1 이상이어야 합니다")
    .optional(),
  pageSize: integerParam("pageSize")
    .refine((value) => value >= 1, "pageSize는 1 이상이어야 합니다")
    .refine((value) => value <= MAX_PAGE_SIZE, `pageSize는 ${MAX_PAGE_SIZE} 이하여야 합니다`)
    .optional(),
});

const summaryQuerySchema = z.object({
  worker: z
    .enum(WORKER_KINDS, {
      errorMap: () => ({ message: `worker는 ${WORKER_KINDS.join(", ")} 중 하나여야 합니다` }),
    })
    .optional(),
  since: z
    .string()
    .refine((value) => !Number.isNaN(new Date(value).getTime()), "since는 올바른 ISO 날짜·시각이어야 합니다")
    .optional(),
});

function toIssues(error: z.ZodError): QueryIssue[] {
  return error.issues.map((issue) => ({
    field: issue.path.length > 0 ? String(issue.path[0]) : "(root)",
    message: issue.message,
  }));
}

/** `?worker=&outcome=&page=&pageSize=`를 검증해 `listWorkerRuns`에 그대로 넘길 수 있는
 * 형태로 만든다. */
export function parseWorkerRunListQuery(
  params: URLSearchParams,
): QueryParseResult<WorkerRunListQuery> {
  const raw = {
    worker: readParam(params, "worker"),
    outcome: readParam(params, "outcome"),
    page: readParam(params, "page"),
    pageSize: readParam(params, "pageSize"),
  };
  const result = listQuerySchema.safeParse(raw);
  if (!result.success) return { success: false, issues: toIssues(result.error) };

  const query: WorkerRunListQuery = {};
  if (result.data.worker !== undefined) query.worker = result.data.worker;
  if (result.data.outcome !== undefined) query.outcome = result.data.outcome;
  if (result.data.page !== undefined) query.page = result.data.page;
  if (result.data.pageSize !== undefined) query.pageSize = result.data.pageSize;
  return { success: true, query };
}

/** `?worker=&since=`를 검증해 `summarizeRuns`에 그대로 넘길 수 있는 형태로 만든다. */
export function parseWorkerRunSummaryQuery(
  params: URLSearchParams,
): QueryParseResult<WorkerRunSummaryQuery> {
  const raw = {
    worker: readParam(params, "worker"),
    since: readParam(params, "since"),
  };
  const result = summaryQuerySchema.safeParse(raw);
  if (!result.success) return { success: false, issues: toIssues(result.error) };

  const query: WorkerRunSummaryQuery = {};
  if (result.data.worker !== undefined) query.worker = result.data.worker;
  // 오프셋(+09:00) 표기를 UTC 밀리초 ISO로 맞춘다 — 저장된 started_at과 SQLite에서 문자열로
  // 비교하므로 같은 순간이 다른 문자열이면 결과가 갈린다. 허용 범위(위 refine)는 그대로다.
  if (result.data.since !== undefined) query.since = new Date(result.data.since).toISOString();
  return { success: true, query };
}
