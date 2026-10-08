/** `GET /api/collector-state/rotation` HTTP 경계 테스트(switch-web-to-data-port 3.1). */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { COLLECTOR_STATE_KEYS, closeDb, setCollectorState } from "@/lib/db";

import { GET } from "../route";

const originalEnv = process.env.AUCTIONBOSS_DB;
const originalConfig = process.env.AUCTIONBOSS_CONFIG;
let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "auctionboss-route-"));
  process.env.AUCTIONBOSS_DB = path.join(workDir, "test.db");
});

afterEach(() => {
  closeDb();
  if (originalEnv === undefined) delete process.env.AUCTIONBOSS_DB;
  else process.env.AUCTIONBOSS_DB = originalEnv;
  if (originalConfig === undefined) delete process.env.AUCTIONBOSS_CONFIG;
  else process.env.AUCTIONBOSS_CONFIG = originalConfig;
  rmSync(workDir, { recursive: true, force: true });
});

describe("GET /api/collector-state/rotation", () => {
  it("기록이 없으면 nextCourtCode가 null이다", async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ nextCourtCode: null });
  });

  it("기록된 법원 코드만 돌려주고 다른 상태 키는 노출하지 않는다", async () => {
    setCollectorState(COLLECTOR_STATE_KEYS.ROTATION_NEXT_COURT_CODE, "B000211");
    setCollectorState(COLLECTOR_STATE_KEYS.BACKOFF_UNTIL, "2026-10-08T00:00:00.000Z");
    const response = GET();
    expect(await response.json()).toEqual({ nextCourtCode: "B000211" });
  });
});
