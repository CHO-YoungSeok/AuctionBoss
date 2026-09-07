/**
 * items / analyses 저장소.
 *
 * snake_case ↔ camelCase 변환은 전부 이 파일 안에서 끝난다. 이 모듈 밖으로 나가는 값은
 * 항상 `src/lib/domain`의 도메인 타입이다.
 *
 * `createRepository(db)`로 연결을 명시해 만들 수 있고, 모듈 최상단 export 함수들은
 * 기본 싱글턴 연결(`getDb()`)을 쓴다. 테스트는 전자를 써서 env·실제 data/ 디렉터리에
 * 의존하지 않는다.
 */
import type {
  Analysis,
  AnalysisInput,
  AuctionItem,
  AuctionItemInput,
  IsoDateTime,
} from "@/lib/domain";

import { getDb, type Db } from "./client";
import { ItemNotFoundError } from "./errors";

export interface UpsertItemsResult {
  inserted: number;
  updated: number;
}

export interface ListItemsOptions {
  /** 1부터 시작. 기본 1. */
  page?: number;
  /** 기본 20, 최대 200. */
  pageSize?: number;
  /** `false`=분석 결과가 없는 물건만, `true`=있는 물건만, 생략=전체 */
  analyzed?: boolean;
}

export interface ListItemsResult {
  items: AuctionItem[];
  total: number;
  page: number;
  pageSize: number;
}

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 200;

