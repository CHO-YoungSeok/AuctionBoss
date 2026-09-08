/**
 * 수집 워커 단위 테스트 (add-collection-observability 4.1-4.3).
 *
 * `@/lib/db`를 통째로 모킹해서 실제 DB 파일 없이 회차 기록 호출(`startRun`/`finishRun`/
 * `recordSkippedRun`)만 검증한다. 저장(`upsert`)은 `CollectorOptions.upsert`로 주입하므로
 * 실제 저장소가 전혀 필요 없다 — 실제 DB로 구동하는 검증은 group 4 검증 단계(6.2에 해당)에서
 * 스크립트로 별도 확인했다(리포트 참고).
 *
 * 실제 파이프라인(수집→저장, "이전 회차 실행 중이면 건너뛴다" 등)의 규칙 자체는 이
 * 파일이 새로 고정하는 게 아니다 — 여기서는 이 change가 추가한 "회차 기록" 연동만
 * 검증한다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  startRun: vi.fn(),
  finishRun: vi.fn(),
  recordSkippedRun: vi.fn(),
  getCollectorState: vi.fn(() => null),
  setCollectorState: vi.fn(),
  COLLECTOR_STATE_KEYS: { ROTATION_NEXT_COURT_CODE: "collector.rotation.nextCourtCode" },
  getRepository: vi.fn(() => ({
    upsertItems: vi.fn(() => ({ inserted: 0, updated: 0, changed: 0 })),
  })),
  closeDb: vi.fn(),
}));

import {
  finishRun,
  getCollectorState,
  recordSkippedRun,
  setCollectorState,
  startRun,
} from "@/lib/db";
import type { AuctionItemInput, CollectorScopeConfig } from "@/lib/domain";
import {
  ResponseSchemaError,
  RobotDetectedError,
  SourceRequestError,
  WafBlockedError,
  attachPagesRequested,
  type AuctionSource,
  type Logger,
} from "@/lib/sources";

import { startCollector, type CollectorOptions } from "../collector";

const startRunMock = vi.mocked(startRun);
const finishRunMock = vi.mocked(finishRun);
const recordSkippedRunMock = vi.mocked(recordSkippedRun);
const getCollectorStateMock = vi.mocked(getCollectorState);
const setCollectorStateMock = vi.mocked(setCollectorState);

// maxCourtsPerRun/maxRequestsPerRun은 실제 config/collector.json 기본값과 같게 둔다
// (법원 1곳, 상한 1곳) — 이 파일의 테스트는 대부분 "로테이션 도입 전과 동일한 동작"을
// 고정하는 회귀 테스트다(scale-collection-scheduling task 2.4). maxRequestsPerRun은 이
// 파일의 단일 법원 시나리오에서 절대 걸리지 않을 만큼 넉넉하게 둔다.
const scope: CollectorScopeConfig = {
  courts: [{ name: "서울중앙지방법원", courtCode: "B000210" }],
  maxCourtsPerRun: 1,
  maxRequestsPerRun: 999,
};

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function item(itemNo: string): AuctionItemInput {
  return {
    court: "서울중앙지방법원",
    caseNo: "2025타경1",
    itemNo,
    address: "서울특별시 관악구 신림동 1-1",
    usageType: "아파트",
    appraisalPrice: 500_000_000,
    minBidPrice: 400_000_000,
    auctionDate: "2026-10-01",
    failedBidCount: 1,
    status: "진행",
  };
}

function baseOptions(overrides: Partial<CollectorOptions> = {}): CollectorOptions {
  return {
    source: { fetchActiveItems: async () => ({ items: [], pagesRequested: 0 }) },
    scope,
    intervalMs: 999_000_000, // 실제 타이머가 안 도는 값 — tick()을 직접 호출한다
    runImmediately: false,
    logger: silentLogger,
    upsert: vi.fn(() => ({ inserted: 0, updated: 0, changed: 0 })),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  startRunMock.mockReturnValue(1);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("startCollector — 회차 기록 연동(4.1)", () => {
  it("정상 회차는 success로 기록되고 detail에 targetCourts/pagesRequested/itemsFetched/inserted/updated/changed가 담긴다", async () => {
    const upsert = vi.fn(() => ({ inserted: 2, updated: 1, changed: 1 }));
    const source: AuctionSource = {
      fetchActiveItems: async () => ({
        items: [item("1"), item("2"), item("3")],
        pagesRequested: 5,
      }),
    };
    startRunMock.mockReturnValue(42);

    const handle = startCollector(baseOptions({ source, upsert }));
    await handle.tick();
    await handle.stop();

    expect(startRunMock).toHaveBeenCalledWith("collector");
    expect(finishRunMock).toHaveBeenCalledWith(42, {
      outcome: "success",
      detail: {
        targetCourts: ["서울중앙지방법원"],
        pagesRequested: 5,
        itemsFetched: 3,
        inserted: 2,
        updated: 1,
        changed: 1,
      },
    });
  });

  it("pagesRequested는 소스가 실제로 돌려준 값을 기록한다 — 설정된 페이지 상한이 아니다 (원래 결함 회귀 테스트)", async () => {
    // 소스가 돌려주는 값(7)과 설정 상한(1)을 일부러 다르게 둔다. 이전 구현은
    // CollectorOptions.maxPagesPerCourt(설정값)를 그대로 기록했으므로 pagesRequested가
    // 1이 됐을 것이다 — 이 테스트는 그 결함을 잡는다.
    const source: AuctionSource = {
      fetchActiveItems: async () => ({ items: [], pagesRequested: 7 }),
    };
    startRunMock.mockReturnValue(11);

    // maxPages=1로 좁혀도(가상의 설정 상한) 기록에는 영향을 주지 않아야 한다 —
    // CollectorOptions에는 더 이상 그런 값을 받는 자리 자체가 없다.
    const handle = startCollector(baseOptions({ source }));
    await handle.tick();
    await handle.stop();

    expect(finishRunMock).toHaveBeenCalledWith(
      11,
      expect.objectContaining({
        detail: expect.objectContaining({ pagesRequested: 7 }),
      }),
    );
  });

  it.each([
    ["RobotDetectedError", () => new RobotDetectedError("로봇탐지 차단", null)],
    ["WafBlockedError", () => new WafBlockedError("WAF 차단", "<html>차단 페이지</html>")],
  ])("%s는 failed가 아니라 blocked로 기록되고 error_kind가 클래스 이름과 같다", async (name, makeError) => {
    startRunMock.mockReturnValue(9);
    const source: AuctionSource = {
      fetchActiveItems: async () => {
        throw makeError();
      },
    };

    const handle = startCollector(baseOptions({ source }));
    await handle.tick();
    await handle.stop();

    expect(finishRunMock).toHaveBeenCalledWith(
      9,
      expect.objectContaining({ outcome: "blocked", errorKind: name }),
    );
  });

  it.each([
    ["ResponseSchemaError", () => new ResponseSchemaError("응답 형식이 바뀜", ["필드 x 누락"])],
    [
      "SourceRequestError",
      () => new SourceRequestError("네트워크 오류", { url: "https://example.test", status: 500 }),
    ],
  ])("%s는 blocked가 아니라 failed로 기록된다(차단과 일반 실패의 구별)", async (name, makeError) => {
    startRunMock.mockReturnValue(3);
    const source: AuctionSource = {
      fetchActiveItems: async () => {
        throw makeError();
      },
    };

    const handle = startCollector(baseOptions({ source }));
    await handle.tick();
    await handle.stop();

    expect(finishRunMock).toHaveBeenCalledWith(
      3,
      expect.objectContaining({ outcome: "failed", errorKind: name }),
    );
  });

  it("차단 회차의 detail에는 실패 전까지 확인된 수치(itemsFetched=0 등)가 남는다", async () => {
    startRunMock.mockReturnValue(5);
    const source: AuctionSource = {
      fetchActiveItems: async () => {
        // 이 가짜 소스는 (실제 CourtAuctionAdapter와 달리) 오류에 pagesRequested를 실어
        // 보내지 않는다 — "어댑터가 그 필드를 아직 채우지 않은 오류"를 흉내 낸다. 그
        // 경우 detail의 기본값 0이 그대로 쓰인다(세션 부트스트랩 단계에서 실패해 검색
        // 요청 자체를 한 번도 보내기 전이라면 실제로 0이 맞다).
        throw new RobotDetectedError("차단", null);
      },
    };

    const handle = startCollector(baseOptions({ source }));
    await handle.tick();
    await handle.stop();

    expect(finishRunMock).toHaveBeenCalledWith(
      5,
      expect.objectContaining({
        detail: {
          targetCourts: ["서울중앙지방법원"],
          pagesRequested: 0,
          itemsFetched: 0,
          inserted: 0,
          updated: 0,
          changed: 0,
        },
      }),
    );
  });

  it("차단 전까지 어댑터가 실제로 보낸 페이지 수가 pagesRequested에 남는다(0으로 뭉개지지 않는다) — 원래 결함 회귀 테스트", async () => {
    // 차단으로 중단된 회차야말로 "요청을 몇 번 보냈길래 차단됐는지"를 가장 알아야
    // 한다 — 0은 "요청을 안 보냈다"로 읽히는데, 차단은 요청을 보냈기 때문에 발생하므로
    // 사실과 반대다(설정 상수를 관측값 자리에 넣던 원래 결함과 같은 종류의 거짓).
    // CourtAuctionAdapter는 이런 상황에서 attachPagesRequested로 오류에 실제 페이지
    // 수를 실어 보낸다 — 여기서는 그 계약만 가짜 소스로 재현해 collector가 그 값을
    // 그대로 detail에 반영하는지 확인한다.
    startRunMock.mockReturnValue(6);
    const source: AuctionSource = {
      fetchActiveItems: async () => {
        throw attachPagesRequested(new RobotDetectedError("3페이지째 차단", null), 3);
      },
    };

    const handle = startCollector(baseOptions({ source }));
    await handle.tick();
    await handle.stop();

    expect(finishRunMock).toHaveBeenCalledWith(
      6,
      expect.objectContaining({
        outcome: "blocked",
        detail: expect.objectContaining({ pagesRequested: 3 }),
      }),
    );
  });
});

describe("startCollector — 건너뜀 사유 구별(4.3)", () => {
  it("이전 회차가 실행 중이면 skipped/overlap으로 기록된다(backoff와 구별)", async () => {
    let resolveHang: (() => void) | undefined;
    const hang = new Promise<void>((resolve) => {
      resolveHang = resolve;
    });
    const source: AuctionSource = {
      fetchActiveItems: async () => {
        await hang;
        return { items: [], pagesRequested: 0 };
      },
    };

    const handle = startCollector(baseOptions({ source }));
    const firstTick = handle.tick(); // 아직 안 끝남
    await new Promise((r) => setTimeout(r, 10));

    await handle.tick(); // 이전 tick이 진행 중 — overlap으로 건너뛰어야 한다
    expect(recordSkippedRunMock).toHaveBeenCalledWith("collector", "overlap");
    expect(recordSkippedRunMock).not.toHaveBeenCalledWith("collector", "backoff");

    resolveHang?.();
    await firstTick;
    await handle.stop();
  });

  it("차단 백오프 창 안이면 skipped/backoff로 기록된다(overlap과 구별)", async () => {
    const source: AuctionSource = {
      fetchActiveItems: async () => {
        throw new RobotDetectedError("차단", null);
      },
    };

    const handle = startCollector(baseOptions({ source, blockBackoffMs: 60_000 }));
    await handle.tick(); // blocked, 백오프 시작
    recordSkippedRunMock.mockClear();

    await handle.tick(); // 백오프 창 안 — backoff로 건너뛰어야 한다
    await handle.stop();

    expect(recordSkippedRunMock).toHaveBeenCalledWith("collector", "backoff");
    expect(recordSkippedRunMock).not.toHaveBeenCalledWith("collector", "overlap");
  });

  // hardening-round2 group 2 — "차단 후 백오프 창이 지나면 수집이 다시 시도되는가"는
  // 이 프로젝트에서 한 번도 테스트되지 않았다(위 테스트는 "창 안에서 건너뛴다"만 본다).
  // 실제 사이트 차단으로 복귀를 관측하는 것은 위험하므로(design.md D1), 아주 짧은
  // blockBackoffMs + 실제 짧은 대기(위 "overlap" 테스트와 같은 패턴)로 창이 지나가는
  // 상황만 흉내낸다 — Date.now()를 모킹하지 않는다(collector.ts가 실제로 그렇게 동작하므로
  // 그대로 재현하는 편이 모킹보다 신뢰도가 높다).
  it("백오프 창이 지나면 다음 tick은 건너뛰지 않고 다시 수집을 시도한다(복귀)", async () => {
    let calls = 0;
    const source: AuctionSource = {
      fetchActiveItems: async () => {
        calls += 1;
        if (calls === 1) throw new RobotDetectedError("차단", null);
        return { items: [], pagesRequested: 1 };
      },
    };

    const handle = startCollector(baseOptions({ source, blockBackoffMs: 5 }));
    await handle.tick(); // 1회차: blocked, 5ms 백오프 시작
    recordSkippedRunMock.mockClear();
    finishRunMock.mockClear();

    await new Promise((r) => setTimeout(r, 30)); // 백오프 창(5ms)이 지나가도록 실제로 대기

    await handle.tick(); // 2회차: 창이 지났으니 skip하지 않고 실제로 재시도해야 한다
    await handle.stop();

    // "건너뛰지 않았다"는 recordSkippedRun이 backoff로 또 호출되지 않은 것으로 확인하고,
    // "실제로 재시도했다"는 소스가 두 번째로 호출된 것(calls===2)과 finishRun이 success로
    // 기록된 것으로 확인한다 — 두 조건 다 확인해야 "그냥 안 건너뛰었다"가 아니라 "정상
    // 수집이 재개됐다"는 것을 알 수 있다.
    expect(calls).toBe(2);
    expect(recordSkippedRunMock).not.toHaveBeenCalledWith("collector", "backoff");
    expect(finishRunMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: "success" }),
    );
  });
});

describe("startCollector — 기록 실패가 수집을 막지 않는다(4.2, 스펙 MUST NOT)", () => {
  it("startRun/finishRun이 둘 다 던져도 물건은 정상 저장되고 tick()은 정상 종료한다", async () => {
    startRunMock.mockImplementation(() => {
      throw new Error("회차 기록 DB 다운");
    });
    finishRunMock.mockImplementation(() => {
      throw new Error("회차 기록 DB 다운");
    });
    const items = [item("1"), item("2")];
    const upsert = vi.fn(() => ({ inserted: 2, updated: 0, changed: 0 }));
    const source: AuctionSource = {
      fetchActiveItems: async () => ({ items, pagesRequested: 1 }),
    };

    const handle = startCollector(baseOptions({ source, upsert }));

    await expect(handle.tick()).resolves.toBeUndefined();
    await handle.stop();

    // 저장은 기록 실패와 무관하게 실제로 일어났다 — 스펙의 핵심 요구.
    expect(upsert).toHaveBeenCalledWith(items);
  });

  it("recordSkippedRun이 던져도(overlap) tick()은 정상 종료한다", async () => {
    recordSkippedRunMock.mockImplementation(() => {
      throw new Error("회차 기록 DB 다운");
    });
    let resolveHang: (() => void) | undefined;
    const hang = new Promise<void>((resolve) => {
      resolveHang = resolve;
    });
    const source: AuctionSource = {
      fetchActiveItems: async () => {
        await hang;
        return { items: [], pagesRequested: 0 };
      },
    };

    const handle = startCollector(baseOptions({ source }));
    const firstTick = handle.tick();
    await new Promise((r) => setTimeout(r, 10));

    await expect(handle.tick()).resolves.toBeUndefined();
    expect(recordSkippedRunMock).toHaveBeenCalledWith("collector", "overlap");

    resolveHang?.();
    await firstTick;
    await handle.stop();
  });

  it("startRun이 던지면(runId 없음) finishRun은 아예 호출되지 않는다(갱신할 행이 없다)", async () => {
    startRunMock.mockImplementation(() => {
      throw new Error("회차 기록 DB 다운");
    });
    const source: AuctionSource = {
      fetchActiveItems: async () => ({ items: [], pagesRequested: 0 }),
    };

    const handle = startCollector(baseOptions({ source }));
    await handle.tick();
    await handle.stop();

    expect(finishRunMock).not.toHaveBeenCalled();
  });
});

/**
 * 로테이션 연동 (scale-collection-scheduling task 3.1-3.5).
 *
 * 위의 기존 테스트들(4.1-4.3, add-collection-observability)은 전부 법원 1곳짜리
 * scope를 쓰기 때문에 로테이션이 실제로 여러 법원 사이를 도는지, 차단 시 위치가
 * 전진하지 않는지, 같은 회차에서 다음 법원으로 안 넘어가는지, 요청 수 안전장치가
 * 진행 중인 법원을 안 끊는지는 이 파일 어디에서도 검증되지 않았다 — 이 change가
 * 가장 위험하다고 명시한(design.md D4, tasks.md 3.3/3.4) 부분이라 여기서 채운다.
 */
