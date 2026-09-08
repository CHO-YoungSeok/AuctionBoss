import { describe, expect, it } from "vitest";

import { NOTE_FLAG_LABELS, detectNoteFlags, type NoteFlagKind } from "../note-flags";

describe("detectNoteFlags", () => {
  it("값이 없으면 빈 배열", () => {
    expect(detectNoteFlags({ note: null })).toEqual([]);
    expect(detectNoteFlags({ note: undefined })).toEqual([]);
  });

  it("빈 문자열이면 빈 배열", () => {
    expect(detectNoteFlags({ note: "" })).toEqual([]);
    expect(detectNoteFlags({ note: "   " })).toEqual([]);
  });

  it("패턴에 안 걸리는 비고는 빈 배열(미탐 가능성, design.md D4)", () => {
    expect(detectNoteFlags({ note: "특이사항 없음" })).toEqual([]);
  });

  // 실데이터 문자열(2026-09 실측, id 3/5/6/7 등) 그대로 검증한다.
  it("일괄매각 — 실측 문자열", () => {
    expect(detectNoteFlags({ note: "일괄매각. 제시외 건물 포함" })).toContain("bulkSale");
    expect(detectNoteFlags({ note: "일괄매각" })).toContain("bulkSale");
  });

  it("대항력 포기조건 — 실측 문자열(단일/이중 공백 둘 다)", () => {
    expect(
      detectNoteFlags({
        note: "임차보증금반환채권승계인 주택도시보증공사의 매수인에 대한 대항력 포기조건 매각",
      }),
    ).toContain("waivedPriority");
    expect(
      detectNoteFlags({
        note: "임차인 및 임차보증금반환채권승계인 주택도시보증공사의 매수인에 대한  대항력 포기조건 매각",
      }),
    ).toContain("waivedPriority");
  });

  it("'대항력및우선변제권 승계'는 포기조건이 아니므로 걸리지 않는다(오탐 방지)", () => {
    expect(
      detectNoteFlags({
        note: "주택도시보증공사(임차인 문서준) : 경매신청채권자로 임차인 문서준의 임차보증금반환채권 양수인임(대항력및우선변제권 승계)",
      }),
    ).not.toContain("waivedPriority");
  });

  it("지분매각 — 실측 문자열(id 84/206/314)", () => {
    expect(detectNoteFlags({ note: "지분매각" })).toContain("shareSale");
    expect(
      detectNoteFlags({
        note: "지분매각, 공유자우선매수는 1회에 한하여 행사할 수 있음",
      }),
    ).toContain("shareSale");
  });

  it("'지분경매'는 '지분매각'과 다른 문구이므로 걸리지 않는다(실측된 패턴만 판정)", () => {
    expect(detectNoteFlags({ note: "지분경매" })).not.toContain("shareSale");
  });

  it("위반건축물 — 따옴표로 감싼 실측 문자열도 매칭된다(id 189/343/361)", () => {
    expect(detectNoteFlags({ note: "건축물대장상 '위반건축물' 등재" })).toContain(
      "illegalBuilding",
    );
    expect(detectNoteFlags({ note: "건축물대장상 위반건축물 등재" })).toContain(
      "illegalBuilding",
    );
  });

  it("농지취득자격증명 — 실측 문자열(id 84)", () => {
    expect(
      detectNoteFlags({
        note: "농지취득자격증명 제출 필요(매각결정기일까지 미제출시 보증금은 반환하지 않음)",
      }),
    ).toContain("farmlandCert");
  });

  it("보증금 20% — 실측 문자열(id 8/20/21/22)", () => {
    expect(
      detectNoteFlags({ note: "특별매각조건 매수신청보증금 최저매각가격의 20%" }),
    ).toContain("highDeposit");
    expect(detectNoteFlags({ note: "매수신청보증금 최저매각가격의 20%" })).toContain(
      "highDeposit",
    );
  });

  it("날짜 문자열의 '20'은 보증금 20%로 오탐하지 않는다", () => {
    expect(
      detectNoteFlags({
        note: "주택도시보증공사가 신청채권자이고 확약서를 제출함(2026.05.11.자)",
      }),
    ).not.toContain("highDeposit");
  });

  it("한 note에 여러 유형이 동시에 걸릴 수 있다 — 배타적이지 않다(id 177 패턴)", () => {
    const flags = detectNoteFlags({
      note: "일괄매각. 제시외 건물 포함\n건축물대장상 위반건축물 등재",
    });
    expect(flags).toContain("bulkSale");
    expect(flags).toContain("illegalBuilding");
  });

  it("모든 유형에 라벨이 있다", () => {
    const kinds: NoteFlagKind[] = [
      "bulkSale",
      "waivedPriority",
      "shareSale",
      "illegalBuilding",
      "farmlandCert",
      "highDeposit",
    ];
    for (const kind of kinds) {
      expect(NOTE_FLAG_LABELS[kind]).toEqual(expect.any(String));
      expect(NOTE_FLAG_LABELS[kind].length).toBeGreaterThan(0);
    }
  });
});
