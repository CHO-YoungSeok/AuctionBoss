-- 사진 마지막 시도 시각 (fix-photo-worker-and-deploy-config D4/D5).
-- SQLite의 items.photo_attempted_at과 같은 컬럼. nullable이라 기존 행·시드 적재에 영향이 없다.
ALTER TABLE items ADD COLUMN photo_attempted_at DATETIME(3) NULL;
