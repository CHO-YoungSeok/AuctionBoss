/**
 * 저장 골든 시나리오 정의 (port-collector-to-spring D6 시나리오 목록, 10개).
 *
 * 시나리오는 단계 목록이다. 단계는 (1) 수집 틱, (2) 사진 틱, (3) 틱 없이 상태만 만지는 준비 작업
 * 중 하나이고, 가짜 `AuctionSource`가 돌려줄 응답을 함께 담는다. 실제 TS 워커를 이 정의대로 돌려
 * 단계마다 스냅숏을 남기는 것은 generate-store-goldens.ts가 한다. 여기에는 기대값이 없다.
 */
import type { AuctionItemInput } from "../../src/lib/domain";

export type ErrorKind = "RobotDetectedError" | "WafBlockedError" | "ResponseSchemaError" | "SourceRequestError";

/** 가짜 소스가 던지는 오류. `requestsMade`가 있으면 어댑터처럼 오류에 실제 요청 수를 싣는다. */
export interface ScriptedError {
  kind: ErrorKind;
  message: string;
  requestsMade?: number;
}

export type SearchResult = { items: AuctionItemInput[]; pagesRequested: number } | { error: ScriptedError };

export type PhotoResult =
  | { photos: { seq: number; base64: string }[]; requestsMade: number }
  | { error: ScriptedError };

export interface CourtDef {
  name: string;
  courtCode: string;
}

export interface ScopeDef {
  courts: CourtDef[];
  maxCourtsPerRun: number;
  maxRequestsPerRun: number;
}

export interface PhotosConfigDef {
  intervalMs: number;
  maxItemsPerRun: number;
  requestDelayMs: number;
  retryAfterHours: number;
}

export type PrepareOp =
  | { kind: "extendBackoff"; until: string }
  | { kind: "photoState"; court: string; caseNo: string; itemNo: string; status: "uncollected" | "failed" | "empty"; attemptedAt: string | null };

export type StepDef =
  | {
      label: string;
      at: string;
      run: "collector";
      /** 이 단계만 설정의 법원·상한을 바꾼다. */
      scope?: ScopeDef;
      /** 법원 코드 -> 그 법원 호출에 돌려줄 결과. 여기 없는 법원을 부르면 생성이 실패한다. */
      search: Record<string, SearchResult>;
    }
  | { label: string; at: string; run: "photos"; photosConfig?: PhotosConfigDef; results: PhotoResult[] }
  | { label: string; at: string; run: "prepare"; op: PrepareOp };

export interface StoreScenarioDef {
  name: string;
  description: string;
  scope: ScopeDef;
  photos: PhotosConfigDef;
  steps: StepDef[];
}

export const T0 = "2026-10-08T00:00:00.000Z";
/** T0에서 분·시간만큼 뒤의 ISO 시각. */
export const at = (minutes: number): string => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

const CA: CourtDef = { name: "서울중앙지방법원", courtCode: "B000210" };
const CB: CourtDef = { name: "서울동부지방법원", courtCode: "B000211" };
const CC: CourtDef = { name: "서울남부지방법원", courtCode: "B000212" };

const DEFAULT_SCOPE = (courts: CourtDef[], maxCourtsPerRun = 1, maxRequestsPerRun = 13): ScopeDef => ({
  courts,
  maxCourtsPerRun,
  maxRequestsPerRun,
});
const DEFAULT_PHOTOS: PhotosConfigDef = { intervalMs: 1_800_000, maxItemsPerRun: 5, requestDelayMs: 30_000, retryAfterHours: 24 };

// 사진 바이트(base64). 매직 바이트로 형식이 갈린다: GIF89a, PNG, JPEG.
export const PHOTO_GIF = "R0lGODlhAQABAAAAACw=";
export const PHOTO_PNG = "iVBORw0KGgoAAAANSUhEUg==";
export const PHOTO_JPG = "/9j/4AAQSkZJRgABAQAAAQABAAD/";

/** 물건 하나. 기본값은 신건 상태의 서울중앙지방법원 물건이다. */
function item(court: CourtDef, caseNo: string, overrides: Partial<AuctionItemInput> = {}): AuctionItemInput {
  return {
    court: court.name,
    caseNo,
    itemNo: "1",
    address: `서울특별시 종로구 시험로 ${caseNo.slice(-4)}`,
    usageType: "아파트",
    appraisalPrice: 300_000_000,
    minBidPrice: 240_000_000,
    auctionDate: "2026-11-05",
    failedBidCount: 0,
    status: "신건",
    ...overrides,
  };
}

