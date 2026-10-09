/**
 * 물건 목록 페이지(`page.tsx`)를 실제로 렌더링해 HTML을 검사하는 테스트
 * (hardening-round1 task 3, design.md D2). 데이터는 백엔드 대역 `fetch`(Spring 원천)로 받는다
 * (migrate-data-and-cutover 8.2).
 *
 * 목록 페이지 고유의 위험(design.md D3 "예외 경로")에 집중한다: 빈 DB와 "필터에 걸리는
 * 게 없음"을 구분하는 안내 문구, 역전된 면적이 오류 없이 나오는지, NaN/Infinity가
 * 새지 않는지.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AuctionItemInput } from "@/lib/domain";

import { useFakeBackend } from "@/lib/data-port/__tests__/fake-backend";
import ItemListPage from "../page";

function makeItem(overrides: Partial<AuctionItemInput> = {}): AuctionItemInput {
  return {
    court: "서울중앙지방법원",
    caseNo: "2025타경12345",
    itemNo: "1",
    address: "서울특별시 관악구 봉천동 1-1",
    usageType: "아파트",
    appraisalPrice: 500_000_000,
    minBidPrice: 320_000_000,
    auctionDate: "2026-10-15",
    failedBidCount: 2,
    status: "유찰 2회",
    ...overrides,
  };
}

async function renderListPage(
  searchParams: Record<string, string | string[] | undefined> = {},
): Promise<string> {
  const element = await ItemListPage({ searchParams: Promise.resolve(searchParams) });
  return renderToStaticMarkup(createElement(() => element));
}

describe("물건 목록 페이지 렌더링 (hardening-round1 task 3) [Spring 원천]", () => {
  const backend = useFakeBackend();

  it("DB가 완전히 비었으면 '아직 수집된 물건이 없습니다'를 보여준다(필터 안내와 구분)", async () => {
    const html = await renderListPage();

    expect(html).toContain("아직 수집된 물건이 없습니다");
    expect(html).not.toContain("조건에 맞는 물건이 없습니다");
  });

  it("물건은 있지만 필터에 맞는 게 없으면 '조건에 맞는 물건이 없습니다'와 초기화 링크를 보여준다", async () => {
    backend.addItem(makeItem({ usageType: "아파트" }));

    const html = await renderListPage({ usage: "존재하지않는용도" });

    expect(html).toContain("조건에 맞는 물건이 없습니다");
    expect(html).toContain("필터 초기화");
    expect(html).not.toContain("아직 수집된 물건이 없습니다");
  });

  it("역전된 면적(min > max)도 오류 없이 렌더되고 NaN/Infinity/undefined가 새지 않는다", async () => {
    backend.addItem(
      makeItem({
        minArea: 100,
        maxArea: 10, // 역전 — 실데이터에도 존재(open-questions 대상).
        appraisalPrice: 0, // 저감률 계산이 나눗셈을 만나는 경계.
        minBidPrice: null,
      }),
    );

    const html = await renderListPage();

    expect(html).not.toContain("NaN");
    expect(html).not.toContain("Infinity");
    expect(html).not.toContain("undefined");
    // 면적 두 값 다 화면에 나온다 — 어느 한쪽을 숨기지 않는다(design.md D1: "지표를
    // 계산할 수 없는 물건"이라도 원본 값은 보여준다는 원칙과 같은 맥락).
    expect(html).toContain("100");
    expect(html).toContain("10");
  });

  it("확장 필드(면적당 가격)가 목록 행에 실제로 나타난다", async () => {
    backend.addItem(makeItem({ minArea: 84, maxArea: 84 }));

    const html = await renderListPage();

    expect(html).toContain("면적당 가격");
    expect(html).toMatch(/원\/㎡/);
  });

  it("워커 전용 쿼리(needsAnalysis·promptVersion)가 URL에 와도 500 없이 렌더된다", async () => {
    // 3단계에서 직렬화가 이 필드를 던지게 바뀌었다 — 화면 링크가 먼저 걸러야 한다.
    const html = await renderListPage({ needsAnalysis: "true", promptVersion: "v1" });
    expect(html.length).toBeGreaterThan(0);
  });
});
