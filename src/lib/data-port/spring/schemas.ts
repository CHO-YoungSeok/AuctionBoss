/**
 * Spring 응답 zod 스키마(switch-web-to-data-port D3, 4.1).
 *
 * `z.object`라 모르는 키는 버린다. 각 스키마의 `z.infer`가 도메인 타입과 컴파일 시점에 같다는 것을
 * 아래 타입 단언으로 고정한다 — 도메인 타입에 필드가 늘거나 줄면 `tsc`가 실패하고, 값 형식이
 * 다르면 런타임 검증이, 값 자체가 다르면 계약 테스트가 잡는다.
 */
import { z } from "zod";

import {
  PHOTO_STATUSES,
  RUN_OUTCOMES,
  WATCHED_FIELDS,
  WORKER_KINDS,
  WORKER_STATUS_STATES,
  type Analysis,
  type AuctionItem,
  type FeedEntry,
  type ItemChange,
  type WorkerRun,
  type WorkerStatus,
} from "@/lib/domain";

import type {
  AnalysisHistory,
  FeedListResult,
  FilterOptions,
  ItemListResult,
  ItemPhotoMeta,
  RunsSummaryResult,
  WorkerRunListResult,
} from "../port";

const str = z.string();
const nullableStr = z.string().nullable();
const num = z.number();
const nullableNum = z.number().nullable();
const optNullableStr = z.string().nullable().optional();
const optNullableNum = z.number().nullable().optional();

export const auctionItemSchema = z.object({
  // 핵심 필드
  court: str,
  caseNo: str,
  itemNo: str,
  address: nullableStr,
  usageType: nullableStr,
  appraisalPrice: nullableNum,
  minBidPrice: nullableNum,
  auctionDate: nullableStr,
  failedBidCount: nullableNum,
  status: nullableStr,
  // 확장 필드
  minArea: optNullableNum,
  maxArea: optNullableNum,
  buildingDescription: optNullableStr,
  minBidPriceRound1: optNullableNum,
  minBidPriceRound2: optNullableNum,
  minBidPriceRound3: optNullableNum,
  minBidPriceRound4: optNullableNum,
  minBidPriceRateRound1: optNullableNum,
  minBidPriceRateRound2: optNullableNum,
  usageCodeLarge: optNullableStr,
  usageCodeMedium: optNullableStr,
  usageCodeSmall: optNullableStr,
  sido: optNullableStr,
  sigungu: optNullableStr,
  dong: optNullableStr,
  lotNumber: optNullableStr,
  buildingName: optNullableStr,
  buildingUnit: optNullableStr,
  coordinateX: optNullableStr,
  coordinateY: optNullableStr,
  coordinateLevel: optNullableStr,
  auctionTime: optNullableStr,
  auctionPlace: optNullableStr,
  auctionDecisionDate: optNullableStr,
  auctionRound: optNullableNum,
  note: optNullableStr,
  duplicateCaseNo: optNullableStr,
  mergedCaseNo: optNullableStr,
  courtDepartment: optNullableStr,
  courtPhone: optNullableStr,
  statusCode: optNullableStr,
  itemStatusCode: optNullableStr,
  internalCaseNo: optNullableStr,
  courtCode: optNullableStr,
  // 저장된 물건
  id: num,
  firstSeenAt: str,
  lastSeenAt: str,
  lastChangedAt: optNullableStr,
  bookmarked: z.boolean().optional(),
  photoStatus: z.enum(PHOTO_STATUSES).optional(),
  photoCount: num.optional(),
  photoCollectedAt: optNullableStr,
});

export const analysisSchema = z.object({
  itemId: num,
  body: str,
  model: nullableStr,
  promptVersion: str,
  id: num,
  analyzedAt: str,
});

export const itemChangeSchema = z.object({
  id: num,
  itemId: num,
  field: z.enum(WATCHED_FIELDS),
  oldValue: nullableStr,
  newValue: nullableStr,
  changedAt: str,
  kind: z.enum(["baseline", "change"]),
});

export const itemPhotoMetaSchema = z.object({
  id: num,
  itemId: num,
  seq: num,
  fileSize: num,
  mimeType: str,
  collectedAt: str,
});

export const feedEntrySchema = z.object({
  id: num,
  itemId: num,
  itemAddress: nullableStr,
  field: z.enum(WATCHED_FIELDS),
  oldValue: nullableStr,
  newValue: nullableStr,
  changedAt: str,
  bookmarkedAt: str,
});

const workerRunDetailSchema = z.union([
  z.object({
    targetCourts: z.array(str),
    pagesRequested: num,
    itemsFetched: num,
    inserted: num,
    updated: num,
    changed: num,
  }),
  z.object({ newCount: num, reanalysisCount: num, succeeded: num, failed: num }),
  z.object({ attempted: num, collected: num, empty: num, failed: num, requestsMade: num }),
]);

