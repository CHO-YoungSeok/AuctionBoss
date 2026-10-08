/**
 * 사진 워커 단위 테스트 (fix-photo-worker-and-deploy-config 3.6~3.7).
 *
 * `@/lib/db`를 모킹해 실제 DB 없이 회차 기록과 공유 백오프 연동을 검증한다(collector.test.ts와
 * 같은 방식). 소스는 가짜 `AuctionSource`, 저장은 가짜 `PhotoStore`, 시간·sleep도 주입한다 —
 * 외부 사이트에는 절대 요청하지 않는다. 대기 물건 선택 규칙 자체는 repository.test.ts가 검증한다.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

// 공유 백오프 저장소의 메모리 흉내(실제 구현처럼 더 늦은 값으로만 갱신).
const backoffStore = vi.hoisted(() => ({ until: null as Date | null }));

vi.mock("@/lib/db", () => ({
  startRun: vi.fn(),
  finishRun: vi.fn(),
  recordSkippedRun: vi.fn(),
  getBackoffUntil: vi.fn(() => backoffStore.until),
  extendBackoffUntil: vi.fn((until: Date) => {
    if (!backoffStore.until || until.getTime() > backoffStore.until.getTime()) {
      backoffStore.until = until;
    }
  }),
  getRepository: vi.fn(),
  closeDb: vi.fn(),
}));

import { extendBackoffUntil, finishRun, getBackoffUntil, recordSkippedRun, startRun } from "@/lib/db";
import type { AuctionItem, PhotosConfig } from "@/lib/domain";
import {
  ResponseSchemaError,
  RobotDetectedError,
  SourceRequestError,
  WafBlockedError,
  type AuctionSource,
  type Logger,
} from "@/lib/sources";

import { startPhotoWorker, type PhotoStore, type PhotoWorkerOptions } from "../photos";

const startRunMock = vi.mocked(startRun);
const finishRunMock = vi.mocked(finishRun);
const recordSkippedRunMock = vi.mocked(recordSkippedRun);
const getBackoffUntilMock = vi.mocked(getBackoffUntil);
const extendBackoffUntilMock = vi.mocked(extendBackoffUntil);

const NOW = new Date("2026-10-08T12:00:00.000Z");
const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

const CONFIG: PhotosConfig = {
  intervalMs: 999_000_000, // 실제 타이머가 안 도는 값 — tick()을 직접 호출한다
  maxItemsPerRun: 5,
  requestDelayMs: 30_000,
  retryAfterHours: 24,
};

function makeItem(id: number): AuctionItem {
  return {
    id,
    court: "서울중앙지방법원",
    caseNo: `2025타경${id}`,
    itemNo: "1",
    internalCaseNo: `2025013000${id}`,
    courtCode: "B000210",
  } as AuctionItem;
}

const PHOTO = { seq: 1, base64: "R0lGODlh" };

interface FakeStore extends PhotoStore {
  collected: number[];
  marked: Array<{ id: number; status: string }>;
  getPendingItems: Mock<PhotoStore["getPendingItems"]>;
}

function makeStore(items: AuctionItem[]): FakeStore {
  const store: FakeStore = {
    collected: [],
    marked: [],
    getPendingItems: vi.fn<PhotoStore["getPendingItems"]>((limit) => items.slice(0, limit)),
    saveFile: vi.fn((_id: number, seq: number) => ({
      filePath: `x/${seq}.gif`,
      fileSize: 1,
      mimeType: "image/gif",
    })),
    saveCollected: vi.fn((id: number) => {
      store.collected.push(id);
    }),
    markStatus: vi.fn((id: number, status: string) => {
      store.marked.push({ id, status });
    }),
  };
  return store;
}

type Responder = (ref: { courtCode: string; internalCaseNo: string }) => Promise<{
  photos: Array<{ seq: number; base64: string }>;
  requestsMade: number;
}>;

function makeSource(respond: Responder) {
  const fetchItemPhotos = vi.fn(respond);
  const source: AuctionSource = {
    fetchActiveItems: async () => ({ items: [], pagesRequested: 0 }),
    fetchItemPhotos,
  };
  return { source, fetchItemPhotos };
}

const ok = (photos = [PHOTO], requestsMade = 1) => async () => ({ photos, requestsMade });

function setup(
  items: AuctionItem[],
  respond: Responder,
  overrides: Partial<PhotoWorkerOptions> = {},
) {
  const store = makeStore(items);
  const { source, fetchItemPhotos } = makeSource(respond);
  const createSource = vi.fn(() => source);
  const sleep = vi.fn(async () => {});
  const handle = startPhotoWorker({
    createSource,
    config: CONFIG,
    logger: silentLogger,
    store,
    now: () => NOW,
    sleep,
    runImmediately: false,
    ...overrides,
  });
  return { handle, store, fetchItemPhotos, createSource, sleep };
}

function finishedWith() {
  return finishRunMock.mock.calls.at(-1)!;
}

beforeEach(() => {
  vi.clearAllMocks();
  backoffStore.until = null;
  startRunMock.mockReturnValue(7);
});

describe("startPhotoWorker — 회차 결과와 수치", () => {
  it("3건 시도 중 2건 저장·1건 사진 없음이면 success이고 수치가 기록된다", async () => {
    const calls: number[] = [];
    const { handle, store } = setup([makeItem(1), makeItem(2), makeItem(3)], async (ref) => {
      calls.push(calls.length);
      return ref.internalCaseNo.endsWith("3")
        ? { photos: [], requestsMade: 1 }
        : { photos: [PHOTO], requestsMade: calls.length === 1 ? 2 : 1 };
    });
    const result = await handle.tick();
    await handle.stop();

    expect(result).toBe("success");
    expect(startRunMock).toHaveBeenCalledWith("photos");
    expect(finishRunMock).toHaveBeenCalledWith(7, {
      outcome: "success",
      detail: { attempted: 3, collected: 2, empty: 1, failed: 0, requestsMade: 4 },
    });
    expect(store.collected).toEqual([1, 2]);
    expect(store.marked).toEqual([{ id: 3, status: "empty" }]);
  });

  it("일부 물건만 실패하면 회차는 success이고 실패 수치가 남는다", async () => {
    const { handle, store } = setup([makeItem(1), makeItem(2), makeItem(3)], async (ref) => {
      if (ref.internalCaseNo.endsWith("2")) throw new ResponseSchemaError("형식 변경", ["x"]);
      return { photos: [PHOTO], requestsMade: 1 };
    });
    const result = await handle.tick();
    await handle.stop();

    expect(result).toBe("success");
    const [, input] = finishedWith();
    expect(input.outcome).toBe("success");
    expect(input.detail).toMatchObject({ attempted: 3, collected: 2, failed: 1 });
    expect(store.marked).toEqual([{ id: 2, status: "failed" }]);
  });

  it("시도한 물건이 모두 차단이 아닌 오류로 실패하면 failed이고 마지막 오류가 남는다", async () => {
    const { handle } = setup([makeItem(1), makeItem(2)], async () => {
      throw new SourceRequestError("HTTP 500", { url: "u", status: 500 });
    });
    const result = await handle.tick();
    await handle.stop();

    expect(result).toBe("failed");
    expect(finishRunMock).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        outcome: "failed",
        errorKind: "SourceRequestError",
        errorMessage: expect.stringContaining("HTTP 500"),
      }),
    );
    expect(extendBackoffUntilMock).not.toHaveBeenCalled();
  });

  it("대기 물건이 없으면 소스를 만들지도 부르지도 않고 success·0건으로 기록한다", async () => {
    const { handle, createSource, fetchItemPhotos } = setup([], ok());
    const result = await handle.tick();
    await handle.stop();

    expect(result).toBe("success");
    expect(createSource).not.toHaveBeenCalled();
    expect(fetchItemPhotos).not.toHaveBeenCalled();
    expect(finishRunMock).toHaveBeenCalledWith(7, {
      outcome: "success",
      detail: { attempted: 0, collected: 0, empty: 0, failed: 0, requestsMade: 0 },
    });
  });

  it("회차 상한만큼만 요청하고 물건 사이에 requestDelayMs만큼 sleep한다", async () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(makeItem);
    const { handle, fetchItemPhotos, sleep, store } = setup(items, ok(), {
      config: { ...CONFIG, maxItemsPerRun: 3 },
    });
    await handle.tick();
    await handle.stop();

    expect(store.getPendingItems).toHaveBeenCalledWith(3, { now: NOW, retryAfterHours: 24 });
    expect(fetchItemPhotos).toHaveBeenCalledTimes(3);
    // 요청 3번 → 사이 간격 2번(첫 요청 앞에는 두지 않는다)
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 30_000);
    expect(sleep).toHaveBeenNthCalledWith(2, 30_000);
  });

  it("회차마다 새 소스를 만든다", async () => {
    const { handle, createSource } = setup([makeItem(1)], ok());
    await handle.tick();
    await handle.tick();
    await handle.stop();
    expect(createSource).toHaveBeenCalledTimes(2);
  });

  it("식별자가 없는 물건은 요청도 실패 기록도 하지 않는다", async () => {
    const noId = { ...makeItem(1), internalCaseNo: undefined } as unknown as AuctionItem;
    const { handle, fetchItemPhotos, store } = setup([noId], ok());
    await handle.tick();
    await handle.stop();
    expect(fetchItemPhotos).not.toHaveBeenCalled();
    expect(store.marked).toEqual([]);
  });

  it("사진 파일 저장이 throw하면 그 물건만 실패로 기록한다", async () => {
    const { handle, store } = setup([makeItem(1), makeItem(2)], ok());
    store.saveFile = vi.fn((id: number) => {
      if (id === 1) throw new Error("디스크 오류");
      return { filePath: "x", fileSize: 1, mimeType: "image/gif" };
    });
    const result = await handle.tick();
    await handle.stop();
    expect(result).toBe("success");
    expect(store.marked).toEqual([{ id: 1, status: "failed" }]);
    expect(store.collected).toEqual([2]);
  });
});

describe("startPhotoWorker — 차단과 공유 백오프", () => {
  it("두 번째 물건에서 차단되면 blocked로 끝나고 남은 물건은 요청하지 않으며 backoff_until을 기록한다", async () => {
    let n = 0;
    const { handle, fetchItemPhotos, store } = setup(
      [makeItem(1), makeItem(2), makeItem(3)],
      async () => {
        n += 1;
        if (n === 2) throw new RobotDetectedError("차단", null);
        return { photos: [PHOTO], requestsMade: 1 };
      },
      { blockBackoffMs: 60_000 },
    );
    const result = await handle.tick();
    await handle.stop();

    expect(result).toBe("blocked");
    expect(fetchItemPhotos).toHaveBeenCalledTimes(2);
    expect(finishRunMock).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ outcome: "blocked", errorKind: "RobotDetectedError" }),
    );
    expect(extendBackoffUntilMock).toHaveBeenCalledTimes(1);
    expect(extendBackoffUntilMock.mock.calls[0]![0].getTime()).toBe(NOW.getTime() + 60_000);
    // 차단된 물건(2)은 failed로 기록하지 않는다
    expect(store.marked).toEqual([]);
    expect(store.collected).toEqual([1]);
  });

  it("WAF 차단도 같은 방식으로 blocked 처리한다", async () => {
    const { handle } = setup([makeItem(1)], async () => {
      throw new WafBlockedError("waf", "<html>");
    });
    expect(await handle.tick()).toBe("blocked");
    await handle.stop();
    expect(extendBackoffUntilMock).toHaveBeenCalledTimes(1);
  });

  it("일반 오류(메시지에 HTTP가 있어도)는 백오프를 쓰지 않는다", async () => {
    const { handle } = setup([makeItem(1), makeItem(2)], async (ref) => {
      if (ref.internalCaseNo.endsWith("1")) throw new SourceRequestError("HTTP 429", { url: "u" });
      return { photos: [PHOTO], requestsMade: 1 };
    });
    await handle.tick();
    await handle.stop();
    expect(extendBackoffUntilMock).not.toHaveBeenCalled();
    expect(backoffStore.until).toBeNull();
  });

  it("회차 중간에 다른 워커가 백오프를 쓰면 다음 물건부터 멈춘다", async () => {
    let n = 0;
    const { handle, fetchItemPhotos } = setup(
      [makeItem(1), makeItem(2), makeItem(3)],
      async () => {
        n += 1;
        if (n === 1) backoffStore.until = new Date(NOW.getTime() + 60_000); // 수집기가 차단을 기록
        return { photos: [PHOTO], requestsMade: 1 };
      },
    );
    const result = await handle.tick();
    await handle.stop();

    expect(fetchItemPhotos).toHaveBeenCalledTimes(1);
    expect(result).toBe("success"); // 이 워커의 실패가 아니다 — 처리한 물건 기준으로 판정
    expect(finishRunMock).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ detail: expect.objectContaining({ attempted: 1, collected: 1 }) }),
    );
  });

  it("백오프 중에는 소스를 부르지 않고 skipped/backoff로 기록한다", async () => {
    backoffStore.until = new Date(NOW.getTime() + 60_000);
    const { handle, fetchItemPhotos, createSource, store } = setup([makeItem(1)], ok());
    const result = await handle.tick();
    await handle.stop();

    expect(result).toBe("skipped");
    expect(recordSkippedRunMock).toHaveBeenCalledWith("photos", "backoff");
    expect(startRunMock).not.toHaveBeenCalled();
    expect(createSource).not.toHaveBeenCalled();
    expect(fetchItemPhotos).not.toHaveBeenCalled();
    expect(store.getPendingItems).not.toHaveBeenCalled();
  });

  it("옛 사진 워커가 남긴 지난 백오프 값은 무시한다", async () => {
    backoffStore.until = new Date(NOW.getTime() - 1_000);
    const { handle, fetchItemPhotos } = setup([makeItem(1)], ok());
    await handle.tick();
    await handle.stop();
    expect(fetchItemPhotos).toHaveBeenCalledTimes(1);
  });

  it("백오프 조회가 throw해도 로그만 남기고 수집은 진행한다", async () => {
    getBackoffUntilMock.mockImplementation(() => {
      throw new Error("db down");
    });
    const { handle, fetchItemPhotos } = setup([makeItem(1)], ok());
    await handle.tick();
    await handle.stop();
    getBackoffUntilMock.mockImplementation(() => backoffStore.until);
    expect(fetchItemPhotos).toHaveBeenCalledTimes(1);
  });
});

describe("startPhotoWorker — 겹침과 기록 실패", () => {
  it("실행 중에 tick이 또 오면 skipped/overlap으로 기록하고 소스를 다시 부르지 않는다", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { handle, fetchItemPhotos } = setup([makeItem(1)], async () => {
      await gate;
      return { photos: [PHOTO], requestsMade: 1 };
    });
    const first = handle.tick();
    const second = await handle.tick();
    expect(second).toBe("skipped");
    expect(recordSkippedRunMock).toHaveBeenCalledWith("photos", "overlap");
    expect(recordSkippedRunMock).not.toHaveBeenCalledWith("photos", "backoff");

    release();
    expect(await first).toBe("success");
    await handle.stop();
    expect(fetchItemPhotos).toHaveBeenCalledTimes(1);
  });

  it("startRun/finishRun이 던져도 사진 저장은 진행되고 tick은 정상 종료한다", async () => {
    startRunMock.mockImplementation(() => {
      throw new Error("db down");
    });
    finishRunMock.mockImplementation(() => {
      throw new Error("db down");
    });
    const { handle, store } = setup([makeItem(1), makeItem(2)], ok());
    await expect(handle.tick()).resolves.toBe("success");
    await handle.stop();
    expect(store.collected).toEqual([1, 2]);
    finishRunMock.mockReset();
  });

  it("대기 물건 조회가 throw하면 회차를 failed로 기록하고 다음 tick은 정상 시도한다", async () => {
    const { handle, store } = setup([makeItem(1)], ok());
    store.getPendingItems.mockImplementationOnce(() => {
      throw new Error("query failed");
    });
    expect(await handle.tick()).toBe("failed");
    expect(finishRunMock).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ outcome: "failed", errorMessage: "query failed" }),
    );
    expect(await handle.tick()).toBe("success");
    await handle.stop();
  });
});
