import { describe, it, expect } from "vitest";
import { getPhotoDisplayState, getPhotoDisplayMessage } from "../photo-display";

describe("photo-display", () => {
  it("식별자가 없고 상태도 없으면 unavailable (실패·대기가 아니다)", () => {
    expect(getPhotoDisplayState({})).toBe("unavailable");
    expect(getPhotoDisplayState({ photoStatus: "uncollected" })).toBe("unavailable");
    expect(getPhotoDisplayState({ internalCaseNo: "123", courtCode: null })).toBe("unavailable");
  });

  it("식별자가 없고 옛 워커가 남긴 failed 상태여도 unavailable로 보인다", () => {
    expect(getPhotoDisplayState({ photoStatus: "failed" })).toBe("unavailable");
    expect(getPhotoDisplayState({ internalCaseNo: null, courtCode: "A", photoStatus: "failed" })).toBe(
      "unavailable",
    );
  });

  it("식별자가 없어도 저장된 결과(collected·empty)가 우선한다", () => {
    expect(getPhotoDisplayState({ photoStatus: "collected" })).toBe("collected");
    expect(getPhotoDisplayState({ photoStatus: "empty" })).toBe("empty");
  });

  it("식별자가 있고 failed면 failed", () => {
    expect(getPhotoDisplayState({ internalCaseNo: "1", courtCode: "A", photoStatus: "failed" })).toBe(
      "failed",
    );
  });

  it("식별자가 있고 empty면 empty", () => {
    expect(getPhotoDisplayState({ internalCaseNo: "1", courtCode: "A", photoStatus: "empty" })).toBe(
      "empty",
    );
  });

  it("returns uncollected if status is missing or uncollected", () => {
    expect(getPhotoDisplayState({ internalCaseNo: "1", courtCode: "A" })).toBe("uncollected");
    expect(getPhotoDisplayState({ internalCaseNo: "1", courtCode: "A", photoStatus: "uncollected" })).toBe("uncollected");
  });

  it("returns collected if status is collected", () => {
    expect(getPhotoDisplayState({ internalCaseNo: "1", courtCode: "A", photoStatus: "collected" })).toBe("collected");
  });

  it("returns correct messages", () => {
    expect(getPhotoDisplayMessage("collected")).toBe("");
    expect(getPhotoDisplayMessage("empty")).toBe("법원 공고에 첨부된 사진이 없는 물건입니다");
    expect(getPhotoDisplayMessage("uncollected")).toBe("사진 수집 대기 중입니다");
    expect(getPhotoDisplayMessage("failed")).toBe("사진 수집 실패 (재시도 대기)");
    expect(getPhotoDisplayMessage("unavailable")).toBe("사진 정보 없음(조회 불가)");
  });
});
