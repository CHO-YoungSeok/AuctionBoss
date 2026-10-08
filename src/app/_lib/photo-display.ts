import type { AuctionItem } from "@/lib/domain";

/**
 * 사진 표시 상태. `unavailable`은 DB에 저장하지 않고 상세 조회 식별자 유무로 **파생**한다
 * (fix-photo-worker-and-deploy-config design.md D6) — 저장하면 MySQL CHECK 제약도 바꿔야 하고,
 * 나중에 식별자가 채워졌을 때 되돌리는 규칙도 필요하다.
 */
export type PhotoDisplayState = "collected" | "empty" | "uncollected" | "failed" | "unavailable";

export function getPhotoDisplayState(item: Pick<AuctionItem, "photoStatus" | "internalCaseNo" | "courtCode">): PhotoDisplayState {
  // 저장된 결과(수집됨·사진 없음)가 우선이다.
  if (item.photoStatus === "collected" || item.photoStatus === "empty") {
    return item.photoStatus;
  }

  // 식별자가 없으면 조회할 수 없는 물건이다 — 실패나 대기로 보이면 안 된다. 옛 워커가
  // 키 없는 물건에 남긴 `failed`도 여기서 자동으로 unavailable이 된다.
  if (!item.internalCaseNo || !item.courtCode) {
    return "unavailable";
  }

  if (item.photoStatus === "failed") return "failed";
  return "uncollected";
}

export function getPhotoDisplayMessage(state: PhotoDisplayState): string {
  switch (state) {
    case "collected":
      return "";
    case "empty":
      return "법원 공고에 첨부된 사진이 없는 물건입니다";
    case "uncollected":
      return "사진 수집 대기 중입니다";
    case "failed":
      return "사진 수집 실패 (재시도 대기)";
    case "unavailable":
      return "사진 정보 없음(조회 불가)";
  }
}