const courts3: CollectorScopeConfig["courts"] = [
  { name: "서울중앙지방법원", courtCode: "B000210" },
  { name: "서울동부지방법원", courtCode: "B000211" },
  { name: "서울서부지방법원", courtCode: "B000215" },
];

describe("startCollector — 로테이션 연동(scale-collection-scheduling 3.1-3.5)", () => {
  it("여러 회차에 걸쳐 법원이 순환하고, 회차 종료 시 다음 위치가 저장된다(3.1/3.2)", async () => {
    const scope3: CollectorScopeConfig = {
      courts: courts3,
      maxCourtsPerRun: 1,
      maxRequestsPerRun: 999,
    };
    const calledCourtCodes: string[] = [];
    const source: AuctionSource = {
      fetchActiveItems: async ({ courts }) => {
        calledCourtCodes.push(courts[0]!.courtCode);
        return { items: [], pagesRequested: 1 };
      },
    };
    startRunMock.mockReturnValue(1);

    const handle = startCollector(baseOptions({ source, scope: scope3 }));

    // 회차1: 저장된 위치 없음(첫 실행) → 목록의 첫 법원부터.
    getCollectorStateMock.mockReturnValueOnce(null);
    await handle.tick();
    expect(setCollectorStateMock).toHaveBeenLastCalledWith(
      "collector.rotation.nextCourtCode",
      "B000211",
    );

    // 회차2: 저장된 위치가 두 번째 법원 → 세 번째로 넘어간다.
    getCollectorStateMock.mockReturnValueOnce("B000211");
    await handle.tick();
    expect(setCollectorStateMock).toHaveBeenLastCalledWith(
      "collector.rotation.nextCourtCode",
      "B000215",
    );

    // 회차3: 저장된 위치가 세 번째 법원 → 원형으로 다시 처음.
    getCollectorStateMock.mockReturnValueOnce("B000215");
    await handle.tick();
    expect(setCollectorStateMock).toHaveBeenLastCalledWith(
      "collector.rotation.nextCourtCode",
      "B000210",
    );

    await handle.stop();

    // 회차별로 실제 요청이 간 법원이 순서대로 하나씩이었다 — targetCourts가 실제
    // 처리 법원만 담는다는 것(3.2)을 소스 호출 순서로도 재확인.
    expect(calledCourtCodes).toEqual(["B000210", "B000211", "B000215"]);
  });

  it("차단되면 로테이션 위치를 전진시키지 않고, 같은 회차에서 다음 법원으로 넘어가지 않는다(3.3/3.4)", async () => {
    const scope3: CollectorScopeConfig = {
      courts: courts3,
      maxCourtsPerRun: 3, // 상한을 넉넉히 둬도(3곳 전부 대상이어도) 차단되면 첫 법원에서 멈춰야 한다.
      maxRequestsPerRun: 999,
    };
    const calledCourtCodes: string[] = [];
    const source: AuctionSource = {
      fetchActiveItems: async ({ courts }) => {
        calledCourtCodes.push(courts[0]!.courtCode);
        throw new RobotDetectedError("차단", null);
      },
    };
    startRunMock.mockReturnValue(1);
    // 로테이션 위치가 이미 두 번째 법원을 가리키고 있다고 가정 — 차단 후에도 이
    // 값이 그대로 유지되는지가 3.3의 핵심.
    getCollectorStateMock.mockReturnValue("B000211");

    const handle = startCollector(
      baseOptions({ source, scope: scope3, blockBackoffMs: 60_000 }),
    );
    await handle.tick();
    await handle.stop();

    // (3.4) 차단된 법원 하나에만 요청이 갔다 — 같은 회차에서 다음 법원으로 넘어가지 않았다.
    expect(calledCourtCodes).toEqual(["B000211"]);
    // (3.3) 저장되는 다음 위치가 차단된 법원 자신이다 — 전진하지 않았다.
    expect(setCollectorStateMock).toHaveBeenLastCalledWith(
      "collector.rotation.nextCourtCode",
      "B000211",
    );
  });

  it("백오프가 끝나면 차단됐던 법원부터 재개한다(3.3) — 다른 법원으로 건너뛰지 않는다", async () => {
    const scope3: CollectorScopeConfig = {
      courts: courts3,
      maxCourtsPerRun: 1,
      maxRequestsPerRun: 999,
    };
    const calledCourtCodes: string[] = [];
    const source: AuctionSource = {
      fetchActiveItems: async ({ courts }) => {
        calledCourtCodes.push(courts[0]!.courtCode);
        throw new RobotDetectedError("차단", null);
      },
    };
    startRunMock.mockReturnValue(1);
    // 저장된 위치는 계속 "B000211"이다 — 실제 setCollectorState 호출과는 별개로,
    // 이 회차가 시작될 때마다 워커가 이 값을 읽어 그 법원부터 시작하는지만 본다
    // (setCollectorState↔getCollectorState를 실제로 잇는 것은 collector-state.ts의
    // 몫이고 그건 별도 테스트에서 이미 고정했다).
    getCollectorStateMock.mockReturnValue("B000211");

    const handle = startCollector(
      baseOptions({ source, scope: scope3, blockBackoffMs: 1 }),
    );
    await handle.tick(); // 1차 차단
    await new Promise((resolve) => setTimeout(resolve, 5)); // 백오프(1ms) 경과 대기
    await handle.tick(); // 백오프 종료 후 재시도
    await handle.stop();

    expect(calledCourtCodes).toEqual(["B000211", "B000211"]);
  });

  it("maxRequestsPerRun을 넘으면 다음 법원을 시작하지 않되, 이미 시작한 법원은 끊지 않는다(3.5)", async () => {
    const scope3: CollectorScopeConfig = {
      courts: courts3,
      maxCourtsPerRun: 3, // 이번 회차 대상은 3곳 전부.
      maxRequestsPerRun: 2, // 하지만 첫 법원 하나만으로 이미 상한에 도달한다.
    };
    const calledCourtCodes: string[] = [];
    const source: AuctionSource = {
      fetchActiveItems: async ({ courts }) => {
        calledCourtCodes.push(courts[0]!.courtCode);
        // 첫 법원 하나가 이미 상한(2)만큼 요청을 쓴다 — 중간에 끊기지 않고 끝까지
        // 완료되는지가 이 테스트의 핵심(법원을 중간에 끊으면 "물건이 줄었다"로
        // 오해된다, design.md D1).
        return { items: [], pagesRequested: 2 };
      },
    };
    startRunMock.mockReturnValue(1);
    getCollectorStateMock.mockReturnValue(null);

    const handle = startCollector(baseOptions({ source, scope: scope3 }));
    await handle.tick();
    await handle.stop();

    // 첫 법원만 실제로 요청됐다 — 두 번째 법원은 아예 시작되지 않았다.
    expect(calledCourtCodes).toEqual(["B000210"]);
    expect(finishRunMock).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        outcome: "success",
        detail: expect.objectContaining({
          targetCourts: ["서울중앙지방법원"],
          pagesRequested: 2,
        }),
      }),
    );
    // 다음 회차는 시작하지 못한(두 번째) 법원부터 이어서 시도한다 — 건너뛰지 않는다.
    expect(setCollectorStateMock).toHaveBeenLastCalledWith(
      "collector.rotation.nextCourtCode",
      "B000211",
    );
  });
});