interface ItemRow {
  id: number;
  court: string;
  case_no: string;
  item_no: string;
  address: string | null;
  usage_type: string | null;
  appraisal_price: number | null;
  min_bid_price: number | null;
  auction_date: string | null;
  failed_bid_count: number | null;
  status: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

interface AnalysisRow {
  id: number;
  item_id: number;
  body: string;
  model: string | null;
  prompt_version: string;
  analyzed_at: string;
}

function toAuctionItem(row: ItemRow): AuctionItem {
  return {
    id: row.id,
    court: row.court,
    caseNo: row.case_no,
    itemNo: row.item_no,
    address: row.address,
    usageType: row.usage_type,
    appraisalPrice: row.appraisal_price,
    minBidPrice: row.min_bid_price,
    auctionDate: row.auction_date,
    failedBidCount: row.failed_bid_count,
    status: row.status,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

function toAnalysis(row: AnalysisRow): Analysis {
  return {
    id: row.id,
    itemId: row.item_id,
    body: row.body,
    model: row.model,
    promptVersion: row.prompt_version,
    analyzedAt: row.analyzed_at,
  };
}

/** 매각기일 오름차순, 값이 없는 물건은 뒤로. 동률은 id로 안정 정렬. */
const ORDER_BY = "ORDER BY items.auction_date IS NULL, items.auction_date ASC, items.id ASC";

const ANALYZED_EXISTS = "EXISTS (SELECT 1 FROM analyses WHERE analyses.item_id = items.id)";

function whereForAnalyzed(analyzed: boolean | undefined): string {
  if (analyzed === undefined) return "";
  return analyzed ? `WHERE ${ANALYZED_EXISTS}` : `WHERE NOT ${ANALYZED_EXISTS}`;
}

function normalizePage(page: number | undefined): number {
  if (page === undefined || !Number.isFinite(page)) return 1;
  return Math.max(1, Math.trunc(page));
}

function normalizePageSize(pageSize: number | undefined): number {
  if (pageSize === undefined || !Number.isFinite(pageSize)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(pageSize)));
}

export interface AuctionRepository {
  upsertItems(items: AuctionItemInput[], options?: { now?: IsoDateTime }): UpsertItemsResult;
  listItems(options?: ListItemsOptions): ListItemsResult;
  getItemById(id: number): AuctionItem | null;
  insertAnalysis(input: AnalysisInput, options?: { now?: IsoDateTime }): Analysis;
  getLatestAnalysis(itemId: number): Analysis | null;
}

export function createRepository(db: Db): AuctionRepository {
  const selectItemIdByKey = db.prepare<
    { court: string; caseNo: string; itemNo: string },
    { id: number }
  >(`SELECT id FROM items WHERE court = @court AND case_no = @caseNo AND item_no = @itemNo`);

  // 자연 키 충돌 시 갱신 대상은 "소스에서 다시 온 값"과 last_seen_at 뿐이다.
  // first_seen_at은 SET 목록에 없으므로 어떤 경우에도 덮어써지지 않는다.
  const upsertItem = db.prepare(`
    INSERT INTO items (
      court, case_no, item_no, address, usage_type, appraisal_price,
      min_bid_price, auction_date, failed_bid_count, status,
      first_seen_at, last_seen_at
    ) VALUES (
      @court, @caseNo, @itemNo, @address, @usageType, @appraisalPrice,
      @minBidPrice, @auctionDate, @failedBidCount, @status,
      @now, @now
    )
    ON CONFLICT (court, case_no, item_no) DO UPDATE SET
      address          = excluded.address,
      usage_type       = excluded.usage_type,
      appraisal_price  = excluded.appraisal_price,
      min_bid_price    = excluded.min_bid_price,
      auction_date     = excluded.auction_date,
      failed_bid_count = excluded.failed_bid_count,
      status           = excluded.status,
      last_seen_at     = excluded.last_seen_at
  `);

  const selectItemById = db.prepare<{ id: number }, ItemRow>(
    `SELECT * FROM items WHERE id = @id`,
  );

  const insertAnalysisStmt = db.prepare(`
    INSERT INTO analyses (item_id, body, model, prompt_version, analyzed_at)
    VALUES (@itemId, @body, @model, @promptVersion, @analyzedAt)
  `);

  const selectAnalysisById = db.prepare<{ id: number }, AnalysisRow>(
    `SELECT * FROM analyses WHERE id = @id`,
  );

  const selectLatestAnalysis = db.prepare<{ itemId: number }, AnalysisRow>(`
    SELECT * FROM analyses
    WHERE item_id = @itemId
    ORDER BY analyzed_at DESC, id DESC
    LIMIT 1
  `);

  // analyzed 필터 세 갈래(전체 / 분석됨 / 미분석)를 미리 준비해 둔다.
  const listStatements = new Map(
    ([undefined, true, false] as const).map((analyzed) => {
      const where = whereForAnalyzed(analyzed);
      return [
        String(analyzed),
        {
          count: db.prepare<[], { total: number }>(
            `SELECT COUNT(*) AS total FROM items ${where}`,
          ),
          select: db.prepare<{ limit: number; offset: number }, ItemRow>(
            `SELECT * FROM items ${where} ${ORDER_BY} LIMIT @limit OFFSET @offset`,
          ),
        },
      ] as const;
    }),
  );

  const upsertBatch = db.transaction(
    (items: AuctionItemInput[], now: string): UpsertItemsResult => {
      let inserted = 0;
      let updated = 0;
      for (const item of items) {
        // 먼저 존재 여부를 본다. ON CONFLICT는 신규/갱신 모두 changes=1이라
        // 그것만으로는 구분할 수 없고, 같은 배치 안의 중복 키도 정확히 세야 한다.
        const existing = selectItemIdByKey.get({
          court: item.court,
          caseNo: item.caseNo,
          itemNo: item.itemNo,
        });
        upsertItem.run({
          court: item.court,
          caseNo: item.caseNo,
          itemNo: item.itemNo,
          address: item.address,
          usageType: item.usageType,
          appraisalPrice: item.appraisalPrice,
          minBidPrice: item.minBidPrice,
          auctionDate: item.auctionDate,
          failedBidCount: item.failedBidCount,
          status: item.status,
          now,
        });
        if (existing) updated += 1;
        else inserted += 1;
      }
      return { inserted, updated };
    },
  );

  return {
    upsertItems(items, options) {
      if (items.length === 0) return { inserted: 0, updated: 0 };
      return upsertBatch(items, options?.now ?? new Date().toISOString());
    },

    listItems(options = {}) {
      const page = normalizePage(options.page);
      const pageSize = normalizePageSize(options.pageSize);
      const statements = listStatements.get(String(options.analyzed));
      if (!statements) throw new Error(`지원하지 않는 analyzed 값: ${String(options.analyzed)}`);

      const total = statements.count.get()?.total ?? 0;
      const rows = statements.select.all({
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });

      return { items: rows.map(toAuctionItem), total, page, pageSize };
    },

    getItemById(id) {
      const row = selectItemById.get({ id });
      return row ? toAuctionItem(row) : null;
    },

    insertAnalysis(input, options) {
      const analyzedAt = options?.now ?? new Date().toISOString();
      // FK 위반 오류는 원인을 구분하기 어려우므로 먼저 명시적으로 확인해
      // API 계층이 404로 옮길 수 있는 오류를 던진다.
      if (!selectItemById.get({ id: input.itemId })) {
        throw new ItemNotFoundError(input.itemId);
      }
      const info = insertAnalysisStmt.run({
        itemId: input.itemId,
        body: input.body,
        model: input.model,
        promptVersion: input.promptVersion,
        analyzedAt,
      });
      const row = selectAnalysisById.get({ id: Number(info.lastInsertRowid) });
      if (!row) throw new Error("분석 결과 저장 직후 조회에 실패했습니다");
      return toAnalysis(row);
    },

    getLatestAnalysis(itemId) {
      const row = selectLatestAnalysis.get({ itemId });
      return row ? toAnalysis(row) : null;
    },
  };
}

let defaultRepository: AuctionRepository | undefined;
let defaultRepositoryDb: Db | undefined;

/** 기본 싱글턴 연결에 붙은 저장소. */
export function getRepository(): AuctionRepository {
  const db = getDb();
  if (!defaultRepository || defaultRepositoryDb !== db) {
    defaultRepository = createRepository(db);
    defaultRepositoryDb = db;
  }
  return defaultRepository;
}

export function upsertItems(
  items: AuctionItemInput[],
  options?: { now?: IsoDateTime },
): UpsertItemsResult {
  return getRepository().upsertItems(items, options);
}

export function listItems(options?: ListItemsOptions): ListItemsResult {
  return getRepository().listItems(options);
}

export function getItemById(id: number): AuctionItem | null {
  return getRepository().getItemById(id);
}

export function insertAnalysis(
  input: AnalysisInput,
  options?: { now?: IsoDateTime },
): Analysis {
  return getRepository().insertAnalysis(input, options);
}

export function getLatestAnalysis(itemId: number): Analysis | null {
  return getRepository().getLatestAnalysis(itemId);
}