/** 사진 조회 식별자가 있는 물건. */
const withIds = (court: CourtDef, caseNo: string, overrides: Partial<AuctionItemInput> = {}): AuctionItemInput =>
  item(court, caseNo, {
    internalCaseNo: `20260130${caseNo.slice(-4).padStart(6, "0")}`,
    courtCode: court.courtCode,
    ...overrides,
  });

const ok = (items: AuctionItemInput[], pagesRequested = 1): SearchResult => ({ items, pagesRequested });
const err = (kind: ErrorKind, message: string, requestsMade?: number): { error: ScriptedError } => ({
  error: { kind, message, ...(requestsMade !== undefined ? { requestsMade } : {}) },
});
const collect = (label: string, atMin: number, search: Record<string, SearchResult>, scope?: ScopeDef): StepDef => ({
  label,
  at: at(atMin),
  run: "collector",
  search,
  ...(scope ? { scope } : {}),
});
const photosStep = (label: string, atMin: number, results: PhotoResult[], photosConfig?: PhotosConfigDef): StepDef => ({
  label,
  at: at(atMin),
  run: "photos",
  results,
  ...(photosConfig ? { photosConfig } : {}),
});
const prepare = (label: string, atMin: number, op: PrepareOp): StepDef => ({ label, at: at(atMin), run: "prepare", op });
const gotPhotos = (photos: { seq: number; base64: string }[], requestsMade: number): PhotoResult => ({ photos, requestsMade });

const BLOCK_MSG = "로봇탐지에 걸려 차단됐습니다 (data.ipcheck !== true)";

// ---------------------------------------------------------------- 수집

const insertBaseline: StoreScenarioDef = {
  name: "collect-insert-baseline",
  description: "빈 DB에 3건 신규. 1건은 매각기일이 없어 그 필드의 기준점이 생기지 않는다",
  scope: DEFAULT_SCOPE([CA]),
  photos: DEFAULT_PHOTOS,
  steps: [
    collect(
      "첫 수집: 신규 3건",
      0,
      {
        B000210: ok(
          [
            item(CA, "2026타경1001", {
              minArea: 84,
              maxArea: 84,
              buildingDescription: "철근콘크리트구조\n84.99㎡",
              minBidPriceRound1: 240_000_000,
              minBidPriceRateRound1: 80,
              sido: "서울특별시",
              sigungu: "종로구",
              dong: "청운동",
              lotNumber: "12",
              coordinateX: "312690",
              coordinateY: "555963",
              auctionTime: "1000",
              note: "비고 시험 문구",
              statusCode: "0002100001",
              internalCaseNo: "20260130010001",
              courtCode: "B000210",
            }),
            item(CA, "2026타경1002", { failedBidCount: 1, status: "유찰 1회", minBidPrice: 192_000_000 }),
            item(CA, "2026타경1003", { auctionDate: null }),
          ],
          3,
        ),
      },
    ),
  ],
};

const updateChange: StoreScenarioDef = {
  name: "collect-update-change",
  description: "최저가 하락+유찰 증가, 소재지만 변경, 그대로, 매각기일 없던 물건에 기일 생김, 신규",
  scope: DEFAULT_SCOPE([CA]),
  photos: DEFAULT_PHOTOS,
  steps: [
    collect(
      "첫 수집: 4건",
      0,
      {
        B000210: ok([
          item(CA, "2026타경2001"),
          item(CA, "2026타경2002"),
          item(CA, "2026타경2003"),
          item(CA, "2026타경2004", { auctionDate: null }),
        ]),
      },
    ),
    collect(
      "재수집: 변경 2건(감시 필드), 소재지만 1건, 그대로 1건, 신규 1건",
      10,
      {
        B000210: ok(
          [
            item(CA, "2026타경2001", { minBidPrice: 192_000_000, failedBidCount: 1, status: "유찰 1회" }),
            item(CA, "2026타경2002", { address: "서울특별시 종로구 이전한 주소 2002" }),
            item(CA, "2026타경2003"),
            item(CA, "2026타경2004", { auctionDate: "2026-12-01" }),
            item(CA, "2026타경2005"),
          ],
          2,
        ),
      },
    ),
  ],
};

