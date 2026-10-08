/**
 * 실패 처리 렌더 테스트(switch-web-to-data-port 5.6, spec "백엔드 응답 검증과 실패 처리").
 *
 * Spring 모드에서 화면이 읽는 요청 중 하나만 500·형식이 다른 본문·연결 실패로 돌려주고 나머지는 정상
 * 응답을 줘도, 페이지는 던져야 한다(`DataSourceError`) — 일부만 그리거나 SQLite로 대신 읽지 않는다.
 * 없는 물건 상세는 오류가 아니라 `notFound()`다.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import BookmarksPage from "@/app/bookmarks/page";
import FeedPage from "@/app/feed/page";
import ItemDetailPage from "@/app/items/[id]/page";
import ItemListPage from "@/app/page";
import StatusPage from "@/app/status/page";
import { addBookmark, closeDb, getRepository } from "@/lib/db";
import type { AuctionItemInput } from "@/lib/domain";

import { setDataPortForTesting } from "../index";
import { DataSourceError } from "../port";
import { createSpringPort } from "../spring/port";
import { createNextStandIn } from "./next-stand-in";

let workDir: string;
let originalDbEnv: string | undefined;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "auctionboss-failure-render-"));
  originalDbEnv = process.env.AUCTIONBOSS_DB;
  process.env.AUCTIONBOSS_DB = path.join(workDir, "test.db");
  closeDb();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const repo = getRepository();
  const item: AuctionItemInput = {
    court: "서울중앙지방법원",
    caseNo: "2025타경1",
    itemNo: "1",
    address: "서울특별시 관악구 신림동 1-1",
    usageType: "아파트",
    appraisalPrice: 500_000_000,
    minBidPrice: 400_000_000,
    auctionDate: "2026-10-01",
    failedBidCount: 1,
    status: "진행",
  };
  repo.upsertItems([item], { now: "2026-01-01T00:00:00.000Z" });
  addBookmark(1, { now: "2026-01-02T00:00:00.000Z" });
});

afterEach(() => {
  vi.restoreAllMocks();
  setDataPortForTesting(null);
  closeDb();
  if (originalDbEnv === undefined) delete process.env.AUCTIONBOSS_DB;
  else process.env.AUCTIONBOSS_DB = originalDbEnv;
  rmSync(workDir, { recursive: true, force: true });
});

type FailureMode = "500" | "형식이 다른 본문" | "연결 실패";

/** `failPath`로 가는 요청만 실패시키고 나머지는 Next 대역이 정상 응답한다. */
function installFailing(failPath: string, mode: FailureMode): void {
  const standIn = createNextStandIn();
  const failing = (async (input: URL, init?: RequestInit) => {
    if (new URL(String(input)).pathname !== failPath) return standIn.fetch(input, init);
    if (mode === "500") return Response.json({ error: "boom" }, { status: 500 });
    if (mode === "형식이 다른 본문") return Response.json({ unexpected: true });
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  setDataPortForTesting(createSpringPort({ baseUrl: "http://spring.test:8080", fetch: failing }));
}

const SCREENS: { name: string; failPath: string; render: () => Promise<unknown> }[] = [
  { name: "목록", failPath: "/api/items/filter-options", render: () => ItemListPage({ searchParams: Promise.resolve({}) }) },
  { name: "상세", failPath: "/api/items/1/analyses", render: () => ItemDetailPage({ params: Promise.resolve({ id: "1" }) }) },
  { name: "관심 물건", failPath: "/api/bookmarks", render: () => BookmarksPage({ searchParams: Promise.resolve({}) }) },
  { name: "피드", failPath: "/api/feed", render: () => FeedPage({ searchParams: Promise.resolve({}) }) },
  { name: "상태", failPath: "/api/collector-state/rotation", render: () => StatusPage() },
];

describe("spring 모드 실패 처리", () => {
  it("정상 응답이면 다섯 화면이 모두 그려진다(대조군)", async () => {
    setDataPortForTesting(
      createSpringPort({ baseUrl: "http://spring.test:8080", fetch: createNextStandIn().fetch }),
    );
    for (const screen of SCREENS) await expect(screen.render(), screen.name).resolves.toBeDefined();
  });

  const cases = SCREENS.flatMap((screen) =>
    (["500", "형식이 다른 본문", "연결 실패"] as const).map((mode) => [screen.name, mode, screen] as const),
  );

  it.each(cases)("%s: %s이면 부분 렌더 없이 DataSourceError로 끝난다", async (_name, mode, screen) => {
    installFailing(screen.failPath, mode);
    await expect(screen.render()).rejects.toBeInstanceOf(DataSourceError);
  });

  it("없는 물건 상세는 오류가 아니라 notFound()다", async () => {
    setDataPortForTesting(
      createSpringPort({ baseUrl: "http://spring.test:8080", fetch: createNextStandIn().fetch }),
    );
    await expect(ItemDetailPage({ params: Promise.resolve({ id: "999999" }) })).rejects.toThrow(
      /NEXT_HTTP_ERROR_FALLBACK|NEXT_NOT_FOUND/,
    );
  });
});
