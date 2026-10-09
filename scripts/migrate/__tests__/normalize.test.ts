import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { EXPECTED_COLUMNS, TABLE_SPECS, columnKind } from "../../seed/columns";
import { NormalizeError, normalizeRow, normalizeValue, tableDigest } from "../normalize";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("normalizeValue", () => {
  it("밀리초 없는 시각과 +09:00 시각이 같은 순간의 .SSSZ가 된다", () => {
    expect(normalizeValue("2026-09-08T11:48:38Z", "datetime")).toBe("2026-09-08T11:48:38.000Z");
    expect(normalizeValue("2026-09-08T20:48:38+09:00", "datetime")).toBe("2026-09-08T11:48:38.000Z");
    expect(normalizeValue("2026-09-08T11:48:38.6Z", "datetime")).toBe("2026-09-08T11:48:38.600Z");
    expect(normalizeValue("2026-09-08T11:48:38.617Z", "datetime")).toBe("2026-09-08T11:48:38.617Z");
  });

  it("키 순서와 공백이 다른 JSON이 같은 문자열이 된다", () => {
    const a = normalizeValue('{"b": 1, "a": {"y": [3, 2], "x": "z"}}', "json");
    const b = normalizeValue('{"a":{"x":"z","y":[3,2]},"b":1}', "json");
    expect(a).toBe('{"a":{"x":"z","y":[3,2]},"b":1}');
    expect(b).toBe(a);
  });

  it("큰 정수(1천억 이상)가 정확한 10진 문자열이 된다", () => {
    expect(normalizeValue(123456789012, "int")).toBe("123456789012");
    expect(normalizeValue(9007199254740991, "int")).toBe("9007199254740991");
    expect(normalizeValue(BigInt("9223372036854775807"), "int")).toBe("9223372036854775807");
  });

  it("뒤쪽 공백, 이모지, 백슬래시, 줄바꿈이 그대로다", () => {
    expect(normalizeValue("끝 공백  ", "text")).toBe("끝 공백  ");
    expect(normalizeValue("😀 a\\b\n", "text")).toBe("😀 a\\b\n");
  });

  it("빈 문자열은 NULL과 구별되고, 제어 문자와 NFD(비정규화) 문자열이 그대로다", () => {
    expect(normalizeValue("", "text")).toBe("");
    expect(normalizeValue("", "text")).not.toBeNull();
    expect(normalizeValue("\u0001a\tb\u1100\u1161", "text")).toBe("\u0001a\tb\u1100\u1161");
    // 행 직렬화에서 제어 문자는 \u00xx(소문자)로, 빈 문자열은 ""로, NULL은 null로 쓴다.
    const cols = [{ name: "a", kind: "text" as const }, { name: "b", kind: "text" as const }, { name: "c", kind: "text" as const }];
    expect(normalizeRow(cols, { a: "", b: null, c: "\u0001\u001f\u1100" })).toBe('["",null,"\\u0001\\u001f\u1100"]');
  });

  it("NULL은 null이고 날짜는 그대로다", () => {
    expect(normalizeValue(null, "text")).toBeNull();
    expect(normalizeValue("2026-10-13", "date")).toBe("2026-10-13");
  });

  it("규칙에 어긋나는 값은 값이 없는 오류로 거부한다", () => {
    const sentinel = "__REAL_NAME_SENTINEL__";
    const cases: [unknown, Parameters<typeof normalizeValue>[1]][] = [
      [`${sentinel}`, "datetime"],
      [`2026-13-45${sentinel}`, "date"],
      [`{"a": ${sentinel}`, "json"],
      [1.5, "int"],
      ['{"a": 1.5}', "json"],
      ['{"a": 12345678901234567}', "json"],
    ];
    for (const [v, kind] of cases) {
      let err: unknown;
      try {
        normalizeValue(v, kind);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(NormalizeError);
      expect(String((err as Error).message)).not.toContain(sentinel);
    }
  });
});

describe("tableDigest", () => {
  const stateColumns = [
    { name: "key", kind: "text" as const },
    { name: "value", kind: "text" as const },
    { name: "updated_at", kind: "datetime" as const },
  ];
  const state = (key: string) => ({ key, value: "v", updated_at: "2026-09-08T11:48:38.617Z" });

  it("collector_state 키는 UTF-8 바이트 순으로 정렬한다(입력 순서와 무관)", () => {
    // 코드 유닛 순으로는 "가"(U+AC00) < "😀"(서로게이트 D83D)가 아니라 반대다. 바이트 순은 "가" < "😀".
    const keys = ["😀", "b", "가", "B", "a"];
    const d1 = tableDigest("collector_state", stateColumns, keys.map(state));
    const d2 = tableDigest("collector_state", stateColumns, [...keys].reverse().map(state));
    const lines = ["B", "a", "b", "가", "😀"].map((k) => normalizeRow(stateColumns, state(k))).join("\n");
    expect(d1.sha256).toBe(sha(lines));
    expect(d2.sha256).toBe(d1.sha256);
    expect(d1.rows).toBe(5);
  });

  it("정수 키는 숫자 순이다(10이 9 뒤)", () => {
    const cols = [{ name: "id", kind: "int" as const }, { name: "last_read_at", kind: "datetime" as const }];
    const rows = [10, 9, 100].map((id) => ({ id, last_read_at: null }));
    const expected = [9, 10, 100].map((id) => normalizeRow(cols, { id, last_read_at: null })).join("\n");
    expect(tableDigest("feed_reads", cols, rows).sha256).toBe(sha(expected));
  });

  it("0행은 빈 바이트의 해시다", () => {
    expect(tableDigest("bookmarks", [], []).sha256).toBe(sha(""));
  });

  it("행 직렬화는 공백 없는 JSON 배열이고 값이 바뀌면 해시가 바뀐다", () => {
    const row = state("a");
    expect(normalizeRow(stateColumns, row)).toBe('["a","v","2026-09-08T11:48:38.617Z"]');
    const a = tableDigest("collector_state", stateColumns, [row]);
    const b = tableDigest("collector_state", stateColumns, [{ ...row, value: "v " }]);
    expect(a.sha256).not.toBe(b.sha256);
  });
});

describe("컬럼 정의", () => {
  it("모든 테이블에 기본 키 컬럼이 있고 EXPECTED_COLUMNS에 모든 테이블이 있다", () => {
    for (const spec of TABLE_SPECS) expect(EXPECTED_COLUMNS[spec.table]).toContain(spec.key);
    expect(Object.keys(EXPECTED_COLUMNS).sort()).toEqual(TABLE_SPECS.map((t) => t.table).sort());
  });
  it("photo_attempted_at은 시각 컬럼이다", () => {
    expect(columnKind("photo_attempted_at", "TEXT")).toBe("datetime");
  });
});