const duplicateInBatch: StoreScenarioDef = {
  name: "collect-duplicate-in-batch",
  description: "한 회차에 같은 키가 두 번(값 다름): 기존 물건과 신규 물건, 값 없음에서 값이 생기는 경우",
  scope: DEFAULT_SCOPE([CA]),
  photos: DEFAULT_PHOTOS,
  steps: [
    collect("첫 수집: 기존 물건 X", 0, { B000210: ok([item(CA, "2026타경3001", { minBidPrice: 1000, failedBidCount: 0 })]) }),
    collect(
      "같은 키 중복 배치",
      10,
      {
        B000210: ok(
          [
            item(CA, "2026타경3001", { minBidPrice: 900, failedBidCount: 1 }),
            item(CA, "2026타경3001", { minBidPrice: 800, failedBidCount: 1 }),
            item(CA, "2026타경3002", { minBidPrice: 500, failedBidCount: 0 }),
            item(CA, "2026타경3002", { minBidPrice: 400, failedBidCount: 0 }),
            item(CA, "2026타경3003", { minBidPrice: null, failedBidCount: null, auctionDate: null, status: null }),
            item(CA, "2026타경3003", { minBidPrice: 7, failedBidCount: null, auctionDate: null, status: null }),
          ],
          1,
        ),
      },
    ),
    collect(
      "기존 물건이 배치 안에서 값이 바뀌었다가 시작값으로 돌아옴",
      20,
      {
        B000210: ok(
          [
            item(CA, "2026타경3001", { minBidPrice: 5, failedBidCount: 2 }),
            item(CA, "2026타경3001", { minBidPrice: 800, failedBidCount: 1 }),
          ],
          1,
        ),
      },
    ),
  ],
};

const rotationBudget: StoreScenarioDef = {
  name: "collect-rotation-budget",
  description: "법원 3곳·회차당 3곳·요청 상한 2: 상한에서 다음 법원 미시작과 이어서 시작. 이어서 법원 1곳·상한 1의 반복",
  scope: DEFAULT_SCOPE([CA, CB, CC], 3, 2),
  photos: DEFAULT_PHOTOS,
  steps: [
    collect("회차 1: 첫 법원이 3페이지를 써서 두 번째 법원부터 시작하지 않음", 0, {
      B000210: ok([item(CA, "2026타경4001")], 3),
    }),
    collect("회차 2: 두 번째 법원부터. 두 법원이 1페이지씩 쓴 뒤 세 번째는 상한으로 시작하지 않음", 10, {
      B000211: ok([item(CB, "2026타경4101")], 1),
      B000212: ok([item(CC, "2026타경4201")], 1),
    }),
    collect("회차 3(상한 1·법원 1곳씩): 저장된 위치에서 한 곳", 20, { B000210: ok([item(CA, "2026타경4001")], 1) }, DEFAULT_SCOPE([CA, CB, CC], 1, 1)),
    collect("회차 4", 30, { B000211: ok([item(CB, "2026타경4101")], 1) }, DEFAULT_SCOPE([CA, CB, CC], 1, 1)),
    collect("회차 5", 40, { B000212: ok([item(CC, "2026타경4201")], 1) }, DEFAULT_SCOPE([CA, CB, CC], 1, 1)),
    collect("회차 6: 한 바퀴 돌아 처음 법원", 50, { B000210: ok([item(CA, "2026타경4001")], 1) }, DEFAULT_SCOPE([CA, CB, CC], 1, 1)),
  ],
};

const courtRemoved: StoreScenarioDef = {
  name: "collect-court-removed",
  description: "저장된 위치의 법원을 설정에서 뺀 뒤 회차: 처음부터 다시 시작",
  scope: DEFAULT_SCOPE([CA, CB, CC]),
  photos: DEFAULT_PHOTOS,
  steps: [
    collect("회차 1: 첫 법원", 0, { B000210: ok([item(CA, "2026타경5001")]) }),
    collect("회차 2: 두 번째 법원, 다음 위치는 세 번째", 10, { B000211: ok([item(CB, "2026타경5101")]) }),
    collect(
      "회차 3: 세 번째 법원을 설정에서 뺌 -> 저장된 위치를 못 찾아 처음부터",
      20,
      { B000210: ok([item(CA, "2026타경5001")]) },
      DEFAULT_SCOPE([CA, CB]),
    ),
  ],
};

