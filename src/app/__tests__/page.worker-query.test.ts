/**
 * 목록 화면이 포트의 `listItems`에 넘기는 조건에는 분석 워커 전용 필드가 없다(switch-web-to-data-port 4장
 * 결정). 두 원천(SQLite·Spring)이 같은 조건으로 같은 목록을 돌려주게 하려는 것이다.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb } from "@/lib/db";
import { setDataPortForTesting } from "@/lib/data-port";
import { createTestPort } from "@/lib/data-port/__tests__/data-sources";
import type { ItemQuery } from "@/lib/domain";

import ItemListPage from "../page";

let workDir: string;
let originalDbEnv: string | undefined;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "auctionboss-worker-query-"));
  originalDbEnv = process.env.AUCTIONBOSS_DB;
  process.env.AUCTIONBOSS_DB = path.join(workDir, "test.db");
  closeDb();
});

afterEach(() => {
  setDataPortForTesting(null);
  closeDb();
  if (originalDbEnv === undefined) delete process.env.AUCTIONBOSS_DB;
  else process.env.AUCTIONBOSS_DB = originalDbEnv;
  rmSync(workDir, { recursive: true, force: true });
});

describe("목록 화면의 워커 전용 쿼리", () => {
  it("needsAnalysis·promptVersion이 URL에 와도 listItems 조건에는 실리지 않는다", async () => {
    const received: ItemQuery[] = [];
    const base = createTestPort("sqlite").port;
    setDataPortForTesting({
      ...base,
      listItems: (query) => {
        received.push(query);
        return base.listItems(query);
      },
    });

    await ItemListPage({
      searchParams: Promise.resolve({ needsAnalysis: "true", promptVersion: "v1", sort: "minBidPrice" }),
    });

    expect(received.length).toBeGreaterThanOrEqual(3);
    for (const query of received) {
      expect(query).not.toHaveProperty("needsAnalysis");
      expect(query).not.toHaveProperty("promptVersion");
      expect(query).not.toHaveProperty("reanalysisCooldownHours");
    }
    expect(received[0].sort).toBe("minBidPrice");
  });
});
