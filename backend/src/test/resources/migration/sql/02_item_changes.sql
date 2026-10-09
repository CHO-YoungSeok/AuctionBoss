-- 자동 생성 파일입니다. 직접 수정하지 마세요. (scripts/migrate/export.ts)
-- 테이블 item_changes, 행 수 3

INSERT INTO `item_changes` (`id`, `item_id`, `field`, `old_value`, `new_value`, `changed_at`, `kind`) VALUES
(2, 3, 'minBidPrice', NULL, '98765432109', '2026-09-08 11:48:38.617', 'baseline'),
(5, 3, 'status', '신건', '유찰 1회', '2026-09-09 11:00:00.000', 'change'),
(9, 7, 'status', NULL, 'x ', '2026-09-10 00:00:00.000', 'change');
