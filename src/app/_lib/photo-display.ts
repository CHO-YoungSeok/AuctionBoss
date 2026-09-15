import type { AuctionItem } from "@/lib/domain";

export type PhotoDisplayState = "collected" | "empty" | "uncollected" | "failed";

export function getPhotoDisplayState(item: Pick<AuctionItem, "photoStatus" | "internalCaseNo" | "courtCode">): PhotoDisplayState {
  if (!item.internalCaseNo || !item.courtCode) {
    return "failed"; // 상세 식별자가 없으면 수집 자체가 불가능하므로 실패 취급
  }
  
  if (!item.photoStatus || item.photoStatus === "uncollected") {
    return "uncollected";
  }
  
  return item.photoStatus;
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
  }
}
