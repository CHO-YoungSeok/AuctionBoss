/**
 * 합성 SQLite 원본 (이전 내보내기 테스트·교차 언어 골든용). 실제 데이터와 무관한 값만 쓴다.
 *
 * 일부러 넣은 모양(D4): 빈 번호 id와 `sqlite_sequence > max(id)`, 1천억 이상 금액, 밀리초 없는 시각과
 * `+09:00` 시각, 키 순서·공백이 다른 JSON, 이모지·뒤쪽 공백·백슬래시·작은따옴표·줄바꿈 문자열, NULL,
 * UTF-16 코드 유닛 순과 UTF-8 바이트 순이 다른 `collector_state` 키, 기록 없는 사진 파일(고아) 1개.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { openDatabase } from "../../../src/lib/db/client";

export const SYNTHETIC_PHOTO_BYTES: Record<string, string> = {
  "7/1.jpg": "synthetic-photo-bytes-7-1",
  "7/2.png": "synthetic-photo-bytes-7-2-longer",
  "1200/1.jpg": "synthetic-photo-bytes-1200-1",
};
export const SYNTHETIC_ORPHAN = "7/9.jpg";

type Row = Record<string, string | number | null>;

function insert(db: ReturnType<typeof openDatabase>, table: string, row: Row): void {
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...Object.values(row));
}

export interface SyntheticSource {
  dbPath: string;
  photosDir: string;
}

export function buildSyntheticSource(dir: string): SyntheticSource {
  mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "source.db");
  const photosDir = path.join(dir, "photos");
  const db = openDatabase(dbPath);
  try {
    const item = (id: number, extra: Row): Row => ({
      id,
      court: `합성법원${id}`,
      case_no: `2099타경${id}`,
      item_no: "1",
      first_seen_at: "2026-09-08T11:48:38.617Z",
      last_seen_at: "2026-09-08T11:48:38Z",
      ...extra,
    });
    insert(db, "items", item(3, { address: "합성시 합성구 1", appraisal_price: 123456789012, min_bid_price: 98765432109, auction_date: "2026-10-13", auction_decision_date: "2026-10-20", failed_bid_count: 2, status: "유찰 2회", min_area: 84, coordinate_x: "127.1", note: "emoji 😀 and trailing space  ", building_name: "C:\\dir\\file 'q'\nline2" }));
    insert(db, "items", item(7, { last_seen_at: "2026-09-08T20:48:38+09:00", photo_status: "collected", photo_count: 2, photo_collected_at: "2026-09-09T01:02:03Z", photo_attempted_at: "2026-09-09T10:02:03+09:00", usage_type: "아파트", building_name: "\u0001ctl\tx \u1100\u1161 NFD" }));
    insert(db, "items", item(1200, { photo_status: "collected", photo_count: 1, address: null, note: "" }));  // 빈 문자열(NULL과 다르다)
    insert(db, "items", item(5000, {})); // 삭제해서 sqlite_sequence만 남긴다
    db.prepare("DELETE FROM items WHERE id = 5000").run();

    insert(db, "item_changes", { id: 2, item_id: 3, field: "minBidPrice", old_value: null, new_value: "98765432109", changed_at: "2026-09-08T11:48:38.617Z", kind: "baseline" });
    insert(db, "item_changes", { id: 5, item_id: 3, field: "status", old_value: "신건", new_value: "유찰 1회", changed_at: "2026-09-09T20:00:00+09:00", kind: "change" });
    insert(db, "item_changes", { id: 9, item_id: 7, field: "status", old_value: null, new_value: "x ", changed_at: "2026-09-10T00:00:00Z", kind: "change" });
    insert(db, "item_changes", { id: 50, item_id: 7, field: "note", old_value: "a", new_value: "b", changed_at: "2026-09-10T00:00:00Z", kind: "change" });
    db.prepare("DELETE FROM item_changes WHERE id = 50").run();

    insert(db, "analyses", { id: 4, item_id: 3, body: "## 합성 분석\n\n본문 😀 \\ ' \" 끝 공백  ", model: "synthetic-model", prompt_version: "v1", analyzed_at: "2026-09-11T03:04:05Z" });
    insert(db, "analyses", { id: 6, item_id: 7, body: "plain", model: null, prompt_version: "v2", analyzed_at: "2026-09-11T12:04:05+09:00" });

    insert(db, "worker_runs", { id: 1, worker: "collector", started_at: "2026-09-12T00:00:00.000Z", finished_at: "2026-09-12T00:00:09Z", outcome: "success", error_kind: null, error_message: null, detail: '{"b": 1, "a": {"y": [3, 2], "x": "z"}, "c": "한글 😀"}', items_changed: 4, created_at: "2026-09-12T00:00:00.000Z" });
    insert(db, "worker_runs", { id: 2, worker: "analyzer", started_at: "2026-09-12T01:00:00Z", finished_at: null, outcome: "skipped", error_kind: "backoff", error_message: "line1\nline2 \\ 'q'", detail: null, items_changed: null, created_at: "2026-09-12T01:00:00Z" });
    insert(db, "worker_runs", { id: 4, worker: "collector", started_at: "2026-09-12T10:00:00+09:00", finished_at: "2026-09-12T10:00:30+09:00", outcome: "blocked", error_kind: "RobotDetectedError", error_message: "blocked", detail: '{"z":0,"y":[],"x":{}}', items_changed: 0, created_at: "2026-09-12T10:00:00+09:00" });

    insert(db, "bookmarks", { item_id: 7, created_at: "2026-09-13T00:00:00Z" });
    insert(db, "feed_reads", { id: 1, last_read_at: "2026-09-13T09:00:00+09:00" });

    for (const [key, value, at] of [
      ["alpha", "1", "2026-09-14T00:00:00.000Z"],
      ["beta", "v ", "2026-09-14T00:00:01Z"],
      ["가나", "한글", "2026-09-14T09:00:02+09:00"],
      ["ｚｚ", "fullwidth", "2026-09-14T00:00:03.5Z"],
      ["😀x", "emoji", "2026-09-14T00:00:04Z"],
    ]) {
      insert(db, "collector_state", { key, value, updated_at: at });
    }

    insert(db, "item_photos", { id: 3, item_id: 7, seq: 1, file_path: "7/1.jpg", file_size: SYNTHETIC_PHOTO_BYTES["7/1.jpg"].length, mime_type: "image/jpeg", collected_at: "2026-09-09T01:02:03Z" });
    insert(db, "item_photos", { id: 4, item_id: 7, seq: 2, file_path: "7/2.png", file_size: SYNTHETIC_PHOTO_BYTES["7/2.png"].length, mime_type: "image/png", collected_at: "2026-09-09T01:02:04Z" });
    insert(db, "item_photos", { id: 10, item_id: 1200, seq: 1, file_path: "1200/1.jpg", file_size: SYNTHETIC_PHOTO_BYTES["1200/1.jpg"].length, mime_type: "image/jpeg", collected_at: "2026-09-09T01:02:05Z" });

    db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
  for (const [rel, content] of Object.entries({ ...SYNTHETIC_PHOTO_BYTES, [SYNTHETIC_ORPHAN]: "orphan-bytes" })) {
    const p = path.join(photosDir, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return { dbPath, photosDir };
}
