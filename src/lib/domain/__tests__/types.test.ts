import { describe, expect, it } from "vitest";

import { WATCHED_FIELDS } from "../types";

describe("WATCHED_FIELDS", () => {
  it("정확히 이 4개 필드만 감시 대상이다 — 늘리지 말 것 (design.md D2)", () => {
    // 이 목록을 넓히면(예: 확장 필드인 minBidPriceRound1, buildingDescription 등을 추가) 무슨 일이
    // 일어나는지가 이 테스트가 실패로 막으려는 회귀다:
    //
    // 1. 확장 필드는 이 change 이전에 수집된 물건에서는 전부 NULL이다. 새 필드를 감시 대상에
    //    넣으면, 다음 수집 때 그 필드에 값이 채워지는 순간 "null → 값"이 되고, 이는
    //    `detectWatchedChanges`가 이미 "실제 변경"으로 취급하는 패턴이다(2회차에서 확인된
    //    baseline vs change 구별 규칙 — README §6.1, `oldValue === null`이라고 baseline인
    //    것은 아니다).
    // 2. 그 결과 이미 저장된 물건 "전체"가 다음 수집 한 번에 "변경됨"으로 기록된다.
    //    `item_changes`에는 물건 수 × (늘어난 필드 수)만큼의 행이 한꺼번에 쌓인다.
    // 3. 그 물건들은 전부 재분석 후보(needsAnalysis 조건 2: 감시 필드 변경)가 된다 —
    //    이는 이 change가 PROMPT_VERSION을 v2로 올려서 이미 유발하고 있는 "전체 재분석"
    //    (조건 3)과 겹쳐 이중으로 재분석을 유발한다. 두 원인이 겹치면 재분석 대기열이
    //    필요 이상으로 부풀고, maxReanalysisPerRun/reanalysisCooldownHours로 속도만 제한될 뿐
    //    총 Claude 호출 비용은 그대로 늘어난다(design.md D2, D5).
    //
    // 감시 대상을 늘리는 것은 "실제로 의미 있는 변화인가"를 실데이터로 관찰한 뒤 내리는
    // 별도의 판단이어야 한다(design.md D2 Open Questions) — 무심코 넓히면 이 테스트가
    // 실패해서 그 판단을 강제로 거치게 한다.
    expect(WATCHED_FIELDS).toEqual(["minBidPrice", "failedBidCount", "auctionDate", "status"]);
    expect(WATCHED_FIELDS.length).toBe(4);
  });
});
