/**
 * `config/collector.json` 로더.
 *
 * Next.js 앱(서버 컴포넌트/route handler)과 `tsx workers/*.ts` 양쪽에서 그대로 import
 * 할 수 있도록 node의 `fs`/`path`만 쓴다. 클라이언트 컴포넌트에서는 import하지 말 것.
 *
 * 설정이 깨져 있으면 기본값으로 조용히 넘어가지 않고 즉시 throw한다 — 수집 범위가
 * 의도와 다르게 돌아가는 것이 설정 오류로 죽는 것보다 나쁘기 때문이다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { CollectorConfig } from "./types";

const courtRefSchema = z.object({
  name: z.string().min(1, "법원 이름(name)은 비어 있을 수 없습니다"),
  // courtCode는 어댑터(task 3.1)에서 실제 코드를 확인하기 전이라 빈 문자열을 허용한다.
  courtCode: z.string(),
});

// scale-collection-scheduling design.md D1/D5: 다른 설정 필드와 동일하게, 없거나 잘못된
// 값이면 기본값으로 조용히 넘어가지 않고 즉시 throw한다. "기본 1"(maxCourtsPerRun)과
// "기본 13"(maxRequestsPerRun, 서울중앙 1곳 기준 실측 요청 수)은 배포되는
// config/collector.json 파일 자체의 값이지, 로더가 채우는 기본값이 아니다.
const collectScopeSchema = z.object({
  courts: z.array(courtRefSchema).min(1, "수집 대상 법원이 최소 1곳은 있어야 합니다"),
  maxCourtsPerRun: z.number().int().positive(),
  maxRequestsPerRun: z.number().int().positive(),
});

const analysisConfigSchema = z.object({
  maxItemsPerRun: z.number().int().positive(),
  // maxItemsPerRun과 마찬가지로 기본값으로 조용히 채우지 않는다 — 설정 파일에 없거나
  // 잘못된 타입/범위면 즉시 throw한다(design.md D5). "기본 2"는 배포되는
  // config/collector.json 파일 자체의 값이지, 로더가 채우는 값이 아니다.
  maxReanalysisPerRun: z.number().int().positive(),
  // 코드 리뷰 finding 3: 재분석 쿨다운(시간). 0(쿨다운 없음)은 허용하지만 음수·소수·
  // 누락·잘못된 타입은 다른 analysis 필드와 똑같이 즉시 throw한다 — 조용히 기본값으로
  // 넘어가면 비용 통제가 설정 오류로 조용히 꺼진 채 운영될 수 있다.
  reanalysisCooldownHours: z.number().int().nonnegative(),
  intervalMs: z.number().int().positive(),
});

// add-collection-observability design.md D6/1.3: 다른 설정 필드와 동일하게, 없거나
// 잘못된 값이면 기본값으로 조용히 넘어가지 않고 즉시 throw한다. "기본 1000/3"은 배포되는
// config/collector.json 파일 자체의 값이지, 로더가 채우는 기본값이 아니다.
const observabilityConfigSchema = z.object({
  maxRunsPerWorker: z.number().int().positive(),
  staleAfterIntervals: z.number().int().positive(),
});

export const collectorConfigSchema = z.object({
  scope: collectScopeSchema,
  intervalMs: z.number().int().positive(),
  analysis: analysisConfigSchema,
  observability: observabilityConfigSchema,
});

// zod 스키마와 수기로 쓴 도메인 타입이 어긋나면 컴파일 시점에 잡는다(양방향 확인).
type SchemaConfig = z.infer<typeof collectorConfigSchema>;
type Assert<T extends true> = T;
export type ConfigSchemaMatchesType = Assert<
  SchemaConfig extends CollectorConfig ? true : false
>;
export type ConfigTypeMatchesSchema = Assert<
  CollectorConfig extends SchemaConfig ? true : false
>;

/**
 * hardening-round1 task 2 — 위 두 Assert는 옵셔널 필드가 한쪽에만 추가돼도 통과한다
 * (workers/lib/api.ts에서 실제로 확인된 맹점 — 상세 설명은 그 파일 참고). 지금
 * `CollectorConfig`의 필드는 전부 필수(optional 없음)라 이 맹점이 실제로는 드러나지
 * 않지만, 나중에 옵셔널 설정 필드가 추가되면 같은 문제가 생길 수 있어 미리 막아 둔다.
 */
type KeysEqual<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A]
    ? true
    : false
  : false;
export type ConfigSchemaKeysMatchType = Assert<KeysEqual<SchemaConfig, CollectorConfig>>;

/** 설정 파일 경로. 기본값은 `<repo root>/config/collector.json`. */
export const DEFAULT_CONFIG_PATH = "config/collector.json";

export function resolveConfigPath(explicitPath?: string): string {
  if (explicitPath) return path.resolve(explicitPath);
  const fromEnv = process.env.AUCTIONBOSS_CONFIG;
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(process.cwd(), DEFAULT_CONFIG_PATH);
}

/** 설정이 없거나/JSON이 깨졌거나/스키마에 맞지 않을 때 던지는 오류. */
export class CollectorConfigError extends Error {
  override readonly name = "CollectorConfigError";
  constructor(
    message: string,
    readonly configPath: string,
    options?: { cause?: unknown },
  ) {
    super(`${message} (${configPath})`, options);
  }
}

const cache = new Map<string, CollectorConfig>();

/**
 * 설정을 읽어 검증한 결과를 돌려준다. 같은 경로는 프로세스 수명 동안 캐시한다
 * (워커가 매 주기 파일을 다시 읽지 않게).
 */
export function loadCollectorConfig(options?: {
  configPath?: string;
  /** 캐시를 무시하고 다시 읽는다. 테스트/설정 변경 확인용. */
  reload?: boolean;
}): CollectorConfig {
  const resolved = resolveConfigPath(options?.configPath);
  if (!options?.reload) {
    const cached = cache.get(resolved);
    if (cached) return cached;
  }

  let raw: string;
  try {
    raw = readFileSync(resolved, "utf8");
  } catch (cause) {
    throw new CollectorConfigError("수집 설정 파일을 읽을 수 없습니다", resolved, { cause });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new CollectorConfigError("수집 설정 파일이 올바른 JSON이 아닙니다", resolved, { cause });
  }

  const result = collectorConfigSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new CollectorConfigError(
      `수집 설정 형식이 올바르지 않습니다\n${details}`,
      resolved,
      { cause: result.error },
    );
  }

  cache.set(resolved, result.data);
  return result.data;
}
