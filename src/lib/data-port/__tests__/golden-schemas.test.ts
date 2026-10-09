/**
 * Spring 구현체의 응답 스키마(zod)는 동결된 계약 골든의 실제 응답 본문을 모두 받아들여야 한다
 * (migrate-data-and-cutover 8 회귀 검증).
 *
 * 은퇴 전에는 Next 라우트 핸들러(SQLite)가 "Spring 대역"이었고 응답 모양이 실제 코드에서 나왔다. 지금 대역
 * `fake-backend.ts`의 JSON은 손으로 쓴 것이라, 대역과 zod가 함께 틀어져도 화면 테스트는 통과한다. 이 검사는
 * Java가 실제로 내는 것으로 증명된 골든 본문을 zod에 직접 먹여 그 빈틈을 막는다. 골든은 동결이므로
 * Spring이 응답을 바꾸면 Java 골든 테스트가 먼저 깨지고, 그 골든을 갱신하면 여기서 TS 쪽 불일치가 드러난다.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";

import {
  analysisHistoryResponseSchema,
  feedResponseSchema,
  filterOptionsResponseSchema,
  itemChangesResponseSchema,
  itemDetailResponseSchema,
  itemListResponseSchema,
  itemPhotosResponseSchema,
  rotationResponseSchema,
  runsSummaryResponseSchema,
  workerRunListResponseSchema,
  workerStatusSchema,
} from "../spring/schemas";
import { CONTRACTS_DIR } from "./golden-shapes";

interface Step {
  request: { method?: string; path: string };
  status: number;
  body: unknown;
}

const SCHEMAS: [RegExp, z.ZodTypeAny][] = [
  [/^\/api\/items$/, itemListResponseSchema],
  [/^\/api\/bookmarks$/, itemListResponseSchema],
  [/^\/api\/items\/\d+$/, itemDetailResponseSchema],
  [/^\/api\/items\/filter-options$/, filterOptionsResponseSchema],
  [/^\/api\/items\/\d+\/analyses$/, analysisHistoryResponseSchema],
  [/^\/api\/items\/\d+\/changes$/, itemChangesResponseSchema],
  [/^\/api\/items\/\d+\/photos$/, itemPhotosResponseSchema],
  [/^\/api\/feed$/, feedResponseSchema],
  [/^\/api\/worker-runs$/, workerRunListResponseSchema],
  [/^\/api\/worker-runs\/status$/, workerStatusSchema],
  [/^\/api\/worker-runs\/summary$/, runsSummaryResponseSchema],
  [/^\/api\/collector-state\/rotation$/, rotationResponseSchema],
];
/** 포트가 쓰지 않는 GET(웹 화면이 부르지 않는 엔드포인트)과 파일 응답. */
const NOT_USED_BY_PORT = [/^\/api\/items\/usage-types$/, /^\/api\/photos\//];

function successfulGets(): Step[] {
  const steps: Step[] = [];
  for (const name of readdirSync(CONTRACTS_DIR).filter((f) => f.endsWith(".json"))) {
    const golden = JSON.parse(readFileSync(path.join(CONTRACTS_DIR, name), "utf8")) as Step;
    steps.push(golden);
  }
  const dir = path.join(CONTRACTS_DIR, "scenarios");
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    steps.push(...(JSON.parse(readFileSync(path.join(dir, name), "utf8")) as { steps: Step[] }).steps);
  }
  return steps.filter((s) => (s.request.method ?? "GET") === "GET" && s.status === 200);
}

describe("Spring 응답 스키마는 계약 골든의 성공 응답 본문을 받아들인다", () => {
  const steps = successfulGets();

  it("골든을 실제로 읽었고, 모든 GET 경로가 스키마에 연결되거나 의도적으로 제외돼 있다", () => {
    expect(steps.length).toBeGreaterThan(100);
    const unmapped = steps
      .map((s) => s.request.path)
      .filter((p) => !SCHEMAS.some(([re]) => re.test(p)) && !NOT_USED_BY_PORT.some((re) => re.test(p)));
    expect([...new Set(unmapped)]).toEqual([]);
  });

  it("매핑된 모든 본문이 zod를 통과한다", () => {
    let checked = 0;
    const failures: string[] = [];
    for (const step of steps) {
      const entry = SCHEMAS.find(([re]) => re.test(step.request.path));
      if (!entry) continue;
      checked += 1;
      const result = entry[1].safeParse(step.body);
      if (!result.success) failures.push(`${step.request.path}: ${result.error.issues[0]?.path.join(".")} ${result.error.issues[0]?.message}`);
    }
    expect(checked).toBeGreaterThan(100);
    expect(failures).toEqual([]);
  });
});
