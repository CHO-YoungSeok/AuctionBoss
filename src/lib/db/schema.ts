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

-- 용도 필터(usage_type IN (...))와 용도 목록 조회(DISTINCT)용 (design.md D5).
CREATE INDEX IF NOT EXISTS idx_items_usage_type ON items (usage_type);

-- 최저매각가격 범위 필터와 최저가 정렬용 (design.md D5).
-- 감정가 대비 비율(bidRatio)은 계산식이라 인덱스를 만들 수 없다 — 데이터가 수만 건이 되면
-- 생성 열(generated column) + 인덱스를 검토한다.
CREATE INDEX IF NOT EXISTS idx_items_min_bid_price ON items (min_bid_price);

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

-- 감시 대상 필드(field는 도메인 필드명, DB 컬럼명이 아니다) 변경 이력 (design.md D1).
-- old_value가 NULL이면 최초 저장 시의 기준점 행이지 실제 변경이 아니다 (design.md D2).
CREATE TABLE IF NOT EXISTS item_changes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  field      TEXT    NOT NULL,
  old_value  TEXT,
  new_value  TEXT,
  changed_at TEXT    NOT NULL
);

-- 물건별 이력 조회(시간순)와 목록의 "최근 변경 시각" 서브쿼리(design.md D6)에 쓰인다.
CREATE INDEX IF NOT EXISTS idx_item_changes_item_id ON item_changes (item_id, changed_at DESC);
`;
