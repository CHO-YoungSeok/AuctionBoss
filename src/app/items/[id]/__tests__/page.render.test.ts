/**
 * 물건 상세 페이지(`page.tsx`)를 실제로 렌더링해 HTML을 검사하는 테스트
 * (hardening-round1 task 3, design.md D2).
 *
 * 서버 컴포넌트를 실제로 렌더링해야만 "필드가 화면에 실제로 배선됐는가"를 확인할 수 있다 —
 * `AnalysisBody`가 만들어지고 테스트도 있었는데 페이지에는 배선되지 않은 채로 한 사이클을 넘긴
 * 실례가 있다. 페이지 함수는 `async function` + `params: Promise<...>`라 그냥 `await`로 호출하면
 * JSX 엘리먼트가 나오고, 여기에 `renderToStaticMarkup`을 씌운다. `notFound()`는 Next 요청 컨텍스트
 * 밖에서도 특정 에러를 던진다.
 *
 * 데이터는 백엔드 대역 `fetch`(Spring 원천)로 받는다(migrate-data-and-cutover 8.2).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AuctionItemInput } from "@/lib/domain";

import { useFakeBackend } from "@/lib/data-port/__tests__/fake-backend";
import ItemDetailPage from "../page";

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

async function renderItemPage(id: string): Promise<string> {
  const element = await ItemDetailPage({ params: Promise.resolve({ id }) });
  return renderToStaticMarkup(createElement(() => element));
}

describe("물건 상세 페이지 렌더링 (hardening-round1 task 3) [Spring 원천]", () => {
  const backend = useFakeBackend();

  it("확장 필드와 분석 본문(굵게)이 실제 HTML에 나타난다", async () => {
    const item = backend.addItem(
      makeItem({
        minArea: 84,
        maxArea: 85,
        buildingDescription: "철근콘크리트구조\n84.99㎡",
        sido: "서울특별시",
        sigungu: "관악구",
      }),
    );
    backend.addAnalysis(item.id, { body: "**요약 평가** — 정상 물건이다.", model: "claude-sonnet-5", promptVersion: "v3" });

    const html = await renderItemPage(String(item.id));

    // 확장 필드(면적)가 실제로 나온다 — item-extensions.ts가 만든 문자열이 JSX에 실제로
    // 꽂혔는지는 페이지를 렌더링해야만 확인된다.
    expect(html).toContain("84");
    // AnalysisBody가 배선돼 굵게가 실제 <strong> 태그로 나온다(task 1 회귀 방지 —
    // <pre>로 되돌아가면 이 태그 대신 리터럴 "**요약 평가**"가 나온다).
    expect(html).toContain("<strong>요약 평가</strong>");
    expect(html).not.toContain("**요약 평가**");
    expect(html).not.toContain("<pre");
  });

  it("<script> 페이로드가 분석 본문에 있어도 실행 가능한 태그로 나오지 않는다", async () => {
    const item = backend.addItem(makeItem());
    backend.addAnalysis(item.id, { body: "특이사항 — <script>alert(1)</script> 확인 필요.", promptVersion: "v3" });

    const html = await renderItemPage(String(item.id));

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("확장 필드·분석·이력이 전부 없는 물건(null 투성이)도 오류 없이 렌더되고 NaN/Infinity가 새지 않는다", async () => {
    // 확장 필드는 전부 생략(옵셔널) — 이 change 이전 수집분을 흉내낸다.
    const item = backend.addItem(
      makeItem({
        appraisalPrice: null,
        minBidPrice: null,
        auctionDate: null,
        failedBidCount: null,
        status: null,
      }),
    );

    const html = await renderItemPage(String(item.id));

    expect(html).not.toContain("NaN");
    expect(html).not.toContain("Infinity");
    expect(html).not.toContain("undefined");
    expect(html).toContain("아직 변동이 없습니다");
  });

  it("존재하지 않는 id는 notFound()를 던진다(404)", async () => {
    // 물건을 하나도 저장하지 않은 빈 백엔드.
    await expect(ItemDetailPage({ params: Promise.resolve({ id: "999999" }) })).rejects.toThrow(
      /NEXT_HTTP_ERROR_FALLBACK|NEXT_NOT_FOUND/,
    );
  });

  it("숫자가 아닌 id도 notFound()로 처리된다(Number('12abc')=NaN에 의존하지 않음)", async () => {
    await expect(ItemDetailPage({ params: Promise.resolve({ id: "12abc" }) })).rejects.toThrow(
      /NEXT_HTTP_ERROR_FALLBACK|NEXT_NOT_FOUND/,
    );
  });

  it("이전 분석은 최근 10건만 본문으로 그리고 나머지는 건수로만 알린다(MAX_ANALYSES_FETCHED)", async () => {
    const item = backend.addItem(makeItem());
    const total = 13;
    for (let n = 1; n <= total; n += 1) {
      backend.addAnalysis(item.id, { body: `[[BODY-${String(n).padStart(2, "0")}]]`, promptVersion: "v3" });
    }

    const html = await renderItemPage(String(item.id));
    const bodyTag = (n: number) => `[[BODY-${String(n).padStart(2, "0")}]]`;

    // 최신 1건 + 이전 10건(12..03)만 본문으로 나온다.
    for (let n = 3; n <= total; n += 1) expect(html).toContain(bodyTag(n));
    // 가장 오래된 2건(01, 02)은 본문이 렌더되지 않는다.
    expect(html).not.toContain(bodyTag(1));
    expect(html).not.toContain(bodyTag(2));
    // 표제는 잘리지 않은 실제 전체 건수, 숨긴 건수는 별도 안내.
    expect(html).toContain("이전 분석 12건 보기");
    expect(html).toContain("그 외 2건은 표시하지 않습니다(최근 10건만");
  });

  it("이전 분석이 10건 이하면 숨김 안내 없이 전부 본문으로 나온다", async () => {
    const item = backend.addItem(makeItem());
    for (let n = 1; n <= 11; n += 1) {
      backend.addAnalysis(item.id, { body: `[[BODY-${String(n).padStart(2, "0")}]]`, promptVersion: "v3" });
    }

    const html = await renderItemPage(String(item.id));

    for (let n = 1; n <= 11; n += 1) expect(html).toContain(`[[BODY-${String(n).padStart(2, "0")}]]`);
    expect(html).toContain("이전 분석 10건 보기");
    expect(html).not.toContain("표시하지 않습니다");
  });
});

describe("물건 상세 페이지 — 사진 표시 상태 (fix-photo-worker-and-deploy-config 4.1, D6) [Spring 원천]", () => {
  const backend = useFakeBackend();

  it("상세 조회 식별자가 없는 물건은 '사진 정보 없음(조회 불가)'로 보이고 실패·대기 문구는 없다", async () => {
    backend.addItem(makeItem());
    const html = await renderItemPage("1");
    expect(html).toContain("사진 정보 없음(조회 불가)");
    expect(html).not.toContain("사진 수집 실패");
    expect(html).not.toContain("사진 수집 대기 중");
  });

  it("식별자가 있고 아직 시도하지 않은 물건은 '수집 대기 중'으로 보인다", async () => {
    backend.addItem(makeItem({ internalCaseNo: "20250130001234", courtCode: "B000210" }));
    const html = await renderItemPage("1");
    expect(html).toContain("사진 수집 대기 중입니다");
    expect(html).not.toContain("조회 불가");
  });

  it("사진이 수집된 물건은 사진 목록을 백엔드에서 받아 순번마다 <img>를 그린다(회귀 방어)", async () => {
    const item = backend.addItem(
      makeItem({ internalCaseNo: "20250130001234", courtCode: "B000210" }),
      { photoStatus: "collected", photoCount: 2 },
    );
    backend.addPhoto(item.id, 1);
    backend.addPhoto(item.id, 2);

    const html = await renderItemPage(String(item.id));

    expect(html).toContain(`src="/api/photos/${item.id}/1"`);
    expect(html).toContain(`src="/api/photos/${item.id}/2"`);
    expect(backend.requests.map((r) => `${r.method} ${r.path}`)).toContain("GET /api/items/{id}/photos");
  });

  it("사진이 없다고 확정된(empty) 물건은 사진 목록 요청을 보내지 않고 <img>도 없다", async () => {
    const item = backend.addItem(
      makeItem({ internalCaseNo: "20250130001234", courtCode: "B000210" }),
      { photoStatus: "empty" },
    );

    const html = await renderItemPage(String(item.id));

    expect(html).toContain("법원 공고에 첨부된 사진이 없는 물건입니다");
    expect(html).not.toContain("<img");
    expect(backend.requests.map((r) => `${r.method} ${r.path}`)).not.toContain("GET /api/items/{id}/photos");
  });
});
