/**
 * `bookmarks`/`feed_reads` 저장소 (add-bookmarks-and-feed, design.md D1~D4).
 *
 * items/analyses 저장소(`repository.ts`)·`worker_runs` 저장소(`worker-runs.ts`)와 같은
 * 관례를 따른다: snake_case ↔ camelCase 변환은 이 파일 안에서 끝나고,
 * `createBookmarksRepository(db)`로 연결을 명시해 만들 수 있으며, 모듈 최상단 export
 * 함수들은 기본 싱글턴 연결(`getDb()`)을 쓴다.
 *
 * ⚠️ **단일 사용자 전제(design.md D4).** 이 서비스는 사용자 개념이 없다 — 관심 목록
 * (`bookmarks`)과 읽음 시각(`feed_reads`)은 전역이며 사용자 구분이 없다. 나중에 다중
 * 사용자가 필요해지면 두 테이블에 `user_id`를 추가하고 이 파일의 모든 조회·쓰기에 그
 * 조건을 더해야 한다 — 지금은 그 조건이 아예 없다.
 *
 * 이 파일이 책임지는 design 결정들:
 * - D2: 피드는 새 저장 없이 `item_changes`를 `bookmarks`로 조인해서 만든다. `kind = 'change'`
 *   (기준점 제외)만 읽는다 — 기준점까지 포함하면 물건을 담는 순간 감시 필드 수만큼 가짜
 *   변동이 쏟아진다.
 * - D3: 미확인 개수는 저장하지 않고 매번 `changed_at > last_read_at`으로 도출한다.
 *   `last_read_at`이 없으면(한 번도 안 읽음) 전체 피드가 미확인이다. 읽음 처리는 `markFeedRead`
 *   호출(명시적 동작)로만 일어난다 — 피드 조회(`listFeed`)는 절대 읽음을 만들지 않는다.
 * - D1: `feed_reads`는 행이 하나뿐인 테이블이다. 고정 id(`FEED_READS_ROW_ID`)에만 upsert해
 *   단일 행을 강제한다(스키마의 `CHECK (id = 1)`이 이중으로 강제한다).
 */
import {
  type AuctionItem,
  type FeedEntry,
  type IsoDateTime,
  type WatchedField,
} from "@/lib/domain";

import { getDb, type Db } from "./client";
import { ItemNotFoundError } from "./errors";
import { createRepository, type AuctionRepository } from "./repository";

interface FeedRow {
  id: number;
  item_id: number;
  address: string | null;
  field: string;
  old_value: string | null;
  new_value: string | null;
  changed_at: string;
  bookmarked_at: string;
}

function toFeedEntry(row: FeedRow): FeedEntry {
  return {
    id: row.id,
    itemId: row.item_id,
    itemAddress: row.address,
    field: row.field as WatchedField,
    oldValue: row.old_value,
    newValue: row.new_value,
    changedAt: row.changed_at,
    bookmarkedAt: row.bookmarked_at,
  };
}

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 200;

function normalizePage(page: number | undefined): number {
  if (page === undefined || !Number.isFinite(page)) return DEFAULT_PAGE;
  return Math.max(1, Math.trunc(page));
}

function normalizePageSize(pageSize: number | undefined): number {
  if (pageSize === undefined || !Number.isFinite(pageSize)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(pageSize)));
}

/** `feed_reads`는 행이 하나뿐인 테이블이다(design.md D1) — 이 고정 id에만 upsert한다. */
const FEED_READS_ROW_ID = 1;

export interface ListBookmarkedItemsQuery {
  page?: number;
  pageSize?: number;
}

