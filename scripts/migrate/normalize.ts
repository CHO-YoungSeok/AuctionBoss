/**
 * 행 정규화와 테이블 해시 (migrate-data-and-cutover D4). 순수 함수, DB·파일 접근 없음.
 *
 * 같은 규칙을 Java(`RowNormalizer`, `TableDigest`)가 MySQL 값에서 다시 구현한다. 두 구현은
 * `backend/src/test/resources/migration/`의 교차 언어 골든으로 같은 해시를 내야 한다.
 *
 * 규칙(버전 {@link NORMALIZE_RULE_VERSION}):
 *  - 행 직렬화: 컬럼 순서(`EXPECTED_COLUMNS`, = MySQL 컬럼 순서)대로 값을 모은 배열을 JSON 한 줄로 쓴다.
 *    배열의 원소는 모두 문자열 또는 `null`이다. JSON 직렬화는 공백 없이, 문자열은 `"` `\` 와
 *    제어 문자(U+0000~U+001F)만 이스케이프(`\b \t \n \f \r`, 그 밖은 `\u00xx` 소문자 16진)하고
 *    비 ASCII 문자는 그대로 둔다.
 *  - NULL -> `null`. 정수 -> 10진 문자열. 시각 -> `YYYY-MM-DDTHH:mm:ss.SSSZ`(UTC).
 *    날짜 -> `YYYY-MM-DD`. JSON 컬럼 -> 파싱한 뒤 객체 키를 (UTF-16 코드 유닛 순으로) 재귀 정렬해 공백 없이
 *    다시 쓴 문자열(숫자는 정수만 허용 — 실수나 16자리 이상 숫자는 두 언어 표기가 갈릴 수 있어 거부).
 *    그 밖 문자열은 그대로(trim·NFC 정규화 없음).
 *  - 줄 정렬: 기본 키 오름차순. 정수 키는 숫자로, 문자열 키(`collector_state.key`)는 UTF-8 바이트 순으로.
 *  - 테이블 해시 = SHA-256(줄들을 `\n`으로 이은 UTF-8 바이트, 끝 개행 없음). 0행이면 빈 바이트의 해시.
 *
 * 오류 메시지에는 값을 넣지 않는다(D14). 호출자가 테이블·id·컬럼 이름을 붙인다.
 */
import { createHash } from "node:crypto";

import { TABLE_SPECS, type TableSpec } from "../seed/columns";
import { toMysqlDate, toMysqlDatetime, type SqlColumnKind } from "../seed/sql";

export const NORMALIZE_RULE_VERSION = 1;

/** 값 없는 변환 오류. `kind`는 컬럼 종류(값이 아님). */
export class NormalizeError extends Error {
  constructor(readonly kind: SqlColumnKind | "key") {
    super(`정규화할 수 없는 ${kind} 값입니다`);
    this.name = "NormalizeError";
  }
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) throw new NormalizeError("json");
      return String(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
    }
    default:
      throw new NormalizeError("json");
  }
}

/** 값 하나를 정규화한 문자열(또는 null)로 바꾼다. 규칙에 어긋나면 값 없는 {@link NormalizeError}. */
export function normalizeValue(value: unknown, kind: SqlColumnKind): string | null {
  if (value === null || value === undefined) return null;
  try {
    switch (kind) {
      case "int":
        if (typeof value === "bigint") return value.toString();
        if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new NormalizeError("int");
        return String(value);
      case "text":
        if (typeof value !== "string") throw new NormalizeError("text");
        return value;
      case "datetime": {
        if (typeof value !== "string") throw new NormalizeError("datetime");
        const lit = toMysqlDatetime(value); // 'YYYY-MM-DD HH:MM:SS.mmm' (UTC), 형식이 다르면 예외
        return `${lit.slice(1, 11)}T${lit.slice(12, 24)}Z`;
      }
      case "date":
        if (typeof value !== "string") throw new NormalizeError("date");
        return toMysqlDate(value).slice(1, -1);
      case "json": {
        if (typeof value !== "string") throw new NormalizeError("json");
        // 문자열 밖의 16자리 이상 숫자는 JSON.parse에서 정밀도를 잃는다.
        if (/\d{16,}/.test(value.replace(/"(?:[^"\\]|\\.)*"/g, '""'))) throw new NormalizeError("json");
        return canonicalJson(JSON.parse(value));
      }
    }
  } catch (e) {
    if (e instanceof NormalizeError) throw e;
    throw new NormalizeError(kind); // 원래 메시지에는 값이 들어 있으므로 버린다.
  }
}

export interface NormalizeColumn {
  name: string;
  kind: SqlColumnKind;
}

/** 행 하나를 한 줄로 직렬화한다. `columns` 순서가 곧 값 순서다. */
export function normalizeRow(columns: readonly NormalizeColumn[], row: Record<string, unknown>): string {
  return JSON.stringify(columns.map((c) => normalizeValue(row[c.name], c.kind)));
}

function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

export function specFor(table: string): TableSpec {
  const spec = TABLE_SPECS.find((t) => t.table === table);
  if (!spec) throw new Error(`알 수 없는 테이블입니다: ${table}`);
  return spec;
}

export interface TableDigest {
  rows: number;
  sha256: string;
}

/** 테이블 해시. 입력 행의 순서는 상관없다(기본 키로 정렬한다). */
export function tableDigest(
  table: string,
  columns: readonly NormalizeColumn[],
  rows: readonly Record<string, unknown>[],
): TableDigest {
  const spec = specFor(table);
  const keyed = rows.map((row) => {
    const k = row[spec.key];
    if (spec.keyKind === "int") {
      if (typeof k !== "number" && typeof k !== "bigint") throw new NormalizeError("key");
      return { k: BigInt(k), line: normalizeRow(columns, row) };
    }
    if (typeof k !== "string") throw new NormalizeError("key");
    return { k, line: normalizeRow(columns, row) };
  });
  if (spec.keyKind === "int") {
    keyed.sort((a, b) => ((a.k as bigint) < (b.k as bigint) ? -1 : (a.k as bigint) > (b.k as bigint) ? 1 : 0));
  } else {
    keyed.sort((a, b) => compareBytes(a.k as string, b.k as string));
  }
  const sha256 = createHash("sha256").update(keyed.map((r) => r.line).join("\n"), "utf8").digest("hex");
  return { rows: rows.length, sha256 };
}
