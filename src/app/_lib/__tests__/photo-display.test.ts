import { describe, it, expect } from "vitest";
import { getPhotoDisplayState, getPhotoDisplayMessage } from "../photo-display";

describe("photo-display", () => {
  it("returns failed if identifiers are missing", () => {
    expect(getPhotoDisplayState({ photoStatus: "uncollected" })).toBe("failed");
    expect(getPhotoDisplayState({ internalCaseNo: "123", courtCode: null })).toBe("failed");
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
  });
});
