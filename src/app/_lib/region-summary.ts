/**
 * 목록 화면의 소재지 "지역 요약" 표시 (design.md D5, tasks.md 1.3).
 *
 * 4회차(enrich-item-fields)가 소재지를 구조화해 `sido`/`sigungu`/`dong`으로 나눠 저장한다.
 * 목록은 이 셋만 이어붙여 짧게 보여준다 — 지번·건물명까지 붙이는 전체 구조화 표기
 * (`item-extensions.ts`의 `formatStructuredAddress`, 상세 화면 전용)는 목록에 넣기엔 길어서
 * "요약"의 목적(가로로 넘치지 않으면서 어느 동네인지 한눈에 보이게)에 맞지 않는다.
 *
 * 구조화 값이 하나도 없는 물건(이 기능 이전 수집분)은 기존 `address` 문자열을 그대로
 * 쓴다 — 값이 없다고 화면이 비면 안 된다(spec: "지역 요약").
 */
import type { AuctionItem } from "@/lib/domain";

import { formatText } from "./format";

/** `AuctionItem`에서 지역 요약에 쓰는 부분집합. */
export type RegionSummaryFields = Pick<AuctionItem, "sido" | "sigungu" | "dong" | "address">;

/**
 * 지역 요약 문자열을 만든다.
 *
 * - `sido`/`sigungu`/`dong` 중 값이 있는 것만 순서대로 이어붙인다. 셋 중 일부만 있어도
 *   (예: 시/도만 있고 동이 없음) 있는 것만으로 요약을 만든다 — 전부 있어야만 요약을
 *   시도하면 부분 구조화 데이터가 전부 `address`로 되돌아가 버려 요약의 의미가 없다.
 * - 셋 다 없으면(구조화 이전 수집분) 기존 `address`를 그대로 쓴다(`formatText`가 빈
 *   문자열·null을 "-"로 통일한다).
 */
export function formatRegionSummary({ sido, sigungu, dong, address }: RegionSummaryFields): string {
  const parts = [sido, sigungu, dong].filter(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
  if (parts.length > 0) return parts.join(" ");
  return formatText(address);
}
