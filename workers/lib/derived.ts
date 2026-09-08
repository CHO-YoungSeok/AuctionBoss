/**
 * 분석 프롬프트에 넣을 파생 지표를 코드로 미리 계산한다.
 *
 * 배경(실데이터 검증 실패, enrich-item-fields): `minArea: 84`, `minBidPrice:
 * 711000000`, `minBidPriceRound1: 711000000`, `minBidPriceRateRound1: 100`이 전부
 * non-null이고 렌더된 프롬프트에도 들어 있었는데도, 모델이 "면적 또는 최저매각가격
 * 정보 없음"/"차수별 최저가 정보 없음"이라고 답한 사례가 실제로 있었다. 파이프라인은
 * 정상이었다 — 모델에게 ~45개 JSON 키 중에서 필요한 값을 찾아 null 체크하고 나눗셈까지
 * 하라고 시키면, 가끔 "정보 없음" 분기를 taking 것이 이 실패의 정체다.
 *
 * 그래서 이 모듈은 그 산수와 null 판정을 코드에서 끝내고, "계산됨"과 "계산 불가"를
 * 명확히 구분하는 구조체만 돌려준다. 프롬프트 렌더러(`./prompt.ts`)는 이 결과를 이미
 * 계산된 값으로 프롬프트에 명시하고, 모델에게는 "해석"만 시킨다.
 *
 * `workers/**`는 `src/app/**`를 import하지 않는다(분석기와 웹 앱의 독립성) — 그래서
 * 면적당 가격 계산 자체(`computePricePerArea`)는 `src/lib/domain/price.ts`에 있는
 * 공유 함수를 그대로 가져다 쓴다. 화면(`src/app/_lib/item-extensions.ts`)도 같은
 * 함수를 쓰므로 계산이 두 곳에서 갈라질 수 없다.
 */
import { computePricePerArea, type AuctionItem } from "@/lib/domain";

/** 계산에 필요한 부분집합. */
export type DerivedFiguresFields = Pick<
  AuctionItem,
  | "minBidPrice"
  | "minArea"
  | "maxArea"
  | "appraisalPrice"
  | "minBidPriceRound1"
  | "minBidPriceRound2"
  | "minBidPriceRound3"
  | "minBidPriceRound4"
>;

export const PRICE_PER_AREA_UNAVAILABLE_REASON = "면적 또는 최저매각가격 정보 없음";
export const ROUND_TREND_UNAVAILABLE_REASON = "차수별 최저가 정보 없음";

export interface PricePerAreaComputed {
  computed: true;
  /** 원/㎡. */
  wonPerArea: number;
}
export interface PricePerAreaUnavailable {
  computed: false;
  reason: string;
}
export type PricePerAreaDerived = PricePerAreaComputed | PricePerAreaUnavailable;

/** 차수 하나의 파생 수치. */
export interface RoundFigure {
  round: 1 | 2 | 3 | 4;
  /** 원. 이 회차에 실제 가격이 있을 때만 이 구조체가 만들어진다. */
  price: number;
  /**
   * 감정가 대비 이 회차 가격의 비율(%, 소수점 첫째 자리). `appraisalPrice`가 없거나
   * 0 이하이면 계산할 수 없으므로 null — "계산 안 함"과 "0%"를 구분한다.
   */
  ratioToAppraisalPercent: number | null;
  /**
   * 직전에 값이 있던 회차 대비 이번 회차의 하락률(%, 소수점 첫째 자리). 값이 있는
   * 회차 중 첫 번째면(비교 대상이 없으므로) null. 회차 번호가 연속이 아니어도(예: 1차
   * 다음으로 값이 있는 회차가 3차) "값이 있는 회차들의 순서상 직전"을 기준으로 삼는다
   * — 2차가 아직 도래하지 않아 값이 없는 경우가 실데이터에서 흔하기 때문이다.
   */
  stepDownFromPreviousPercent: number | null;
}

export interface RoundTrendComputed {
  computed: true;
  /** 실제 가격이 있는 회차만, 회차 순서대로. */
  rounds: RoundFigure[];
}
export interface RoundTrendUnavailable {
  computed: false;
  reason: string;
}
export type RoundTrendDerived = RoundTrendComputed | RoundTrendUnavailable;

export interface DerivedFigures {
  pricePerArea: PricePerAreaDerived;
  roundTrend: RoundTrendDerived;
}

/** 유한한 양수 금액인지 확인한다(0은 이 도메인에서 "값 없음"이다 — design.md D3). */
function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** 백분율을 소수점 첫째 자리로 반올림한다. 결과가 유한하지 않으면 null. */
function roundPercent(value: number): number | null {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

/**
 * 물건 1건에서 면적당 가격과 차수별 저감 추이를 계산한다. 순수 함수 — 네트워크·파일
 * 접근이 없고, 같은 입력에는 항상 같은 출력을 돌려준다.
 */
export function computeDerivedFigures(item: DerivedFiguresFields): DerivedFigures {
  const wonPerArea = computePricePerArea(item);
  const pricePerArea: PricePerAreaDerived =
    wonPerArea === null
      ? { computed: false, reason: PRICE_PER_AREA_UNAVAILABLE_REASON }
      : { computed: true, wonPerArea };

  const roundDefs: Array<{ round: 1 | 2 | 3 | 4; price: number | null | undefined }> = [
    { round: 1, price: item.minBidPriceRound1 },
    { round: 2, price: item.minBidPriceRound2 },
    { round: 3, price: item.minBidPriceRound3 },
    { round: 4, price: item.minBidPriceRound4 },
  ];

  // 값이 있는(=가격이 실제로 도래한) 회차만 남긴다 — 실데이터는 아직 도래하지 않은
  // 회차의 "최저가율"만 채워 두고 가격은 비워 두는 경우가 있으므로(§11), 가격 유무로만
  // 판정한다. 비율(rate) 필드는 여기서 아예 보지 않는다.
  const present = roundDefs.filter(
    (def): def is { round: 1 | 2 | 3 | 4; price: number } => isPositiveFiniteNumber(def.price),
  );

  const appraisal = isPositiveFiniteNumber(item.appraisalPrice) ? item.appraisalPrice : null;

  const rounds: RoundFigure[] = present.map((def, index) => {
    const previous = index > 0 ? present[index - 1] : null;
    const ratioToAppraisalPercent =
      appraisal !== null ? roundPercent((def.price / appraisal) * 100) : null;
    const stepDownFromPreviousPercent =
      previous !== null && previous.price > 0
        ? roundPercent(((previous.price - def.price) / previous.price) * 100)
        : null;
    return {
      round: def.round,
      price: def.price,
      ratioToAppraisalPercent,
      stepDownFromPreviousPercent,
    };
  });

  const roundTrend: RoundTrendDerived =
    rounds.length === 0 ? { computed: false, reason: ROUND_TREND_UNAVAILABLE_REASON } : { computed: true, rounds };

  return { pricePerArea, roundTrend };
}
