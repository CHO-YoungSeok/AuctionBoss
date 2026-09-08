/**
 * 물건 상세 화면이 확장 필드(enrich-item-fields, `AuctionItem`의 32개 nullable 필드)를
 * 표시하기 위해 쓰는 순수 헬퍼.
 *
 * change-history.ts/analysis-history.ts의 선례를 따라 표시 판정을 JSX 밖으로 뽑아 테스트로
 * 고정한다 — "이 프로젝트는 표시 판정이 JSX에 인라인돼 있다가 버그로 발견된 적이 있다"는
 * 경고(tasks.md task 4.4)가 이 파일의 존재 이유다.
 *
 * design.md D3(값 없음과 0 구분)·D4(의미를 모르는 코드값을 해석하지 않음)를 그대로 따른다:
 * - 가격·면적·차수별 값은 데이터 계층에서 이미 0을 null로 접어 뒀으므로, 여기서는 "값이
 *   있으면 표시하고 없으면 EMPTY"만 하면 된다. 0-vs-없음 재판정을 이 파일에서 하지 않는다.
 * - 코드값(용도 대/중/소분류, 진행상태/물건상태 코드, 좌표)은 절대 해석하지 않는다. 이
 *   파일은 그 필드들에 라벨을 붙이는 함수를 두지 않는다 — 붙일 라벨이 없다는 뜻이다.
 */
import {
  computePricePerArea,
  type AuctionItem,
  type PricePerAreaBasisField,
  type PricePerAreaFields,
  type PricePerAreaResult,
} from "@/lib/domain";

import { EMPTY, formatWon } from "./format";

const integerFormatter = new Intl.NumberFormat("ko-KR");

// ---------------------------------------------------------------------------
// 면적 · 건물 구조 (ux-overhaul-phase1 design.md D1)
// ---------------------------------------------------------------------------

/** `AuctionItem`에서 면적 표시에 쓰는 부분집합. */
export type AreaFields = Pick<AuctionItem, "minArea" | "maxArea">;

/** 1평 = 3.3058㎡(공식 환산 계수). */
const SQM_PER_PYEONG = 3.3058;

/**
 * ㎡ → 평 환산(task 2.1). 원본 면적이 정수로 절삭 저장되므로(NOTES.md) 환산값도 소수
 * 1자리까지만 쓴다 — 2자리 이상을 쓰면 원본에 없는 정밀도를 꾸며내는 것이 된다.
 *
 * 0·음수·비유한값은 모두 null(변환 불가) — 이 도메인에서 면적 0은 이미 데이터 계층이
 * null로 접어 두는 값이라(design.md D3) 여기 들어올 일이 없어야 하지만, 순수 함수로서
 * 방어적으로 다시 확인한다.
 */
export function toPyeong(sqm: number): number | null {
  if (typeof sqm !== "number" || !Number.isFinite(sqm) || sqm <= 0) return null;
  return Math.round((sqm / SQM_PER_PYEONG) * 10) / 10;
}

/** 면적 하나(㎡, 이미 유효성 검증된 양수)를 `"84㎡ (25.4평)"` 형태로 병기한다(task 2.2). */
function formatAreaWithPyeong(sqm: number): string {
  const pyeong = toPyeong(sqm);
  return pyeong === null ? `${sqm}㎡` : `${sqm}㎡ (${pyeong}평)`;
}

/**
 * 면적을 사람이 읽는 문자열로 만든다.
 *
 * design.md D1: 실데이터의 48%는 `minArea > maxArea`(역전)다 — 원인 불명, 두 필드가
 * 대지권/전유면적인지 토지/건물인지조차 소스 재조사 없이는 알 수 없다. 이 경우
 * `"11414㎡ ~ 80㎡"`처럼 범위로 이으면 **존재하지 않는 범위**를 사실처럼 보여주게 된다.
 * 그렇다고 값을 정렬해 `"80㎡ ~ 11414㎡"`로 뒤집지도 않는다 — "최소가 80"이라는 없는
 * 사실을 만들게 된다. 대신 소스가 부른 그대로 "면적 A"(minArea)·"면적 B"(maxArea)로
 * 병기하고 의미가 미확정임을 밝힌다 — 좌표·용도코드에 이미 적용한 원칙(design.md D4,
 * 이전 change)과 같다.
 *
 * `minArea`/`maxArea`가 같으면(REAL_ROW의 실제 관측값 대부분이 그렇듯) 한 번만 보여주고,
 * 정상 범위(`min <= max`, 둘이 다름)면 두 값을 `~`로 잇는다(task 1.2, 실데이터 52%).
 * 한쪽만 있으면 그 값만, 둘 다 없으면 EMPTY. 모든 경우에 평이 함께 표시된다(task 2.2).
 */
