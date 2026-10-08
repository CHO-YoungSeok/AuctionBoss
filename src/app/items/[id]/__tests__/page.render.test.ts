/**
 * 물건 상세 페이지(`page.tsx`)를 실제로 렌더링해 HTML을 검사하는 테스트
 * (hardening-round1 task 3, design.md D2).
 *
 * 이 프로젝트에는 지금까지 서버 컴포넌트를 실제로 렌더링하는 테스트가 하나도 없었다 —
 * "필드가 화면에 실제로 배선됐는가"가 타입 검사와 수동 curl에만 의존해 왔다(1번
 * 인수인계 항목이 실제로 그 결과였다: `AnalysisBody`가 만들어지고 테스트도 있었는데
 * 페이지에는 배선되지 않은 채로 한 사이클을 넘겼다).
 *
 * 8회차가 `AnalysisBody`(순수 컴포넌트, DB 의존 없음)를 `renderToStaticMarkup`으로
 * 테스트한 방식이 그대로 확장되는지 시험해 본 결과: **페이지 전체(async 서버 컴포넌트 +
 * 실제 DB 조회)까지는 확장된다.** 필요했던 것:
 *  - `getRepository()`가 읽는 DB 경로(`AUCTIONBOSS_DB`)를 테스트마다 새 임시 파일로
 *    돌려 끼우고, `closeDb()`로 싱글턴 캐시를 초기화한다(client.ts의 `getDb()`는 경로가
 *    바뀌면 자동으로 재연결하므로 이것만으로 충분하다 — 리포지토리 계층을 흉내 낼
 *    필요가 없다).
 *  - 페이지 함수는 `async function` + `params: Promise<...>`라 그냥 `await`로 직접
 *    호출하면 JSX 엘리먼트가 나온다. 여기에 `renderToStaticMarkup`을 씌우면 끝이다.
 *  - `notFound()`(next/navigation)는 Next 요청 컨텍스트 밖에서도 그냥 특정 에러를
 *    던진다 — try/catch로 잡아 "404 결과"로 확인할 수 있다.
 *
 * 비용은 실제로 있다: 임시 DB 파일 생성/정리, 시드 데이터 조립(확장 필드 다수)이
 * 순수 함수 테스트보다 무겁다. 그래도 "필드가 실제로 화면에 나오는가"는 이 계층에서만
 * 확인 가능한 사실이라(순수 함수는 문자열을 만들 뿐 그 문자열이 실제로 JSX 트리에
 * 들어갔는지는 보장하지 않는다) 최소 하나는 만들어 볼 가치가 있다고 판단했다 — 이번
 * 사이클의 task 1(AnalysisBody 배선 누락)이 정확히 그 gap의 실례다.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getRepository } from "@/lib/db";
import type { AuctionItemInput } from "@/lib/domain";

import ItemDetailPage from "../page";

let workDir: string;
let originalDbEnv: string | undefined;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "auctionboss-page-render-"));
  originalDbEnv = process.env.AUCTIONBOSS_DB;
  process.env.AUCTIONBOSS_DB = path.join(workDir, "test.db");
  closeDb(); // 이전 테스트(다른 파일 포함, 같은 워커 프로세스)의 캐시된 연결을 버린다.
});

afterEach(() => {
  closeDb();
  if (originalDbEnv === undefined) delete process.env.AUCTIONBOSS_DB;
  else process.env.AUCTIONBOSS_DB = originalDbEnv;
  rmSync(workDir, { recursive: true, force: true });
});

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

describe("물건 상세 페이지 렌더링 (hardening-round1 task 3)", () => {
  it("확장 필드와 분석 본문(굵게)이 실제 HTML에 나타난다", async () => {
    const repo = getRepository();
    repo.upsertItems([
      makeItem({
        minArea: 84,
        maxArea: 85,
        buildingDescription: "철근콘크리트구조\n84.99㎡",
        sido: "서울특별시",
        sigungu: "관악구",
      }),
    ]);
    const item = repo.getItemById(1)!;
    repo.insertAnalysis({
      itemId: item.id,
      body: "**요약 평가** — 정상 물건이다.",
      model: "claude-sonnet-5",
      promptVersion: "v3",
    });

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
    const repo = getRepository();
    repo.upsertItems([makeItem()]);
    const item = repo.getItemById(1)!;
    repo.insertAnalysis({
      itemId: item.id,
      body: "특이사항 — <script>alert(1)</script> 확인 필요.",
      model: null,
      promptVersion: "v3",
    });

    const html = await renderItemPage(String(item.id));

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("확장 필드·분석·이력이 전부 없는 물건(null 투성이)도 오류 없이 렌더되고 NaN/Infinity가 새지 않는다", async () => {
    const repo = getRepository();
    // 확장 필드는 전부 생략(옵셔널) — 이 change 이전 수집분을 흉내낸다.
    repo.upsertItems([
      makeItem({
        appraisalPrice: null,
        minBidPrice: null,
        auctionDate: null,
        failedBidCount: null,
        status: null,
      }),
    ]);
    const item = repo.getItemById(1)!;

    const html = await renderItemPage(String(item.id));

    expect(html).not.toContain("NaN");
    expect(html).not.toContain("Infinity");
    expect(html).not.toContain("undefined");
    expect(html).toContain("아직 변동이 없습니다");
  });

  it("존재하지 않는 id는 notFound()를 던진다(404)", async () => {
    // 물건을 하나도 저장하지 않은 빈 DB.
    getRepository();

    await expect(ItemDetailPage({ params: Promise.resolve({ id: "999999" }) })).rejects.toThrow(
      /NEXT_HTTP_ERROR_FALLBACK|NEXT_NOT_FOUND/,
    );
  });

  it("숫자가 아닌 id도 notFound()로 처리된다(Number('12abc')=NaN에 의존하지 않음)", async () => {
    getRepository();

    await expect(ItemDetailPage({ params: Promise.resolve({ id: "12abc" }) })).rejects.toThrow(
      /NEXT_HTTP_ERROR_FALLBACK|NEXT_NOT_FOUND/,
    );
  });
  it("이전 분석은 최근 10건만 본문으로 그리고 나머지는 건수로만 알린다(MAX_ANALYSES_FETCHED)", async () => {
    const repo = getRepository();
    repo.upsertItems([makeItem()]);
    const item = repo.getItemById(1)!;
    const total = 13;
    for (let n = 1; n <= total; n += 1) {
      repo.insertAnalysis({
        itemId: item.id,
        body: `[[BODY-${String(n).padStart(2, "0")}]]`,
        model: null,
        promptVersion: "v3",
      });
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
    const repo = getRepository();
    repo.upsertItems([makeItem()]);
    const item = repo.getItemById(1)!;
    for (let n = 1; n <= 11; n += 1) {
      repo.insertAnalysis({
        itemId: item.id,
        body: `[[BODY-${String(n).padStart(2, "0")}]]`,
        model: null,
        promptVersion: "v3",
      });
    }

    const html = await renderItemPage(String(item.id));

    for (let n = 1; n <= 11; n += 1) expect(html).toContain(`[[BODY-${String(n).padStart(2, "0")}]]`);
    expect(html).toContain("이전 분석 10건 보기");
    expect(html).not.toContain("표시하지 않습니다");
  });
});

describe("물건 상세 페이지 — 사진 표시 상태 (fix-photo-worker-and-deploy-config 4.1, D6)", () => {
  it("상세 조회 식별자가 없는 물건은 '사진 정보 없음(조회 불가)'로 보이고 실패·대기 문구는 없다", async () => {
    const repo = getRepository();
    repo.upsertItems([makeItem()]);
    const html = await renderItemPage("1");
    expect(html).toContain("사진 정보 없음(조회 불가)");
    expect(html).not.toContain("사진 수집 실패");
    expect(html).not.toContain("사진 수집 대기 중");
  });

  it("식별자가 있고 아직 시도하지 않은 물건은 '수집 대기 중'으로 보인다", async () => {
    const repo = getRepository();
    repo.upsertItems([makeItem({ internalCaseNo: "20250130001234", courtCode: "B000210" })]);
    const html = await renderItemPage("1");
    expect(html).toContain("사진 수집 대기 중입니다");
    expect(html).not.toContain("조회 불가");
  });
});