export const workerRunSchema = z.object({
  id: num,
  worker: z.enum(WORKER_KINDS),
  startedAt: str,
  finishedAt: nullableStr,
  outcome: z.enum(RUN_OUTCOMES),
  errorKind: nullableStr,
  errorMessage: nullableStr,
  detail: workerRunDetailSchema.nullable(),
  itemsChanged: nullableNum,
});

export const workerStatusSchema = z.object({
  state: z.enum(WORKER_STATUS_STATES),
  lastSuccessAt: nullableStr,
  lastRun: workerRunSchema.nullable(),
});

// ---- 응답 본문(엔드포인트별) ----

const pageFields = { total: num, page: num, pageSize: num };

/** `GET /api/items`, `GET /api/bookmarks` */
export const itemListResponseSchema = z.object({ items: z.array(auctionItemSchema), ...pageFields });
/** `GET /api/items/{id}` — 최신 분석(`analysis`)은 화면이 쓰지 않아 버린다. */
export const itemDetailResponseSchema = z.object({ item: auctionItemSchema });
export const filterOptionsResponseSchema = z.object({
  usageTypes: z.array(str),
  sidoValues: z.array(str),
  sigunguValues: z.array(str),
  courtValues: z.array(str),
});
export const analysisHistoryResponseSchema = z.object({ analyses: z.array(analysisSchema), total: num });
export const itemChangesResponseSchema = z.object({ changes: z.array(itemChangeSchema) });
export const itemPhotosResponseSchema = z.object({ photos: z.array(itemPhotoMetaSchema) });
/** `GET /api/feed` — 미확인 개수가 함께 온다. */
export const feedResponseSchema = z.object({
  entries: z.array(feedEntrySchema),
  ...pageFields,
  unreadCount: num,
});
export const workerRunListResponseSchema = z.object({ runs: z.array(workerRunSchema), ...pageFields });
export const runsSummaryResponseSchema = z.object({
  totalRuns: num,
  successCount: num,
  failedCount: num,
  blockedCount: num,
  skippedCount: num,
  runningCount: num,
  successRate: nullableNum,
  itemsChanged: num,
});
export const rotationResponseSchema = z.object({ nextCourtCode: nullableStr });
/** `POST /api/bookmarks`(201) */
export const bookmarkAddResponseSchema = z.object({ item: z.object({ id: num }) });
/** `DELETE /api/bookmarks/{id}` */
export const bookmarkRemoveResponseSchema = z.object({ itemId: num, bookmarked: z.literal(false) });
/** `POST /api/feed/read` */
export const feedReadResponseSchema = z.object({ lastReadAt: str, unreadCount: num });

// ---- 도메인 타입과의 일치(컴파일 타임) ----
// 한쪽에만 있는 옵셔널 필드는 서로 대입 가능이라 통과하므로 키 집합도 따로 비교한다.

type Assert<T extends true> = T;
type Matches<Schema, Domain> = [Schema] extends [Domain] ? ([Domain] extends [Schema] ? true : false) : false;
type KeysEqual<A, B> = [keyof A] extends [keyof B] ? ([keyof B] extends [keyof A] ? true : false) : false;
type Same<Schema, Domain> = Matches<Schema, Domain> extends true ? KeysEqual<Schema, Domain> : false;

export type SpringSchemaMatchesDomain = [
  Assert<Same<z.infer<typeof auctionItemSchema>, AuctionItem>>,
  Assert<Same<z.infer<typeof analysisSchema>, Analysis>>,
  Assert<Same<z.infer<typeof itemChangeSchema>, ItemChange>>,
  Assert<Same<z.infer<typeof itemPhotoMetaSchema>, ItemPhotoMeta>>,
  Assert<Same<z.infer<typeof feedEntrySchema>, FeedEntry>>,
  Assert<Same<z.infer<typeof workerRunSchema>, WorkerRun>>,
  Assert<Same<z.infer<typeof workerStatusSchema>, WorkerStatus>>,
  Assert<Same<z.infer<typeof itemListResponseSchema>, ItemListResult>>,
  Assert<Same<z.infer<typeof filterOptionsResponseSchema>, FilterOptions>>,
  Assert<Same<z.infer<typeof analysisHistoryResponseSchema>, AnalysisHistory>>,
  Assert<Same<z.infer<typeof workerRunListResponseSchema>, WorkerRunListResult>>,
  Assert<Same<z.infer<typeof runsSummaryResponseSchema>, RunsSummaryResult>>,
  Assert<Same<Omit<z.infer<typeof feedResponseSchema>, "unreadCount">, FeedListResult>>,
];
