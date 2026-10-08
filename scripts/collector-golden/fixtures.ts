/**
 * 소스 어댑터 골든의 입력 픽스처 (port-collector-to-spring D5).
 *
 * TS 어댑터 테스트의 픽스처 모듈을 읽어 가림 규칙을 적용한 값을 돌려준다. 추출 스크립트(1.3)와
 * 어댑터 골든 생성기(1.4)가 같은 값을 쓰므로 Java 테스트도 가림 처리된 입력만 본다.
 * 입력이 같으면 TS와 Java의 동등성 비교에는 영향이 없다.
 *
 * 가림 규칙(scripts/seed/masking.ts와 같은 표기 `○○○`):
 *  - 상세 응답 `csBaseInfo`의 사람 이름 필드(`NAME_FIELDS`): 값이 있으면 통째로 가림 표기.
 *  - 검색 응답 행의 비고(`mulBigo`): `extractPersonNames`로 찾은 이름을 `maskNames`로 가린다.
 */
import { MASK, extractPersonNames, maskNames } from "../seed/masking";

import {
  BUNDLE_ROWS,
  DETAIL_MISSING_RESULT_BODY,
  DETAIL_SCHEMA_VIOLATION_BODY,
  MISSING_KEY_ROW,
  MISSING_PAGE_INFO_BODY,
  NO_EXTENDED_FIELDS_ROW,
  REAL_DETAIL_BASE_INFO,
  REAL_DETAIL_PICS,
  REAL_ROW,
  ROAD_ONLY_ROW,
  ROBOT_BLOCKED_BODY,
  SCHEMA_VIOLATION_BODY,
  WAF_BLOCKED_BODY,
} from "../../src/lib/sources/courtauction/__tests__/fixtures";

/** 상세 응답 `csBaseInfo` 중 사람 이름이 들어갈 수 있는 필드(판사/사법보좌관 명). */
export const NAME_FIELDS = ["jdgeAojAsstnNm"] as const;

type Json = Record<string, unknown>;

export interface RawFixtures {
  realRow: Json;
  bundleRows: Json[];
  roadOnlyRow: Json;
  noExtendedFieldsRow: Json;
  missingKeyRow: Json;
  detailBaseInfo: Json;
  detailPics: Json[];
  bodies: {
    robotBlocked: string;
    wafBlocked: string;
    schemaViolation: string;
    missingPageInfo: string;
    detailSchemaViolation: string;
    detailMissingResult: string;
  };
}

/** 가림이 끝난 픽스처. 추출 JSON 파일의 내용과 같은 모양이다. */
export interface FixtureSet {
  searchRows: {
    realRow: Json;
    bundleRows: Json[];
    roadOnlyRow: Json;
    noExtendedFieldsRow: Json;
    missingKeyRow: Json;
  };
  detailResponse: { baseInfo: Json; pics: Json[] };
  bodies: RawFixtures["bodies"];
}

/** TS 어댑터 테스트가 쓰는 픽스처 원본(값 변형 없음). 깊은 복사본이라 호출자가 고쳐도 원본에 영향이 없다. */
export function loadRawFixtures(): RawFixtures {
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  return {
    realRow: clone(REAL_ROW),
    bundleRows: clone(BUNDLE_ROWS),
    roadOnlyRow: clone(ROAD_ONLY_ROW),
    noExtendedFieldsRow: clone(NO_EXTENDED_FIELDS_ROW),
    missingKeyRow: clone(MISSING_KEY_ROW),
    detailBaseInfo: clone(REAL_DETAIL_BASE_INFO),
    detailPics: clone(REAL_DETAIL_PICS) as unknown as Json[],
    bodies: {
      robotBlocked: ROBOT_BLOCKED_BODY,
      wafBlocked: WAF_BLOCKED_BODY,
      schemaViolation: SCHEMA_VIOLATION_BODY,
      missingPageInfo: MISSING_PAGE_INFO_BODY,
      detailSchemaViolation: DETAIL_SCHEMA_VIOLATION_BODY,
      detailMissingResult: DETAIL_MISSING_RESULT_BODY,
    },
  };
}

/** 검색 행 하나의 가림. 비고(`mulBigo`)만 본다. */
export function maskSearchRow(row: Json): Json {
  const out = { ...row };
  const note = out.mulBigo;
  if (typeof note === "string" && note !== "") out.mulBigo = maskNames(note, extractPersonNames(note));
  return out;
}

/** 상세 응답 기본정보의 가림. 이름 필드에 값이 있으면 통째로 가림 표기로 바꾼다. */
export function maskDetailBaseInfo(info: Json): Json {
  const out = { ...info };
  for (const field of NAME_FIELDS) {
    if (typeof out[field] === "string" && out[field] !== "") out[field] = MASK;
  }
  return out;
}

/** 가림을 적용한 픽스처 묶음. */
export function buildFixtureSet(raw: RawFixtures = loadRawFixtures()): FixtureSet {
  return {
    searchRows: {
      realRow: maskSearchRow(raw.realRow),
      bundleRows: raw.bundleRows.map(maskSearchRow),
      roadOnlyRow: maskSearchRow(raw.roadOnlyRow),
      noExtendedFieldsRow: maskSearchRow(raw.noExtendedFieldsRow),
      missingKeyRow: maskSearchRow(raw.missingKeyRow),
    },
    detailResponse: { baseInfo: maskDetailBaseInfo(raw.detailBaseInfo), pics: raw.detailPics },
    bodies: raw.bodies,
  };
}