const blocked: StoreScenarioDef = {
  name: "collect-blocked",
  description: "두 번째 법원에서 차단: 물건 미저장, blocked, 위치 유지, 백오프 1시간, 이후 건너뜀과 더 이른 연장 무시, 백오프 뒤 정상",
  scope: DEFAULT_SCOPE([CA, CB], 2, 13),
  photos: DEFAULT_PHOTOS,
  steps: [
    collect("회차 1: 첫 법원 정상, 두 번째 법원에서 차단", 0, {
      B000210: ok([item(CA, "2026타경6001"), item(CA, "2026타경6002")], 2),
      B000211: err("RobotDetectedError", BLOCK_MSG, 1),
    }),
    collect("백오프 중 틱: 건너뜀", 10, {}),
    prepare("더 이른 백오프 연장 시도(무시되어야 함)", 20, { kind: "extendBackoff", until: at(30) }),
    collect("백오프 뒤: 차단됐던 법원부터 정상 수집", 61, {
      B000211: ok([item(CB, "2026타경6101")], 1),
      B000210: ok([item(CA, "2026타경6001"), item(CA, "2026타경6002")], 2),
    }),
  ],
};

const failed: StoreScenarioDef = {
  name: "collect-failed",
  description: "형식 오류·요청 실패: failed, 백오프 없음, 실패한 법원이 다음 시작 위치, 요청 수 기록",
  scope: DEFAULT_SCOPE([CA, CB], 1, 13),
  photos: DEFAULT_PHOTOS,
  steps: [
    collect("회차 1: 응답 형식 오류(요청 1)", 0, { B000210: err("ResponseSchemaError", "응답 형식이 기대와 다릅니다", 1) }),
    collect("회차 2: 요청 실패(요청 수 미기록 = 0)", 10, { B000210: err("SourceRequestError", "물건 검색 요청이 실패했습니다 (HTTP 500)") }),
    collect("회차 3: 정상", 20, { B000210: ok([item(CA, "2026타경7001")], 1) }),
    collect("회차 4: 다음 법원 정상", 30, { B000211: ok([item(CB, "2026타경7101")], 1) }),
  ],
};

// ---------------------------------------------------------------- 사진

const photosOutcomes: StoreScenarioDef = {
  name: "photos-outcomes",
  description: "사진 저장·사진 없음·식별자 없음·일부 실패 -> 성공, 전부 실패 -> failed, 대기 물건 없음 -> 성공 0건",
  scope: DEFAULT_SCOPE([CA]),
  photos: DEFAULT_PHOTOS,
  steps: [
    collect("물건 5건 수집(4번째는 내부 사건번호가 빈 문자열: 대기 목록에는 오르지만 조회할 수 없음)", 0, {
      B000210: ok([
        withIds(CA, "2026타경8001"),
        withIds(CA, "2026타경8002"),
        withIds(CA, "2026타경8003"),
        withIds(CA, "2026타경8004", { internalCaseNo: "" }),
        withIds(CA, "2026타경8005"),
      ]),
    }),
    photosStep("사진 회차: 저장 2장, 식별자 비어 있음 건너뜀(요청·실패 기록 없음), 사진 없음, 요청 실패, 형식 오류", 5, [
      gotPhotos(
        [
          { seq: 1, base64: PHOTO_GIF },
          { seq: 2, base64: PHOTO_PNG },
        ],
        2,
      ),
      gotPhotos([], 1),
      err("SourceRequestError", "물건 상세 요청이 실패했습니다 (HTTP 500)", 1),
      err("ResponseSchemaError", "상세 응답 형식이 기대와 다릅니다", 1),
    ]),
    photosStep("사진 회차: 대기 물건은 조회할 수 없는 것뿐 -> 시도 0건 성공", 10, []),
    collect("물건 2건 더 수집", 15, { B000210: ok([withIds(CA, "2026타경8006"), withIds(CA, "2026타경8007")]) }),
    photosStep("사진 회차: 시도한 물건이 전부 실패 -> failed", 20, [
      err("SourceRequestError", "물건 상세 요청이 실패했습니다 (HTTP 500)", 1),
      err("SourceRequestError", "물건 상세 요청이 실패했습니다 (HTTP 502)", 1),
    ]),
    prepare("조회할 수 없는 물건을 사진 없음으로 정리", 25, {
      kind: "photoState",
      court: CA.name,
      caseNo: "2026타경8004",
      itemNo: "1",
      status: "empty",
      attemptedAt: at(25),
    }),
    photosStep("사진 회차: 대기 물건 없음 -> 성공 0건", 30, []),
  ],
};

