/**
 * `collector_state` 키-값 저장소 테스트 (scale-collection-scheduling task 1.3).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { COLLECTOR_STATE_KEYS, createCollectorStateRepository } from "../collector-state";
import { openDatabase, type Db } from "../client";

let db: Db;

beforeEach(() => {
  db = openDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("createCollectorStateRepository", () => {
  it("저장된 적 없는 키는 null을 돌려준다", () => {
    const repo = createCollectorStateRepository(db);
    expect(repo.getCollectorState(COLLECTOR_STATE_KEYS.ROTATION_NEXT_COURT_CODE)).toBeNull();
  });

  it("값을 저장하면 그대로 조회된다", () => {
    const repo = createCollectorStateRepository(db);
    repo.setCollectorState(COLLECTOR_STATE_KEYS.ROTATION_NEXT_COURT_CODE, "B000210");
    expect(repo.getCollectorState(COLLECTOR_STATE_KEYS.ROTATION_NEXT_COURT_CODE)).toBe(
      "B000210",
    );
  });

  it("같은 키에 다시 저장하면 값이 덮어써진다(새 행이 생기지 않는다)", () => {
    const repo = createCollectorStateRepository(db);
    const key = COLLECTOR_STATE_KEYS.ROTATION_NEXT_COURT_CODE;
    repo.setCollectorState(key, "B000210");
    repo.setCollectorState(key, "B000211");
    expect(repo.getCollectorState(key)).toBe("B000211");

    const rows = db.prepare("SELECT COUNT(*) AS n FROM collector_state").get() as {
      n: number;
    };
    expect(rows.n).toBe(1);
  });

  it("updated_at이 저장 시점마다 갱신된다", () => {
    const repo = createCollectorStateRepository(db);
    const key = COLLECTOR_STATE_KEYS.ROTATION_NEXT_COURT_CODE;
    repo.setCollectorState(key, "B000210", { now: "2026-01-01T00:00:00.000Z" });
    repo.setCollectorState(key, "B000211", { now: "2026-01-02T00:00:00.000Z" });

    const row = db
      .prepare<[string], { updated_at: string }>(
        "SELECT updated_at FROM collector_state WHERE key = ?",
      )
      .get(key);
    expect(row?.updated_at).toBe("2026-01-02T00:00:00.000Z");
  });

  it("서로 다른 키는 독립적으로 저장된다", () => {
    const repo = createCollectorStateRepository(db);
    repo.setCollectorState("other-key", "다른 값");
    expect(repo.getCollectorState(COLLECTOR_STATE_KEYS.ROTATION_NEXT_COURT_CODE)).toBeNull();
    expect(repo.getCollectorState("other-key")).toBe("다른 값");
  });
});

describe("차단 백오프 공유 (fix-photo-worker-and-deploy-config D2)", () => {
  it("BACKOFF_UNTIL 키는 옛 사진 워커가 쓰던 이름 backoff_until이다", () => {
    expect(COLLECTOR_STATE_KEYS.BACKOFF_UNTIL).toBe("backoff_until");
  });

  it("값이 없으면 null", () => {
    const repo = createCollectorStateRepository(db);
    expect(repo.getBackoffUntil()).toBeNull();
  });

  it("파싱할 수 없는 값은 null", () => {
    const repo = createCollectorStateRepository(db);
    repo.setCollectorState(COLLECTOR_STATE_KEYS.BACKOFF_UNTIL, "not-a-date");
    expect(repo.getBackoffUntil()).toBeNull();
  });

  it("옛 사진 워커 형식(ISO 문자열) 행을 그대로 읽는다", () => {
    db.prepare(
      "INSERT INTO collector_state (key, value, updated_at) VALUES ('backoff_until', '2026-10-08T12:00:00.000Z', '2026-10-08T11:50:00.000Z')",
    ).run();
    const repo = createCollectorStateRepository(db);
    expect(repo.getBackoffUntil()?.toISOString()).toBe("2026-10-08T12:00:00.000Z");
  });

  it("값이 없을 때 extend하면 기록된다", () => {
    const repo = createCollectorStateRepository(db);
    repo.extendBackoffUntil(new Date("2026-10-08T12:00:00.000Z"));
    expect(repo.getBackoffUntil()?.toISOString()).toBe("2026-10-08T12:00:00.000Z");
  });

  it("더 늦은 값은 덮어쓴다", () => {
    const repo = createCollectorStateRepository(db);
    repo.extendBackoffUntil(new Date("2026-10-08T12:00:00.000Z"));
    repo.extendBackoffUntil(new Date("2026-10-08T14:00:00.000Z"));
    expect(repo.getBackoffUntil()?.toISOString()).toBe("2026-10-08T14:00:00.000Z");
  });

  it("더 이른 값은 무시한다 (2시간 뒤 값 유지)", () => {
    const repo = createCollectorStateRepository(db);
    repo.extendBackoffUntil(new Date("2026-10-08T14:00:00.000Z"));
    repo.extendBackoffUntil(new Date("2026-10-08T12:00:00.000Z"));
    expect(repo.getBackoffUntil()?.toISOString()).toBe("2026-10-08T14:00:00.000Z");
  });

  it("저장된 값이 파싱 불가일 때는 새 값으로 덮어쓴다", () => {
    const repo = createCollectorStateRepository(db);
    repo.setCollectorState(COLLECTOR_STATE_KEYS.BACKOFF_UNTIL, "garbage");
    repo.extendBackoffUntil(new Date("2026-10-08T12:00:00.000Z"));
    expect(repo.getBackoffUntil()?.toISOString()).toBe("2026-10-08T12:00:00.000Z");
  });
});
