/**
 * 목록 화면이 포트의 `listItems`에 넘기는 조건에는 분석 워커 전용 필드가 없다(switch-web-to-data-port 4장
 * 결정). 백엔드가 워커 전용 파라미터를 받는 일이 화면 요청으로는 생기지 않게 하려는 것이다.
 */
import { afterEach, describe, expect, it } from "vitest";

import { setDataPortForTesting } from "@/lib/data-port";
import { FakeBackend } from "@/lib/data-port/__tests__/fake-backend";
import type { ItemQuery } from "@/lib/domain";

import ItemListPage from "../page";

afterEach(() => {
  setDataPortForTesting(null);
});

describe("목록 화면의 워커 전용 쿼리", () => {
  it("needsAnalysis·promptVersion이 URL에 와도 listItems 조건에는 실리지 않는다", async () => {
    const received: ItemQuery[] = [];
    const base = new FakeBackend().port();
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