export function formatAreaRange({ minArea, maxArea }: AreaFields): string {
  const min = typeof minArea === "number" && Number.isFinite(minArea) && minArea > 0 ? minArea : null;
  const max = typeof maxArea === "number" && Number.isFinite(maxArea) && maxArea > 0 ? maxArea : null;

  if (min === null && max === null) return EMPTY;
  if (min === null || max === null) return formatAreaWithPyeong((min ?? max)!);
  if (min === max) return formatAreaWithPyeong(min);

  if (min > max) {
    // 역전(design.md D1) — 범위로 잇지 않는다. "A"/"B"는 어느 쪽이 진짜 최소·최대인지
    // 확정하지 않는 중립적 이름이다(minArea=A, maxArea=B, 소스가 준 필드 순서 그대로).
    return `면적 A ${formatAreaWithPyeong(min)} · 면적 B ${formatAreaWithPyeong(max)} (의미 미확정)`;
  }

  return `${formatAreaWithPyeong(min)} ~ ${formatAreaWithPyeong(max)}`;
}

// ---------------------------------------------------------------------------
// 면적당 가격 (task 4.4, ux-overhaul-phase1 design.md D2)
//
// 계산 자체(`computePricePerArea`)는 `src/lib/domain/price.ts`에 있다 — 분석 워커
// (`workers/lib/derived.ts`, enrich-item-fields 실데이터 검증 이후 추가)도 똑같은 계산이
// 필요해졌고, `workers/**`는 `src/app/**`를 import하지 않으므로(분석기와 웹 앱의 독립성)
// 화면과 분석 워커 어느 쪽에도 속하지 않는 도메인 계층으로 옮겨 공유한다. 이 파일은 그
// 공유 함수를 그대로 재노출한다 — 정의를 두 번 하지 않기 위함이다.
// ---------------------------------------------------------------------------

export { computePricePerArea, type PricePerAreaBasisField, type PricePerAreaFields, type PricePerAreaResult };

/**
 * `computePricePerArea`의 결과를 화면 문자열로 만든다. 원 단위 반올림 후 천 단위 구분.
 *
 * design.md D2: `basisAmbiguous`가 true(=minArea·maxArea가 둘 다 있고 서로 다름)일 때만
 * 기준 면적을 괄호로 밝힌다 — `1,296,089원/㎡ (면적 A 179㎡ 기준)`. 둘이 같거나 한쪽만
 * 있으면 기준이 결과에 영향을 주지 않으므로 표기를 생략한다(tasks.md 1.4).
 */
export function formatPricePerArea(result: PricePerAreaResult | null): string {
  if (result === null) return EMPTY;
  const price = `${integerFormatter.format(Math.round(result.pricePerArea))}원/㎡`;
  if (!result.basisAmbiguous) return price;
  const label = result.basisField === "minArea" ? "A" : "B";
  return `${price} (면적 ${label} ${integerFormatter.format(result.basisArea)}㎡ 기준)`;
}

// ---------------------------------------------------------------------------
// 차수별 최저매각가격
// ---------------------------------------------------------------------------

export interface RoundPrice {
  round: 1 | 2 | 3 | 4;
  /** 원. 항상 유한한 값(0은 데이터 계층이 이미 null로 접었다 — design.md D3). */
  price: number;
  /** %. 1·2차만 소스가 준다(NOTES.md §11) — 3·4차는 항상 null. */
  ratePercent: number | null;
}

