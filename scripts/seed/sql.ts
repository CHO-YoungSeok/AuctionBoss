/**
 * 시드 SQL 생성용 순수 함수 (add-spring-mysql-backend D6).
 * DB 접근 없이 값 -> MySQL 리터럴 변환만 한다.
 */

export type SqlColumnKind = "text" | "int" | "datetime" | "date" | "json";

export interface SqlColumn {
  name: string;
  kind: SqlColumnKind;
}

/** MySQL 문자열 리터럴. 백슬래시 이스케이프 규칙을 따른다. */
export function escapeString(value: string): string {
  let out = "";
  for (const ch of value) {
    switch (ch) {
      case "\\":
        out += "\\\\";
        break;
      case "'":
        out += "\\'";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\0":
        out += "\\0";
        break;
      case "\x1a":
        out += "\\Z";
        break;
      default:
        out += ch;
    }
  }
  return `'${out}'`;
}

/** ISO 문자열 -> UTC `'YYYY-MM-DD HH:MM:SS.mmm'`. 형식이 다르면 예외. */
export function toMysqlDatetime(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(iso)) {
    throw new Error(`시각 형식이 올바르지 않습니다: ${iso}`);
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`시각을 해석할 수 없습니다: ${iso}`);
  const s = new Date(ms).toISOString(); // 2026-09-08T11:48:38.617Z
  return `'${s.slice(0, 10)} ${s.slice(11, 23)}'`;
}

/** `YYYY-MM-DD`만 허용한다. 실제 존재하는 날짜여야 한다. */
export function toMysqlDate(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) throw new Error(`날짜 형식이 올바르지 않습니다: ${value}`);
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new Error(`존재하지 않는 날짜입니다: ${value}`);
  }
  return `'${value}'`;
}

export function toSqlValue(value: unknown, kind: SqlColumnKind): string {
  if (value === null || value === undefined) return "NULL";
  switch (kind) {
    case "int":
      if (typeof value === "bigint") return value.toString();
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new Error(`정수가 아닙니다: ${String(value)}`);
      }
      return String(value);
    case "text":
      if (typeof value !== "string") throw new Error(`문자열이 아닙니다: ${String(value)}`);
      return escapeString(value);
    case "datetime":
      if (typeof value !== "string") throw new Error(`시각이 문자열이 아닙니다: ${String(value)}`);
      return toMysqlDatetime(value);
    case "date":
      if (typeof value !== "string") throw new Error(`날짜가 문자열이 아닙니다: ${String(value)}`);
      return toMysqlDate(value);
    case "json":
      if (typeof value !== "string") throw new Error(`JSON이 문자열이 아닙니다: ${String(value)}`);
      JSON.parse(value); // 유효성 확인. 예외는 그대로 전파.
      return escapeString(value);
  }
}

const quoteIdent = (name: string) => `\`${name}\``;

/** 여러 행을 chunkSize 단위의 INSERT 문들로 만든다. */
export function buildInserts(
  table: string,
  columns: SqlColumn[],
  rows: Record<string, unknown>[],
  chunkSize = 100,
): string[] {
  const head = `INSERT INTO ${quoteIdent(table)} (${columns.map((c) => quoteIdent(c.name)).join(", ")}) VALUES\n`;
  const statements: string[] = [];
  for (let i = 0; i < rows.length; i += chunkSize) {
    const tuples = rows
      .slice(i, i + chunkSize)
      .map((r) => `(${columns.map((c) => toSqlValue(r[c.name], c.kind)).join(", ")})`);
    statements.push(`${head}${tuples.join(",\n")};\n`);
  }
  return statements;
}
