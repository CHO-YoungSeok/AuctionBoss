/**
 * 사건 비고(`note`)에서 입찰 가부를 가르는 내용을 문자열 패턴으로 판정하는 순수 헬퍼
 * (ux-overhaul-phase1 design.md D4, tasks.md 4.1).
 *
 * `note`가 152건에 있고, 그 내용이 실제로 입찰 가부를 가른다(예: 지분매각이면 지분만
 * 사는 것이라 온전한 소유권을 기대하고 입찰하면 안 된다). 지금은 이 정보가 상세 페이지
 * 최하단 6번째 카드에만 있어 다른 정보를 다 검토한 뒤에야 발견된다.
 *
 * **실측된 유형만 만든다** — 실데이터 389건을 직접 질의해 실제로 관측된 6개 패턴만
 * 판정한다. 없는 유형을 추측해 만들지 않는다:
 * - 일괄매각(bulkSale) — "일괄매각"
 * - 대항력 포기조건(waivedPriority) — "대항력 포기조건"(공백 유무 편차 있음)
 * - 지분매각(shareSale) — "지분매각"
 * - 위반건축물(illegalBuilding) — "위반건축물"
 * - 농지취득자격증명(farmlandCert) — "농지취득자격증명"
 * - 보증금 20%(highDeposit) — "매수신청보증금 최저매각가격의 20%"(통상 10%보다 높은
 *   특별매각조건)
 *
 * design.md D4: 이 판정은 문자열 패턴 매칭이라 **오탐·미탐이 있다.** 배지는 "여기 뭔가
 * 있다"는 신호일 뿐 원문을 대체하지 않는다 — 상세 페이지는 배지 유무와 무관하게 항상
 * `note` 원문을 그대로 보여준다(item detail page).
 */
import type { AuctionItem } from "@/lib/domain";

export type NoteFlagKind =
  | "bulkSale"
  | "waivedPriority"
  | "shareSale"
  | "illegalBuilding"
  | "farmlandCert"
  | "highDeposit";

/** 배지·설명에 쓰는 표시 라벨. `Record`라 유형을 추가하면 라벨 없는 배지가 컴파일
 * 오류로 걸린다(다른 표시 상수들과 같은 관례, 예: `discount.ts`). */
export const NOTE_FLAG_LABELS: Record<NoteFlagKind, string> = {
  bulkSale: "일괄매각",
  waivedPriority: "대항력 포기조건",
  shareSale: "지분매각",
  illegalBuilding: "위반건축물",
  farmlandCert: "농지취득자격증명 필요",
  highDeposit: "보증금 20%",
};

interface NoteFlagPattern {
  kind: NoteFlagKind;
  pattern: RegExp;
}

// 실측 텍스트(2026-09 기준 실데이터 389건)를 근거로 만든 패턴. 공백 편차(예: "대한  대항력",
// 이중 공백)를 흡수하기 위해 대항력 포기조건만 `\s*`를 둔다 — 나머지는 실측 문자열이 항상
// 붙어 있었다.
const NOTE_FLAG_PATTERNS: readonly NoteFlagPattern[] = [
  { kind: "bulkSale", pattern: /일괄매각/ },
  { kind: "waivedPriority", pattern: /대항력\s*포기조건/ },
  { kind: "shareSale", pattern: /지분매각/ },
  { kind: "illegalBuilding", pattern: /위반건축물/ },
  { kind: "farmlandCert", pattern: /농지취득자격증명/ },
  { kind: "highDeposit", pattern: /매수신청보증금\s*최저매각가격의\s*20%/ },
];

export type NoteFlagFields = Pick<AuctionItem, "note">;

/**
 * `note` 원문에서 매칭되는 유형을 전부(중복 없이, 패턴 정의 순서대로) 돌려준다. 값이
 * 없거나 빈 문자열이면 빈 배열 — "판정 불가"와 "유형 없음"을 화면에서 굳이 구분할
 * 필요가 없어(둘 다 배지를 안 그리면 된다) 하나로 합친다.
 */
export function detectNoteFlags({ note }: NoteFlagFields): NoteFlagKind[] {
  if (typeof note !== "string" || note.trim() === "") return [];
  return NOTE_FLAG_PATTERNS.filter(({ pattern }) => pattern.test(note)).map(({ kind }) => kind);
}
