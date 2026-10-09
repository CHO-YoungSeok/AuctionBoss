/**
 * 원천 선택 테스트(switch-web-to-data-port 2.2, migrate-data-and-cutover 8.4).
 * 원천은 `spring` 하나다. 어느 경우에도 데이터베이스 파일을 만들거나 열지 않는다(이 모듈은 파일 시스템을 쓰지 않는다).
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DataSourceConfigError } from "../port";
import { getDataPort, resolveDataSourceConfig, setDataPortForTesting } from "../index";

afterEach(() => {
  setDataPortForTesting(null);
});

const BASE = { AUCTIONBOSS_SPRING_BASE: "http://localhost:8080" };

describe("resolveDataSourceConfig", () => {
  it("원천 변수를 비우면 spring이고, 주소가 있어야 한다", () => {
    const expected = { kind: "spring", baseUrl: "http://localhost:8080/" };
    expect(resolveDataSourceConfig({ ...BASE })).toStrictEqual(expected);
    expect(resolveDataSourceConfig({ ...BASE, AUCTIONBOSS_DATA_SOURCE: "" })).toStrictEqual(expected);
    expect(resolveDataSourceConfig({ ...BASE, AUCTIONBOSS_DATA_SOURCE: "spring" })).toStrictEqual(expected);
  });

  it("은퇴한 sqlite 값은 은퇴했다는 오류이고 다른 원천으로 대신 동작하지 않는다", () => {
    expect(() => resolveDataSourceConfig({ ...BASE, AUCTIONBOSS_DATA_SOURCE: "sqlite" })).toThrow(DataSourceConfigError);
    expect(() => resolveDataSourceConfig({ ...BASE, AUCTIONBOSS_DATA_SOURCE: "sqlite" })).toThrow(/은퇴/);
    // 주소가 없어도 sqlite는 은퇴 오류가 먼저다(주소 오류로 가려지지 않는다).
    expect(() => resolveDataSourceConfig({ AUCTIONBOSS_DATA_SOURCE: "sqlite" })).toThrow(/은퇴/);
  });

  it("알 수 없는 값은 허용 값(spring)을 담은 오류다", () => {
    expect(() => resolveDataSourceConfig({ ...BASE, AUCTIONBOSS_DATA_SOURCE: "mysql" })).toThrow(DataSourceConfigError);
    expect(() => resolveDataSourceConfig({ ...BASE, AUCTIONBOSS_DATA_SOURCE: "mysql" })).toThrow(/허용 값: spring/);
    // 대소문자 변형도 조용히 받아주지 않는다.
    expect(() => resolveDataSourceConfig({ ...BASE, AUCTIONBOSS_DATA_SOURCE: "SPRING" })).toThrow(DataSourceConfigError);
    expect(() => resolveDataSourceConfig({ ...BASE, AUCTIONBOSS_DATA_SOURCE: "SQLITE" })).toThrow(DataSourceConfigError);
  });

  it("주소가 없거나 올바르지 않거나 http(s)가 아니면 오류다", () => {
    expect(() => resolveDataSourceConfig({})).toThrow(/AUCTIONBOSS_SPRING_BASE/);
    expect(() => resolveDataSourceConfig({ AUCTIONBOSS_DATA_SOURCE: "spring" })).toThrow(/AUCTIONBOSS_SPRING_BASE/);
    expect(() => resolveDataSourceConfig({ AUCTIONBOSS_SPRING_BASE: "   " })).toThrow(DataSourceConfigError);
    expect(() => resolveDataSourceConfig({ AUCTIONBOSS_SPRING_BASE: "not a url" })).toThrow(/올바른 주소/);
    expect(() => resolveDataSourceConfig({ AUCTIONBOSS_SPRING_BASE: "file:///etc/passwd" })).toThrow(/http/);
    expect(() => resolveDataSourceConfig({ AUCTIONBOSS_SPRING_BASE: "ftp://x" })).toThrow(/http/);
  });
});

describe("getDataPort", () => {
  it("테스트용 포트를 끼우면 그것을 돌려주고, 비우면 환경 변수에서 다시 만든다", () => {
    const saved = { source: process.env.AUCTIONBOSS_DATA_SOURCE, base: process.env.AUCTIONBOSS_SPRING_BASE };
    try {
      delete process.env.AUCTIONBOSS_DATA_SOURCE;
      process.env.AUCTIONBOSS_SPRING_BASE = "http://localhost:8080";
      const fake = {} as ReturnType<typeof getDataPort>;
      setDataPortForTesting(fake);
      expect(getDataPort()).toBe(fake);
      setDataPortForTesting(null);
      const created = getDataPort();
      expect(created).not.toBe(fake);
      expect(getDataPort()).toBe(created); // 프로세스 안에서 재사용한다
    } finally {
      if (saved.source === undefined) delete process.env.AUCTIONBOSS_DATA_SOURCE;
      else process.env.AUCTIONBOSS_DATA_SOURCE = saved.source;
      if (saved.base === undefined) delete process.env.AUCTIONBOSS_SPRING_BASE;
      else process.env.AUCTIONBOSS_SPRING_BASE = saved.base;
    }
  });

  it("주소 없이 처음 불리면 설정 오류로 실패한다(포트를 만들지 않는다)", () => {
    const saved = { source: process.env.AUCTIONBOSS_DATA_SOURCE, base: process.env.AUCTIONBOSS_SPRING_BASE };
    try {
      delete process.env.AUCTIONBOSS_DATA_SOURCE;
      delete process.env.AUCTIONBOSS_SPRING_BASE;
      setDataPortForTesting(null);
      expect(() => getDataPort()).toThrow(DataSourceConfigError);
    } finally {
      if (saved.source !== undefined) process.env.AUCTIONBOSS_DATA_SOURCE = saved.source;
      if (saved.base !== undefined) process.env.AUCTIONBOSS_SPRING_BASE = saved.base;
    }
  });
});

describe("데이터베이스 파일", () => {
  it("은퇴·잘못된 값·주소 없음 어느 경우에도 AUCTIONBOSS_DB 경로에 파일을 만들지 않는다", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "auctionboss-no-db-"));
    const dbPath = path.join(dir, "should-not-exist.db");
    const saved = process.env.AUCTIONBOSS_DB;
    process.env.AUCTIONBOSS_DB = dbPath;
    try {
      for (const env of [{ AUCTIONBOSS_DATA_SOURCE: "sqlite" }, { AUCTIONBOSS_DATA_SOURCE: "mysql" }, {}]) {
        setDataPortForTesting(null);
        const saved2 = { source: process.env.AUCTIONBOSS_DATA_SOURCE, base: process.env.AUCTIONBOSS_SPRING_BASE };
        delete process.env.AUCTIONBOSS_SPRING_BASE;
        if ("AUCTIONBOSS_DATA_SOURCE" in env) process.env.AUCTIONBOSS_DATA_SOURCE = env.AUCTIONBOSS_DATA_SOURCE;
        else delete process.env.AUCTIONBOSS_DATA_SOURCE;
        try {
          expect(() => getDataPort()).toThrow(DataSourceConfigError);
        } finally {
          if (saved2.source === undefined) delete process.env.AUCTIONBOSS_DATA_SOURCE;
          else process.env.AUCTIONBOSS_DATA_SOURCE = saved2.source;
          if (saved2.base !== undefined) process.env.AUCTIONBOSS_SPRING_BASE = saved2.base;
        }
      }
      expect(existsSync(dbPath)).toBe(false);
      expect(existsSync(`${dbPath}-wal`)).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.AUCTIONBOSS_DB;
      else process.env.AUCTIONBOSS_DB = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
