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
  -- ↓ 확장 컬럼 (enrich-item-fields, design.md D1). 전부 nullable — 기존 행은 NULL로
  -- 남고 다음 수집 때 채워진다(이 change의 마이그레이션은 값을 소급하지 않는다).
  -- 새 DB는 여기서 만들어지고, 기존 DB 파일은 client.ts의
  -- migrateItemExtendedFieldsColumns가 ALTER TABLE로 같은 컬럼을 추가한다.
  min_area                  INTEGER,
  max_area                  INTEGER,
  building_description      TEXT,
  min_bid_price_round1      INTEGER,
  min_bid_price_round2      INTEGER,
  min_bid_price_round3      INTEGER,
  min_bid_price_round4      INTEGER,
  min_bid_price_rate_round1 INTEGER,
  min_bid_price_rate_round2 INTEGER,
  usage_code_large          TEXT,
  usage_code_medium         TEXT,
  usage_code_small          TEXT,
  sido                      TEXT,
  sigungu                   TEXT,
  dong                      TEXT,
  lot_number                TEXT,
  building_name             TEXT,
  building_unit             TEXT,
  coordinate_x              TEXT,
  coordinate_y              TEXT,
  coordinate_level          TEXT,
  auction_time              TEXT,
  auction_place             TEXT,
  auction_decision_date     TEXT,
  auction_round             INTEGER,
  note                      TEXT,
  duplicate_case_no         TEXT,
  merged_case_no            TEXT,
  court_department          TEXT,
  court_phone               TEXT,
  status_code               TEXT,
  item_status_code          TEXT,
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
--
-- kind ('baseline' | 'change')가 기준점/실제 변경을 구별하는 유일한 마커다. 이전에는
-- old_value IS NULL로 구별했는데, "값이 없던 필드에 값이 생기는" 실제 변경(null→값)도
-- old_value가 NULL이라 기준점과 구별할 수 없었다 — 그 변경이 화면·재분석·목록에서
-- 통째로 사라지는 버그였다(코드 리뷰 finding 1). 새 DB는 이 컬럼을 갖고 시작하고,
-- 이 컬럼이 없던 기존 DB 파일은 client.ts의 마이그레이션이 ALTER TABLE로 추가한다
-- (CREATE ... IF NOT EXISTS는 이미 있는 테이블에 컬럼을 추가해 주지 않는다).
CREATE TABLE IF NOT EXISTS item_changes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  field      TEXT    NOT NULL,
  old_value  TEXT,
  new_value  TEXT,
  changed_at TEXT    NOT NULL,
  kind       TEXT    NOT NULL DEFAULT 'change'
);

-- 물건별 이력 조회(시간순)와 목록의 "최근 변경 시각" 서브쿼리(design.md D6)에 쓰인다.
CREATE INDEX IF NOT EXISTS idx_item_changes_item_id ON item_changes (item_id, changed_at DESC);

-- 수집·분석 워커의 실행 회차 기록 (add-collection-observability design.md D1).
--
-- worker: 'collector' | 'analyzer'. 테이블을 둘로 나누지 않는다 — 상태 화면·조회·집계·
-- 보관 정리 로직이 완전히 동일하고, 나누면 같은 코드를 두 번 쓰게 된다.
-- outcome: 'running' | 'success' | 'failed' | 'blocked' | 'skipped'. 시작 시 'running'
-- 행을 만들고(startRun) 종료 시 같은 행을 갱신한다(finishRun) — 워커가 회차 도중 죽어도
-- 회차의 존재 자체는 남아야 "죽었다"는 사실을 감추지 않는다.
-- error_kind: 오류 클래스 이름(예: RobotDetectedError) 또는 skipped의 사유(overlap/backoff).
-- detail: 워커별로 다른 수치를 담는 JSON 텍스트(표시용). items_changed는 그중 "실제 변경된
-- 물건 수"만 집계용으로 따로 둔 컬럼이다 — JSON 안에 있으면 SQL로 합산할 수 없기 때문이다.
-- 이 둘의 값은 항상 같아야 하고, 그 동기화는 finishRun 한 곳에서만 이뤄진다(design.md 위험).
CREATE TABLE IF NOT EXISTS worker_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  worker        TEXT    NOT NULL,
  started_at    TEXT    NOT NULL,
  finished_at   TEXT,
  outcome       TEXT    NOT NULL,
  error_kind    TEXT,
  error_message TEXT,
  detail        TEXT,
  items_changed INTEGER,
  created_at    TEXT    NOT NULL
);

-- 워커별 최신순 조회(상태 화면·목록 API·보관 정리)에 쓰인다(design.md D1/D6).
CREATE INDEX IF NOT EXISTS idx_worker_runs_worker_started_at ON worker_runs (worker, started_at DESC);
`;