/** `AuctionItem`에서 차수별 최저가 표시에 쓰는 부분집합. */
export type RoundPriceFields = Pick<
  AuctionItem,
  | "minBidPriceRound1"
  | "minBidPriceRound2"
  | "minBidPriceRound3"
  | "minBidPriceRound4"
  | "minBidPriceRateRound1"
  | "minBidPriceRateRound2"
>;

/**
 * 값이 있는 회차만 골라 순서대로 돌려준다 — 값이 없는 회차는 빈 행을 만들지 않고 그냥
 * 건너뛴다(task 4.4: "값이 없는 회차는 빈 행을 만들지 않고 건너뛰는 렌더러").
 */
export function listRoundPrices(item: RoundPriceFields): RoundPrice[] {
  const defs: Array<{ round: 1 | 2 | 3 | 4; price: number | null | undefined; rate: number | null | undefined }> = [
    { round: 1, price: item.minBidPriceRound1, rate: item.minBidPriceRateRound1 },
    { round: 2, price: item.minBidPriceRound2, rate: item.minBidPriceRateRound2 },
    { round: 3, price: item.minBidPriceRound3, rate: null },
    { round: 4, price: item.minBidPriceRound4, rate: null },
  ];
  const rounds: RoundPrice[] = [];
  for (const def of defs) {
    if (typeof def.price !== "number" || !Number.isFinite(def.price)) continue;
    const rate =
      typeof def.rate === "number" && Number.isFinite(def.rate) ? def.rate : null;
    rounds.push({ round: def.round, price: def.price, ratePercent: rate });
  }
  return rounds;
}

/** 차수별 최저가 한 행을 `"1차: 711,000,000원 (100%)"` 형태로 만든다. `ratePercent`가
 * 없으면 괄호를 생략한다. */
export function formatRoundPrice(round: RoundPrice): string {
  const price = formatWon(round.price);
  return round.ratePercent === null
    ? `${round.round}차: ${price}`
    : `${round.round}차: ${price} (${round.ratePercent}%)`;
}

// ---------------------------------------------------------------------------
// 용도 분류 (design.md D4 — 코드표 미확인, 원문 보존)
// ---------------------------------------------------------------------------

/** `AuctionItem`에서 용도 코드 표시에 쓰는 부분집합. */
export type UsageCodeFields = Pick<
  AuctionItem,
  "usageCodeLarge" | "usageCodeMedium" | "usageCodeSmall"
>;

/**
 * 용도 대/중/소분류 코드를 있는 값만 이어붙여 보여준다. **절대 라벨을 붙이지 않는다** —
 * 코드표가 확인되지 않았으므로(design.md D4) 무슨 뜻인지 안다는 듯 보이는 텍스트를 만들면
 * 안 된다. 호출부(JSX)가 이 값을 "원본 코드"라는 라벨과 함께 보여줘야 한다.
 */
export function formatUsageCodes({ usageCodeLarge, usageCodeMedium, usageCodeSmall }: UsageCodeFields): string {
  const parts = [usageCodeLarge, usageCodeMedium, usageCodeSmall].filter(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
  return parts.length > 0 ? parts.join(" / ") : EMPTY;
}

// ---------------------------------------------------------------------------
// 구조화된 소재지
// ---------------------------------------------------------------------------

/** `AuctionItem`에서 구조화된 소재지 표시에 쓰는 부분집합. */
export type StructuredAddressFields = Pick<
  AuctionItem,
  "sido" | "sigungu" | "dong" | "lotNumber" | "buildingName" | "buildingUnit"
>;

/**
 * 소재지 구조화 값(시/도·시/군/구·동·대표지번·건물명·동/층/호)을 값이 있는 것만 순서대로
 * 이어붙인다. `address`(조합 문자열, 기존 필드)와 별개의 표시다 — 소스가 이미 조각내 준
 * 값을 그대로 보여준다.
 */
export function formatStructuredAddress({
  sido,
  sigungu,
  dong,
  lotNumber,
  buildingName,
  buildingUnit,
}: StructuredAddressFields): string {
  const parts = [sido, sigungu, dong, lotNumber, buildingName, buildingUnit].filter(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
  return parts.length > 0 ? parts.join(" ") : EMPTY;
}
