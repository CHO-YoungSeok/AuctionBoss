-- 자동 생성 파일입니다. 직접 수정하지 마세요. (scripts/migrate/export.ts)
-- 테이블 worker_runs, 행 수 3

INSERT INTO `worker_runs` (`id`, `worker`, `started_at`, `finished_at`, `outcome`, `error_kind`, `error_message`, `detail`, `items_changed`, `created_at`) VALUES
(1, 'collector', '2026-09-12 00:00:00.000', '2026-09-12 00:00:09.000', 'success', NULL, NULL, '{"b": 1, "a": {"y": [3, 2], "x": "z"}, "c": "한글 😀"}', 4, '2026-09-12 00:00:00.000'),
(2, 'analyzer', '2026-09-12 01:00:00.000', NULL, 'skipped', 'backoff', 'line1\nline2 \\ \'q\'', NULL, NULL, '2026-09-12 01:00:00.000'),
(4, 'collector', '2026-09-12 01:00:00.000', '2026-09-12 01:00:30.000', 'blocked', 'RobotDetectedError', 'blocked', '{"z":0,"y":[],"x":{}}', 0, '2026-09-12 01:00:00.000');