export interface ListBookmarkedItemsResult {
  items: AuctionItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface FeedQuery {
  page?: number;
  pageSize?: number;
  /**
   * true면 각 물건의 관심 등록 시각(`bookmarkedAt`) 이후의 변동만 포함한다(design.md D2).
   * 생략(기본 false)이면 등록 이전 변동도 포함한다 — 방금 담은 물건의 최근 하락을 못 보면
   * 담은 의미가 없다는 것이 design.md의 명시적 의도다.
   */
  sinceBookmarkedAt?: boolean;
}

export interface ListFeedResult {
  entries: FeedEntry[];
  total: number;
  page: number;
  pageSize: number;
}

export interface BookmarksRepository {
  /** 중복 등록은 조용히 무시한다(오류도, 중복 행도 없음). 없는 물건은 `ItemNotFoundError`. */
  addBookmark(itemId: number, options?: { now?: IsoDateTime }): void;
  /** 담기지 않은 물건을 해제해도 오류가 아니다(idempotent). 없는 물건은 `ItemNotFoundError`. */
  removeBookmark(itemId: number): void;
  isBookmarked(itemId: number): boolean;
  /** 최근 담은 순으로 정렬한다. */
  listBookmarkedItems(query?: ListBookmarkedItemsQuery): ListBookmarkedItemsResult;
  /** `item_changes`를 `bookmarks`로 걸러 최신순으로 읽는다(design.md D2) — 저장하지 않는다. */
  listFeed(query?: FeedQuery): ListFeedResult;
  /** design.md D3 — 저장하지 않고 매번 `item_changes`/`feed_reads`에서 도출한다. */
  getUnreadCount(): number;
  /** design.md D3 — 명시적 동작으로만 호출돼야 한다(피드 조회만으로는 호출되지 않는다). */
  markFeedRead(at?: IsoDateTime): void;
}

export function createBookmarksRepository(db: Db): BookmarksRepository {
  // 관심 물건 목록(items 조회)은 items 저장소를 그대로 재사용한다 — `getItemById`가 이미
  // `bookmarked`/`lastChangedAt` 서브쿼리를 채워 주므로(repository.ts design.md D6) 여기서
  // 물건 컬럼 매핑을 다시 베끼지 않는다(D2가 경계한 "이력과 별도 표현이 어긋나는" 문제와
  // 같은 이유).
  const itemsRepository: AuctionRepository = createRepository(db);

  const selectItemExists = db.prepare<{ id: number }, { id: number }>(
    `SELECT id FROM items WHERE id = @id`,
  );

  const insertBookmark = db.prepare(`
    INSERT INTO bookmarks (item_id, created_at)
    VALUES (@itemId, @createdAt)
    ON CONFLICT (item_id) DO NOTHING
  `);

  const deleteBookmark = db.prepare(`DELETE FROM bookmarks WHERE item_id = @itemId`);

  const selectIsBookmarked = db.prepare<{ itemId: number }, { one: number }>(`
    SELECT 1 AS one FROM bookmarks WHERE item_id = @itemId
  `);

  const countBookmarks = db.prepare<[], { count: number }>(
    `SELECT COUNT(*) AS count FROM bookmarks`,
  );

  const selectBookmarkedItemIdsPage = db.prepare<
    { limit: number; offset: number },
    { item_id: number }
  >(`
    SELECT item_id FROM bookmarks ORDER BY created_at DESC, item_id DESC LIMIT @limit OFFSET @offset
  `);

  const selectLastReadAt = db.prepare<[], { last_read_at: string | null }>(
    `SELECT last_read_at FROM feed_reads WHERE id = ${FEED_READS_ROW_ID}`,
  );

  const countUnread = db.prepare<{ lastReadAt: string | null }, { count: number }>(`
    SELECT COUNT(*) AS count
    FROM item_changes
    JOIN bookmarks ON bookmarks.item_id = item_changes.item_id
    WHERE item_changes.kind = 'change'
      AND (@lastReadAt IS NULL OR item_changes.changed_at > @lastReadAt)
  `);

  const upsertFeedRead = db.prepare(`
    INSERT INTO feed_reads (id, last_read_at) VALUES (${FEED_READS_ROW_ID}, @lastReadAt)
    ON CONFLICT (id) DO UPDATE SET last_read_at = excluded.last_read_at
  `);

  /**
   * 피드 WHERE절. `kind = 'change'`가 핵심이다(design.md D2/D3 — 기준점 제외). 필터 조합이
   * `sinceBookmarkedAt` 하나뿐이라 `repository.ts`의 `buildFilter`처럼 바인딩 파라미터로
   * 빼지 않고 정적 문자열 분기로 충분하다(사용자 입력이 SQL에 섞이지 않는다 — 불리언만
   * 받는다).
   */
  function feedWhere(sinceBookmarkedAt: boolean): string {
    return `WHERE item_changes.kind = 'change'${
      sinceBookmarkedAt ? " AND item_changes.changed_at > bookmarks.created_at" : ""
    }`;
  }

  return {
    addBookmark(itemId, options) {
      if (!selectItemExists.get({ id: itemId })) throw new ItemNotFoundError(itemId);
      const now = options?.now ?? new Date().toISOString();
      // ON CONFLICT DO NOTHING — 이미 담긴 물건을 다시 담아도 created_at(최초 등록 시각)이
      // 덮어써지지 않고, 오류도 나지 않는다(spec: 중복 등록).
      insertBookmark.run({ itemId, createdAt: now });
    },

    removeBookmark(itemId) {
      if (!selectItemExists.get({ id: itemId })) throw new ItemNotFoundError(itemId);
      // 애초에 담기지 않은 물건이어도 DELETE는 0행에 영향을 주고 조용히 끝난다(idempotent).
      deleteBookmark.run({ itemId });
    },

    isBookmarked(itemId) {
      return selectIsBookmarked.get({ itemId }) !== undefined;
    },

    listBookmarkedItems(query = {}) {
      const page = normalizePage(query.page);
      const pageSize = normalizePageSize(query.pageSize);
      const total = countBookmarks.get()?.count ?? 0;
      const idRows = selectBookmarkedItemIdsPage.all({
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      // FK CASCADE라 사실상 항상 존재하지만, 방어적으로 null을 걸러낸다.
      const items = idRows
        .map((row) => itemsRepository.getItemById(row.item_id))
        .filter((item): item is AuctionItem => item !== null);
      return { items, total, page, pageSize };
    },

    listFeed(query = {}) {
      const page = normalizePage(query.page);
      const pageSize = normalizePageSize(query.pageSize);
      const sinceBookmarkedAt = query.sinceBookmarkedAt ?? false;
      const where = feedWhere(sinceBookmarkedAt);

      // 필터 조합(sinceBookmarkedAt 유무)마다 SQL이 달라 그때그때 준비한다 — repository.ts의
      // listItems와 같은 이유(이 규모에서 db.prepare 자체의 비용은 무시할 만하다).
      const total =
        db
          .prepare<[], { total: number }>(
            `SELECT COUNT(*) AS total
             FROM item_changes
             JOIN bookmarks ON bookmarks.item_id = item_changes.item_id
             ${where}`,
          )
          .get()?.total ?? 0;

      const rows = db
        .prepare<{ limit: number; offset: number }, FeedRow>(
          `SELECT item_changes.id AS id,
                  item_changes.item_id AS item_id,
                  items.address AS address,
                  item_changes.field AS field,
                  item_changes.old_value AS old_value,
                  item_changes.new_value AS new_value,
                  item_changes.changed_at AS changed_at,
                  bookmarks.created_at AS bookmarked_at
           FROM item_changes
           JOIN bookmarks ON bookmarks.item_id = item_changes.item_id
           JOIN items ON items.id = item_changes.item_id
           ${where}
           ORDER BY item_changes.changed_at DESC, item_changes.id DESC
           LIMIT @limit OFFSET @offset`,
        )
        .all({ limit: pageSize, offset: (page - 1) * pageSize });

      return { entries: rows.map(toFeedEntry), total, page, pageSize };
    },

    getUnreadCount() {
      const lastReadAt = selectLastReadAt.get()?.last_read_at ?? null;
      return countUnread.get({ lastReadAt })?.count ?? 0;
    },

    markFeedRead(at) {
      const lastReadAt = at ?? new Date().toISOString();
      upsertFeedRead.run({ lastReadAt });
    },
  };
}

let defaultBookmarksRepository: BookmarksRepository | undefined;
let defaultBookmarksRepositoryDb: Db | undefined;

/** 기본 싱글턴 연결에 붙은 저장소. */
export function getBookmarksRepository(): BookmarksRepository {
  const db = getDb();
  if (!defaultBookmarksRepository || defaultBookmarksRepositoryDb !== db) {
    defaultBookmarksRepository = createBookmarksRepository(db);
    defaultBookmarksRepositoryDb = db;
  }
  return defaultBookmarksRepository;
}

export function addBookmark(itemId: number, options?: { now?: IsoDateTime }): void {
  return getBookmarksRepository().addBookmark(itemId, options);
}

export function removeBookmark(itemId: number): void {
  return getBookmarksRepository().removeBookmark(itemId);
}

export function isBookmarked(itemId: number): boolean {
  return getBookmarksRepository().isBookmarked(itemId);
}

export function listBookmarkedItems(
  query?: ListBookmarkedItemsQuery,
): ListBookmarkedItemsResult {
  return getBookmarksRepository().listBookmarkedItems(query);
}

export function listFeed(query?: FeedQuery): ListFeedResult {
  return getBookmarksRepository().listFeed(query);
}

export function getUnreadCount(): number {
  return getBookmarksRepository().getUnreadCount();
}

export function markFeedRead(at?: IsoDateTime): void {
  return getBookmarksRepository().markFeedRead(at);
}
