import { describe, test, expect } from "vitest";
import { buildSearchQuery, buildKakaoMapUrl, buildNaverMapUrl } from "../map-links";

describe("map-links", () => {
  describe("buildSearchQuery", () => {
    test("빈 주소면 null 반환", () => {
      expect(buildSearchQuery("")).toBeNull();
      expect(buildSearchQuery(null)).toBeNull();
      expect(buildSearchQuery(undefined)).toBeNull();
    });

    test("괄호 내용 제거", () => {
      expect(buildSearchQuery("서울 서초구 서초동 123 (서초동, 래미안)")).toBe("서울 서초구 서초동 123");
    });

    test("쉼표 이후 내용 제거", () => {
      expect(buildSearchQuery("서울 서초구 서초동 123, 101동 202호")).toBe("서울 서초구 서초동 123");
    });

    test("외 n필지 제거", () => {
      expect(buildSearchQuery("서울 서초구 서초동 123 외 2필지")).toBe("서울 서초구 서초동 123");
    });

    test("lotNumber fallback", () => {
      expect(buildSearchQuery("", "서울 서초구 서초동 123-1")).toBe("서울 서초구 서초동 123-1");
    });
  });

  describe("URL builders", () => {
    test("buildKakaoMapUrl", () => {
      expect(buildKakaoMapUrl("서울 서초구 서초동 123")).toBe("https://map.kakao.com/link/search/%EC%84%9C%EC%9A%B8%20%EC%84%9C%EC%B4%88%EA%B5%AC%20%EC%84%9C%EC%B4%88%EB%8F%99%20123");
      expect(buildKakaoMapUrl("")).toBeNull();
    });

    test("buildNaverMapUrl", () => {
      expect(buildNaverMapUrl("서울 서초구 서초동 123")).toBe("https://map.naver.com/p/search/%EC%84%9C%EC%9A%B8%20%EC%84%9C%EC%B4%88%EA%B5%AC%20%EC%84%9C%EC%B4%88%EB%8F%99%20123");
      expect(buildNaverMapUrl("")).toBeNull();
    });
  });
});