const photosBlockedAndRetry: StoreScenarioDef = {
  name: "photos-blocked-and-retry",
  description: "두 번째 물건에서 차단: 첫 물건만 저장, 두 번째는 실패로 안 적고 백오프. 실패 물건은 1시간 뒤 제외, 25시간 뒤 포함(미시도 뒤 순서)",
  scope: DEFAULT_SCOPE([CA]),
  photos: DEFAULT_PHOTOS,
  steps: [
    collect("물건 3건 수집", 0, {
      B000210: ok([withIds(CA, "2026타경9001"), withIds(CA, "2026타경9002"), withIds(CA, "2026타경9003")]),
    }),
    photosStep("사진 회차: 첫 물건 저장, 두 번째에서 차단", 5, [
      gotPhotos([{ seq: 1, base64: PHOTO_JPG }], 2),
      err("RobotDetectedError", BLOCK_MSG, 1),
    ]),
    photosStep("백오프 중 틱: 건너뜀", 15, []),
    photosStep("백오프 뒤: 차단됐던 물건은 실패 처리, 나머지 저장", 70, [
      err("SourceRequestError", "물건 상세 요청이 실패했습니다 (HTTP 500)", 1),
      gotPhotos([{ seq: 1, base64: PHOTO_GIF }], 1),
    ]),
    photosStep("1시간 뒤: 방금 실패한 물건은 대기 목록에서 제외", 130, []),
    collect("25시간 뒤 수집: 새 물건 1건", 25 * 60, { B000210: ok([withIds(CA, "2026타경9004")]) }),
    photosStep("실패 후 25시간: 미시도 물건이 먼저, 그다음 실패 물건", 26 * 60, [
      gotPhotos([], 1),
      gotPhotos([{ seq: 1, base64: PHOTO_PNG }], 1),
    ]),
  ],
};

const sharedBackoff: StoreScenarioDef = {
  name: "shared-backoff",
  description: "사진 워커 차단 -> 수집 틱 건너뜀, 수집 워커 차단 -> 사진 틱 건너뜀(같은 백오프 키)",
  scope: DEFAULT_SCOPE([CA]),
  photos: DEFAULT_PHOTOS,
  steps: [
    collect("물건 2건 수집", 0, { B000210: ok([withIds(CA, "2026타경9501"), withIds(CA, "2026타경9502")]) }),
    photosStep("사진 회차: 첫 물건에서 차단", 5, [err("RobotDetectedError", BLOCK_MSG, 1)]),
    collect("수집 틱: 사진 워커가 건 백오프로 건너뜀", 10, {}),
    collect("백오프 뒤 수집 틱: 수집 쪽에서 차단", 70, { B000210: err("RobotDetectedError", BLOCK_MSG, 1) }),
    photosStep("사진 틱: 수집 워커가 건 백오프로 건너뜀", 80, []),
    collect("두 번째 백오프 뒤: 수집 정상", 140, { B000210: ok([withIds(CA, "2026타경9501"), withIds(CA, "2026타경9502")]) }),
    photosStep("사진 회차 정상: 대기 2건 저장", 145, [
      gotPhotos([{ seq: 1, base64: PHOTO_GIF }], 1),
      gotPhotos([{ seq: 1, base64: PHOTO_JPG }], 1),
    ]),
  ],
};

export const STORE_SCENARIOS: StoreScenarioDef[] = [
  insertBaseline,
  updateChange,
  duplicateInBatch,
  rotationBudget,
  courtRemoved,
  blocked,
  failed,
  photosOutcomes,
  photosBlockedAndRetry,
  sharedBackoff,
];
