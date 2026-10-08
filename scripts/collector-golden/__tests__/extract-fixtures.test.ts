import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { FIXTURES_DIR, renderFixtureFiles } from "../extract-fixtures";
import { MASK } from "../../seed/masking";
import { NAME_FIELDS, buildFixtureSet, loadRawFixtures } from "../fixtures";
import * as tsFixtures from "../../../src/lib/sources/courtauction/__tests__/fixtures";

const readJson = (name: string) => JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), "utf8")) as Record<string, unknown>;

/** 테스트 전용 가상 이름. 실제 이름이 아니다. */
const FAKE_JUDGE = "가상판사";
const FAKE_TENANT = "가상임차";

describe("픽스처 추출 (1.3)", () => {
  it("(a) 추출 JSON을 다시 읽으면 원본 TS 픽스처와 같은 값이다(가림 필드 제외)", () => {
    const search = readJson("search-rows.json");
    expect(search.realRow).toEqual(tsFixtures.REAL_ROW);
    expect(search.bundleRows).toEqual(tsFixtures.BUNDLE_ROWS);
    expect(search.roadOnlyRow).toEqual(tsFixtures.ROAD_ONLY_ROW);
    expect(search.noExtendedFieldsRow).toEqual(tsFixtures.NO_EXTENDED_FIELDS_ROW);
    expect(search.missingKeyRow).toEqual(tsFixtures.MISSING_KEY_ROW);

    const detail = readJson("detail-response.json");
    const expectedBase: Record<string, unknown> = { ...tsFixtures.REAL_DETAIL_BASE_INFO };
    for (const f of NAME_FIELDS) if (typeof expectedBase[f] === "string" && expectedBase[f] !== "") expectedBase[f] = MASK;
    expect(detail.baseInfo).toEqual(expectedBase);
    expect(detail.pics).toEqual(tsFixtures.REAL_DETAIL_PICS);

    const bodies = readJson("bodies.json");
    expect(bodies).toEqual({
      robotBlocked: tsFixtures.ROBOT_BLOCKED_BODY,
      wafBlocked: tsFixtures.WAF_BLOCKED_BODY,
      schemaViolation: tsFixtures.SCHEMA_VIOLATION_BODY,
      missingPageInfo: tsFixtures.MISSING_PAGE_INFO_BODY,
      detailSchemaViolation: tsFixtures.DETAIL_SCHEMA_VIOLATION_BODY,
      detailMissingResult: tsFixtures.DETAIL_MISSING_RESULT_BODY,
    });
  });

  it("커밋된 JSON이 현재 생성 결과와 바이트까지 같다", () => {
    for (const [name, content] of renderFixtureFiles()) {
      expect(readFileSync(path.join(FIXTURES_DIR, name), "utf8"), name).toBe(content);
    }
  });

  it("(b) 가림 대상 필드에 원문이 남지 않는다", () => {
    const raw = loadRawFixtures();
    raw.detailBaseInfo.jdgeAojAsstnNm = FAKE_JUDGE;
    raw.realRow.mulBigo = `임차인 ${FAKE_TENANT} 보증금 1000만원, ${FAKE_TENANT}의 임차보증금 확인`;
    raw.bundleRows[0].mulBigo = `소유자 ${FAKE_TENANT}`;

    const files = [...renderFixtureFiles(buildFixtureSet(raw)).values()].join("\n");
    expect(files).not.toContain(FAKE_JUDGE);
    expect(files).not.toContain(FAKE_TENANT);
    expect(files).toContain(MASK);
    const set = buildFixtureSet(raw);
    expect(set.detailResponse.baseInfo.jdgeAojAsstnNm).toBe(MASK);
  });

  it("커밋된 추출 파일의 이름 필드에는 값이 있으면 가림 표기뿐이다", () => {
    const base = readJson("detail-response.json").baseInfo as Record<string, unknown>;
    for (const f of NAME_FIELDS) {
      expect(base[f] === null || base[f] === MASK, f).toBe(true);
    }
  });
});
