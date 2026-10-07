import { describe, expect, it } from "vitest";
import { extractPersonNames, findSuspiciousPhrases, maskNames } from "../masking";

const NOTE_ASSIGNEE = "신청채권자는 고은하의 임차보증금반환 채권을 양수한 자임";
const NOTE_TENANT = "- 임차인 서지훈은 경매신청채권자로 배당요구를 함";
const INSTITUTION_NOTES = [
  "임차권자 한국토지주택공사의 임차보증금반환채권 양수인임",
  "임차인 및 임차보증금반환채권승계인 주택도시보증공사의 배당요구",
  "신청채권자는 서울보증보험주식회사의 임차보증금반환채권을 양수한 자임",
  "임차인 서울보증보험(주)은 경매신청채권자로",
];

describe("extractPersonNames", () => {
  it("'<이름>의 임차보증금' 문형에서 이름을 뽑는다", () => {
    expect(extractPersonNames(NOTE_ASSIGNEE)).toEqual(["고은하"]);
  });

  it("'임차인 <이름>은' 문형에서 조사를 떼고 이름을 뽑는다", () => {
    expect(extractPersonNames(NOTE_TENANT)).toEqual(["서지훈"]);
  });

  it("채무자/소유자 문형에서도 뽑는다", () => {
    expect(extractPersonNames("채무자 홍길동 소유 부동산, 소유자 김철수는 미납")).toEqual([
      "홍길동",
      "김철수",
    ]);
  });

  it("기관명이 들어간 문장에서는 아무것도 뽑지 않는다", () => {
    for (const note of INSTITUTION_NOTES) {
      expect(extractPersonNames(note), note).toEqual([]);
    }
  });

  // 회귀 방지: 2~4자 후보만 보고 기관 여부를 판정하면 `신한은행은`에서 `신한`을 이름으로
  // 오인했다. 아래 사례는 isInstitution 판정이나 조사 제거를 망가뜨리면 실패해야 한다.
  it("4자 이하로 시작하는 짧은 기관명에서 앞부분을 이름으로 뽑지 않는다", () => {
    expect(extractPersonNames("임차인 신한은행은 배당요구를 함")).toEqual([]);
    expect(extractPersonNames("채무자 우리은행 소유 부동산")).toEqual([]);
    expect(extractPersonNames("소유자 농협조합의 지분")).toEqual([]);
    expect(extractPersonNames("신청채권자는 주택공사의 임차보증금반환 채권을 양수함")).toEqual([]);
  });

  it("짧은 기관명이 섞인 비고를 가려도 기관명은 그대로 남는다", () => {
    const note = "임차인 신한은행은 배당요구, 임차인 홍길동은 대항력 있음";
    const masked = maskNames(note, extractPersonNames(note));
    expect(masked).toContain("신한은행");
    expect(masked).not.toContain("홍길동");
  });

  it("조사 이/가/는/의를 떼고 이름을 뽑는다", () => {
    expect(extractPersonNames("임차인 홍길동이 점유 중")).toEqual(["홍길동"]);
    expect(extractPersonNames("임차인 김철수가 배당요구")).toEqual(["김철수"]);
    expect(extractPersonNames("임차인 이영희는 전입")).toEqual(["이영희"]);
    expect(extractPersonNames("임차인 박민수의 보증금")).toEqual(["박민수"]);
  });

  it("3자 이름 끝 글자가 조사와 같아도 자르지 않는다", () => {
    expect(extractPersonNames("임차인 김가은 전입")).toEqual(["김가은"]);
    expect(extractPersonNames("임차인 김가은은 전입")).toEqual(["김가은"]);
  });

  it("'임차인 및 ...'에서 '및'을 이름으로 뽑지 않는다", () => {
    expect(extractPersonNames("임차인 및 임차보증금반환채권승계인 주택도시보증공사의")).toEqual([]);
  });

  it("중복 이름은 한 번만 돌려준다", () => {
    expect(extractPersonNames("임차인 서지훈은 ... 서지훈의 임차보증금")).toEqual(["서지훈"]);
  });
});

describe("maskNames", () => {
  it("이름 전체를 글자 수와 무관하게 ○○○로 바꾼다", () => {
    expect(maskNames(NOTE_ASSIGNEE, ["고은하"])).toBe(
      "신청채권자는 ○○○의 임차보증금반환 채권을 양수한 자임",
    );
    expect(maskNames("남궁민수 와 이수", ["남궁민수", "이수"])).toBe("○○○ 와 ○○○");
  });

  it("분석 본문에 같은 이름이 여러 번 나와도 전부 가린다", () => {
    const body = "비고에 따르면 서지훈은 임차인이다. 서지훈의 보증금은 회수 가능성이 낮다.\n서지훈 주의.";
    const masked = maskNames(body, ["서지훈"]);
    expect(masked).not.toContain("서지훈");
    expect(masked.split("○○○")).toHaveLength(4);
  });

  it("기관명은 건드리지 않는다", () => {
    const note = INSTITUTION_NOTES[0];
    expect(maskNames(note, extractPersonNames(note))).toBe(note);
  });
});

describe("findSuspiciousPhrases", () => {
  it("가림 전에는 의심 문구가 있고, 가림 후에는 비어 있다", () => {
    for (const note of [NOTE_ASSIGNEE, NOTE_TENANT]) {
      expect(findSuspiciousPhrases(note).length).toBeGreaterThan(0);
      const masked = maskNames(note, extractPersonNames(note));
      expect(findSuspiciousPhrases(masked), masked).toEqual([]);
    }
  });

  it("기관명 문장은 의심하지 않는다", () => {
    for (const note of INSTITUTION_NOTES) {
      expect(findSuspiciousPhrases(note), note).toEqual([]);
    }
  });
});

describe("괄호 안 이름", () => {
  it("'(임차인 <이름>)' 형태도 뽑아 가린다", () => {
    const note = "한국주택금융공사(임차인 윤다솜) : 경매신청채권자로, (양도전:임차인 장하늘)로부터";
    const names = extractPersonNames(note);
    expect(names).toEqual(["윤다솜", "장하늘"]);
    expect(findSuspiciousPhrases(maskNames(note, names))).toEqual([]);
  });
});
