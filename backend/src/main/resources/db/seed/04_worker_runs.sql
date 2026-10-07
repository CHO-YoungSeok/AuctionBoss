-- 자동 생성 파일입니다. 직접 수정하지 마세요.
-- 생성 명령: npx tsx scripts/seed/export-seed.ts
-- 원본: data/auctionboss.db, 테이블 worker_runs, 원본 행 수 7
-- 개인 이름은 scripts/seed/masking.ts 규칙으로 가림 처리됨

INSERT INTO `worker_runs` (`id`, `worker`, `started_at`, `finished_at`, `outcome`, `error_kind`, `error_message`, `detail`, `items_changed`, `created_at`) VALUES
(1, 'collector', '2026-09-08 11:47:41.272', '2026-09-08 11:48:38.633', 'success', NULL, NULL, '{"targetCourts":["서울중앙지방법원"],"pagesRequested":12,"itemsFetched":389,"inserted":389,"updated":0,"changed":0}', 0, '2026-09-08 11:47:41.272'),
(2, 'analyzer', '2026-09-08 11:47:49.060', '2026-09-08 11:47:49.080', 'success', NULL, NULL, '{"newCount":0,"reanalysisCount":0,"succeeded":0,"failed":0}', NULL, '2026-09-08 11:47:49.060'),
(3, 'analyzer', '2026-09-08 11:47:56.022', '2026-09-08 11:47:56.037', 'success', NULL, NULL, '{"newCount":0,"reanalysisCount":0,"succeeded":0,"failed":0}', NULL, '2026-09-08 11:47:56.022'),
(4, 'collector', '2026-09-08 11:57:41.263', '2026-09-08 11:58:38.615', 'success', NULL, NULL, '{"targetCourts":["서울중앙지방법원"],"pagesRequested":12,"itemsFetched":389,"inserted":0,"updated":389,"changed":0}', 0, '2026-09-08 11:57:41.263'),
(5, 'analyzer', '2026-09-08 11:57:49.045', '2026-09-08 11:59:11.333', 'success', NULL, NULL, '{"newCount":5,"reanalysisCount":0,"succeeded":5,"failed":0}', NULL, '2026-09-08 11:57:49.045'),
(6, 'collector', '2026-10-01 18:55:52.267', '2026-10-01 18:57:20.931', 'success', NULL, NULL, '{"targetCourts":["서울중앙지방법원"],"pagesRequested":18,"itemsFetched":615,"inserted":420,"updated":195,"changed":195}', 195, '2026-10-01 18:55:52.267'),
(7, 'analyzer', '2026-10-01 18:58:15.467', '2026-10-01 19:00:21.421', 'success', NULL, NULL, '{"newCount":5,"reanalysisCount":2,"succeeded":7,"failed":0}', NULL, '2026-10-01 18:58:15.467');
