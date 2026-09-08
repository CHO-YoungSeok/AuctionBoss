import { describe, expect, it } from "vitest";

import { EMPTY } from "../format";
import { formatRegionSummary } from "../region-summary";

describe("formatRegionSummary", () => {
  it("sido/sigungu/dong이 전부 있으면 이어붙인 요약을 반환한다", () => {
    expect(
      formatRegionSummary({
        sido: "서울특별시",
        sigungu: "강남구",
        dong: "역삼동",
        address: "서울특별시 강남구 역삼동 726-24",
      }),
    ).toBe("서울특별시 강남구 역삼동");
  });

  it("시/도만 있고 동이 없어도(부분 구조화) 있는 것만으로 요약한다", () => {
    expect(
      formatRegionSummary({
        sido: "서울특별시",
        sigungu: null,
        dong: null,
        address: "서울특별시 어딘가",
      }),
    ).toBe("서울특별시");
  });

  it("시/군/구만 있어도 요약한다", () => {
    expect(
      formatRegionSummary({ sido: null, sigungu: "강남구", dong: null, address: "강남구 어딘가" }),
    ).toBe("강남구");
  });

  it("구조화 값이 전부 없으면(이 기능 이전 수집분) 기존 address를 그대로 쓴다", () => {
    expect(
      formatRegionSummary({
        sido: null,
        sigungu: null,
        dong: null,
        address: "서울특별시 강남구 역삼동 726-24",
      }),
    ).toBe("서울특별시 강남구 역삼동 726-24");
  });

  it("구조화 값도 address도 전부 없으면 오류 없이 EMPTY", () => {
    expect(formatRegionSummary({ sido: null, sigungu: null, dong: null, address: null })).toBe(
      EMPTY,
    );
  });

  it("빈 문자열은 값 없음으로 취급한다", () => {
    expect(
      formatRegionSummary({ sido: "", sigungu: "  ", dong: null, address: "원본 주소" }),
    ).toBe("원본 주소");
  });
});
