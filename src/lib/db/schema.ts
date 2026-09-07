/**
 * DB 스키마 (design.md D2).
 *
 * 마이그레이션 도구 없이 `CREATE TABLE IF NOT EXISTS`만 쓴다 — 테이블 2개 규모에서
 * 마이그레이션 프레임워크는 비용이 더 크다. 스키마가 바뀌는 시점에 다시 판단한다.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  court             TEXT    NOT NULL,
  case_no           TEXT    NOT NULL,
  item_no           TEXT    NOT NULL,
  address           TEXT,
  usage_type        TEXT,
  appraisal_price   INTEGER,
  min_bid_price     INTEGER,
  auction_date      TEXT,
  failed_bid_count  INTEGER,
  status            TEXT,
  first_seen_at     TEXT    NOT NULL,
  last_seen_at      TEXT    NOT NULL,
  UNIQUE (court, case_no, item_no)
);

-- 목록 기본 정렬(매각기일 오름차순)용. NULL을 뒤로 보내는 정렬식과 같은 선두 컬럼.
CREATE INDEX IF NOT EXISTS idx_items_auction_date ON items (auction_date);

CREATE TABLE IF NOT EXISTS analyses (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id        INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  body           TEXT    NOT NULL,
  model          TEXT,
  prompt_version TEXT    NOT NULL,
  analyzed_at    TEXT    NOT NULL
);

-- 미분석 필터(EXISTS 서브쿼리)와 최신 분석 조회에 모두 쓰인다.
CREATE INDEX IF NOT EXISTS idx_analyses_item_id ON analyses (item_id, analyzed_at DESC);
`;
