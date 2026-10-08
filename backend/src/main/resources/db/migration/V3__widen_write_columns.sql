-- 쓰기 API(add-spring-write-api)가 Next(SQLite, 길이 제한 없는 TEXT)와 같은 입력을 받도록 컬럼을 넓힌다.
-- 기존 행·제약은 그대로이고 길이만 늘어난다(축소가 아니므로 데이터 손실이 없다).
ALTER TABLE analyses
  MODIFY COLUMN body           MEDIUMTEXT   NOT NULL,
  MODIFY COLUMN model          VARCHAR(255) NULL,
  MODIFY COLUMN prompt_version VARCHAR(255) NOT NULL;
