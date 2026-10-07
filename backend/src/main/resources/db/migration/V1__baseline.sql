-- AuctionBoss 기준 스키마 (add-spring-mysql-backend design.md D3)
-- SQLite 스키마(src/lib/db/schema.ts + client.ts의 ALTER 보정 4개)를 테이블·컬럼 1:1로 옮긴다.
-- 시각은 DATETIME(3)에 UTC로 저장하고, 금액은 BIGINT로 둔다.

CREATE TABLE items (
  id                        BIGINT       NOT NULL AUTO_INCREMENT,
  court                     VARCHAR(50)  NOT NULL,
  case_no                   VARCHAR(50)  NOT NULL,
  item_no                   VARCHAR(20)  NOT NULL,
  address                   VARCHAR(500),
  usage_type                VARCHAR(100),
  appraisal_price           BIGINT,
  min_bid_price             BIGINT,
  auction_date              DATE,
  failed_bid_count          INT,
  status                    VARCHAR(50),
  first_seen_at             DATETIME(3)  NOT NULL,
  last_seen_at              DATETIME(3)  NOT NULL,
  min_area                  INT,
  max_area                  INT,
  building_description      TEXT,
  min_bid_price_round1      BIGINT,
  min_bid_price_round2      BIGINT,
  min_bid_price_round3      BIGINT,
  min_bid_price_round4      BIGINT,
  min_bid_price_rate_round1 INT,
  min_bid_price_rate_round2 INT,
  usage_code_large          VARCHAR(20),
  usage_code_medium         VARCHAR(20),
  usage_code_small          VARCHAR(20),
  sido                      VARCHAR(50),
  sigungu                   VARCHAR(50),
  dong                      VARCHAR(100),
  lot_number                VARCHAR(100),
  building_name             VARCHAR(200),
  building_unit             VARCHAR(500),
  coordinate_x              VARCHAR(50),
  coordinate_y              VARCHAR(50),
  coordinate_level          VARCHAR(20),
  auction_time              VARCHAR(20),
  auction_place             VARCHAR(200),
  auction_decision_date     DATE,
  auction_round             INT,
  note                      TEXT,
  duplicate_case_no         VARCHAR(500),
  merged_case_no            VARCHAR(500),
  court_department          VARCHAR(100),
  court_phone               VARCHAR(100),
  status_code               VARCHAR(50),
  item_status_code          VARCHAR(50),
  internal_case_no          VARCHAR(50),
  court_code                VARCHAR(20),
  photo_status              VARCHAR(20),
  photo_count               INT,
  photo_collected_at        DATETIME(3),
  PRIMARY KEY (id),
  CONSTRAINT uq_items_court_case_item UNIQUE (court, case_no, item_no),
  CONSTRAINT ck_items_photo_status CHECK (photo_status IS NULL OR photo_status IN ('uncollected', 'collected', 'empty', 'failed'))
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

CREATE INDEX idx_items_auction_date ON items (auction_date);
CREATE INDEX idx_items_usage_type ON items (usage_type);
CREATE INDEX idx_items_min_bid_price ON items (min_bid_price);

CREATE TABLE analyses (
  id             BIGINT      NOT NULL AUTO_INCREMENT,
  item_id        BIGINT      NOT NULL,
  body           TEXT        NOT NULL,
  model          VARCHAR(100),
  prompt_version VARCHAR(20) NOT NULL,
  analyzed_at    DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT fk_analyses_item FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

CREATE INDEX idx_analyses_item_id ON analyses (item_id, analyzed_at DESC);

CREATE TABLE item_changes (
  id         BIGINT      NOT NULL AUTO_INCREMENT,
  item_id    BIGINT      NOT NULL,
  field      VARCHAR(50) NOT NULL,
  old_value  TEXT,
  new_value  TEXT,
  changed_at DATETIME(3) NOT NULL,
  kind       VARCHAR(20) NOT NULL DEFAULT 'change',
  PRIMARY KEY (id),
  CONSTRAINT fk_item_changes_item FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE,
  CONSTRAINT ck_item_changes_kind CHECK (kind IN ('baseline', 'change'))
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

CREATE INDEX idx_item_changes_item_id ON item_changes (item_id, changed_at DESC);

CREATE TABLE worker_runs (
  id            BIGINT      NOT NULL AUTO_INCREMENT,
  worker        VARCHAR(20) NOT NULL,
  started_at    DATETIME(3) NOT NULL,
  finished_at   DATETIME(3),
  outcome       VARCHAR(20) NOT NULL,
  error_kind    VARCHAR(100),
  error_message TEXT,
  detail        JSON,
  items_changed INT,
  created_at    DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT ck_worker_runs_outcome CHECK (outcome IN ('running', 'success', 'failed', 'blocked', 'skipped'))
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

CREATE INDEX idx_worker_runs_worker_started_at ON worker_runs (worker, started_at DESC);

CREATE TABLE bookmarks (
  item_id    BIGINT      NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (item_id),
  CONSTRAINT fk_bookmarks_item FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

CREATE TABLE feed_reads (
  id           INT         NOT NULL,
  last_read_at DATETIME(3),
  PRIMARY KEY (id),
  CONSTRAINT ck_feed_reads_single_row CHECK (id = 1)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

CREATE TABLE collector_state (
  `key`      VARCHAR(100) NOT NULL,
  value      TEXT         NOT NULL,
  updated_at DATETIME(3)  NOT NULL,
  PRIMARY KEY (`key`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

CREATE TABLE item_photos (
  id           BIGINT       NOT NULL AUTO_INCREMENT,
  item_id      BIGINT       NOT NULL,
  seq          INT          NOT NULL,
  file_path    VARCHAR(500) NOT NULL,
  file_size    BIGINT       NOT NULL,
  mime_type    VARCHAR(100) NOT NULL,
  collected_at DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT uq_item_photos_item_seq UNIQUE (item_id, seq),
  CONSTRAINT fk_item_photos_item FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;
