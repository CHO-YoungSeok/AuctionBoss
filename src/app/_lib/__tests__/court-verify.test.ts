import { describe, expect, it } from "vitest";

import { COURT_AUCTION_HOME_URL, buildCourtVerifyLink } from "../court-verify";

describe("buildCourtVerifyLink", () => {
  it("법원명·사건번호를 그대로 담는다", () => {
    const result = buildCourtVerifyLink({ court: "서울중앙지방법원", caseNo: "2025타경12345" });
    expect(result.court).toBe("서울중앙지방법원");
    expect(result.caseNo).toBe("2025타경12345");
  });

  it("homeUrl은 물건과 무관하게 항상 같은 고정 URL이다 — 딥링크를 만들지 않는다(design.md D2, tasks.md 4.2)", () => {
    const a = buildCourtVerifyLink({ court: "서울중앙지방법원", caseNo: "2025타경11111" });
    const b = buildCourtVerifyLink({ court: "부산지방법원", caseNo: "2026타경99999" });
    expect(a.homeUrl).toBe(COURT_AUCTION_HOME_URL);
    expect(b.homeUrl).toBe(COURT_AUCTION_HOME_URL);
    expect(a.homeUrl).toBe(b.homeUrl);
  });

  it("homeUrl에 쿼리 문자열·물건 식별자가 섞여 들어가지 않는다 — w2xPath/csNo 딥링크 금지", () => {
    const result = buildCourtVerifyLink({ court: "서울중앙지방법원", caseNo: "2025타경12345" });
    expect(result.homeUrl).not.toContain("?");
    expect(result.homeUrl).not.toContain("w2xPath");
    expect(result.homeUrl).not.toContain("csNo");
    expect(result.homeUrl).not.toContain(result.caseNo);
    expect(result.homeUrl).not.toContain(result.court);
  });
});
