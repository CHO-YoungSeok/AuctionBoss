import { describe, expect, it } from "vitest";
import { buildInserts, escapeString, toMysqlDate, toMysqlDatetime, toSqlValue } from "../sql";

describe("escapeString", () => {
  it("작은따옴표, 백슬래시, 줄바꿈, NUL을 MySQL 규칙으로 이스케이프한다", () => {
    expect(escapeString("a'b")).toBe("'a\\'b'");
    expect(escapeString("a\\b")).toBe("'a\\\\b'");
    expect(escapeString("a\nb\rc")).toBe("'a\\nb\\rc'");
    expect(escapeString("a\0b")).toBe("'a\\0b'");
  });
  it("한글과 세미콜론은 그대로 둔다", () => {
    expect(escapeString("가;나")).toBe("'가;나'");
  });
});

describe("toMysqlDatetime", () => {
  it("ISO 문자열을 UTC 밀리초 3자리로 바꾼다", () => {
    expect(toMysqlDatetime("2026-09-08T11:48:38.617Z")).toBe("'2026-09-08 11:48:38.617'");
    expect(toMysqlDatetime("2026-09-08T11:48:38Z")).toBe("'2026-09-08 11:48:38.000'");
  });
  it("오프셋이 있으면 UTC로 환산한다", () => {
    expect(toMysqlDatetime("2026-09-08T20:48:38.001+09:00")).toBe("'2026-09-08 11:48:38.001'");
  });
  it("형식이 다르면 예외", () => {
    expect(() => toMysqlDatetime("2026-09-08 11:48:38")).toThrow();
    expect(() => toMysqlDatetime("2026-13-08T11:48:38.617Z")).toThrow();
  });
});

describe("toMysqlDate", () => {
  it("YYYY-MM-DD를 그대로 둔다", () => {
    expect(toMysqlDate("2026-10-08")).toBe("'2026-10-08'");
  });
  it("형식이 다르거나 없는 날짜면 예외", () => {
    expect(() => toMysqlDate("2026/10/08")).toThrow();
    expect(() => toMysqlDate("2026-02-30")).toThrow();
  });
});

describe("toSqlValue", () => {
  it("NULL, 정수, JSON", () => {
    expect(toSqlValue(null, "text")).toBe("NULL");
    expect(toSqlValue(51005255120, "int")).toBe("51005255120");
    expect(toSqlValue('{"a":"it\'s"}', "json")).toBe("'{\"a\":\"it\\'s\"}'");
    expect(() => toSqlValue("{broken", "json")).toThrow();
    expect(() => toSqlValue(1.5, "int")).toThrow();
  });
});

describe("buildInserts", () => {
  const cols = [
    { name: "id", kind: "int" as const },
    { name: "note", kind: "text" as const },
  ];
  it("100행 단위로 나눈다", () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({ id: i + 1, note: null }));
    const sql = buildInserts("items", cols, rows);
    expect(sql).toHaveLength(3);
    expect(sql[0].startsWith("INSERT INTO `items` (`id`, `note`) VALUES\n(1, NULL),")).toBe(true);
    expect(sql[2].endsWith("(250, NULL);\n")).toBe(true);
  });
});
