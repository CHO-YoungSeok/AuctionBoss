/**
 * `GET /api/items/{id}/analyses`의 `limit` 검증(switch-web-to-data-port task 3.1, design.md D5).
 *
 * `feed-query.ts`와 같은 원칙이다: 인식되는 파라미터가 잘못된 값이면 400과 `{field, message}`를
 * 돌려준다. `limit`은 1 이상 50 이하의 정수이고 생략하면 10이다. 빈 값(`?limit=`)은 이슈다.
 */
import { z } from "zod";

import type { QueryParseResult } from "./feed-query";

export const DEFAULT_ANALYSES_LIMIT = 10;
export const MAX_ANALYSES_LIMIT = 50;

const schema = z.object({
  limit: z
    .string()
    .regex(/^\d+$/, "limit은(는) 정수여야 합니다")
    .transform((value) => Number(value))
    .refine(Number.isSafeInteger, "limit이(가) 너무 큽니다")
    .refine((value) => value >= 1, "limit은 1 이상이어야 합니다")
    .refine((value) => value <= MAX_ANALYSES_LIMIT, `limit은 ${MAX_ANALYSES_LIMIT} 이하여야 합니다`)
    .optional(),
});

export function parseAnalysesLimit(params: URLSearchParams): QueryParseResult<{ limit: number }> {
  const raw = params.has("limit") ? params.get("limit")?.trim() : undefined;
  const result = schema.safeParse({ limit: raw });
  if (!result.success) {
    return {
      success: false,
      issues: result.error.issues.map((issue) => ({
        field: issue.path.length > 0 ? String(issue.path[0]) : "(root)",
        message: issue.message,
      })),
    };
  }
  return { success: true, query: { limit: result.data.limit ?? DEFAULT_ANALYSES_LIMIT } };
}
