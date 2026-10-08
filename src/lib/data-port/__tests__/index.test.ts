/**
 * 원천 선택 테스트(switch-web-to-data-port 2.2).
 */
import { afterEach, describe, expect, it } from "vitest";

import { DataSourceConfigError } from "../port";
import { getDataPort, resolveDataSourceConfig, setDataPortForTesting } from "../index";

afterEach(() => {
  setDataPortForTesting(null);
});

describe("resolveDataSourceConfig", () => {
  it("설정이 없으면 기본값은 sqlite다", () => {
    expect(resolveDataSourceConfig({})).toStrictEqual({ kind: "sqlite" });
    expect(resolveDataSourceConfig({ AUCTIONBOSS_DATA_SOURCE: "" })).toStrictEqual({ kind: "sqlite" });
    expect(resolveDataSourceConfig({ AUCTIONBOSS_DATA_SOURCE: "sqlite" })).toStrictEqual({ kind: "sqlite" });
  });

  it("spring이면 주소를 함께 돌려준다", () => {
    expect(
      resolveDataSourceConfig({
        AUCTIONBOSS_DATA_SOURCE: "spring",
        AUCTIONBOSS_SPRING_BASE: "http://localhost:8080",
      }),
    ).toStrictEqual({ kind: "spring", baseUrl: "http://localhost:8080/" });
  });

  it("알 수 없는 값은 허용 값을 담은 오류이고 sqlite로 대신 동작하지 않는다", () => {
    expect(() => resolveDataSourceConfig({ AUCTIONBOSS_DATA_SOURCE: "mysql" })).toThrow(DataSourceConfigError);
    expect(() => resolveDataSourceConfig({ AUCTIONBOSS_DATA_SOURCE: "mysql" })).toThrow(/sqlite, spring/);
    // 대소문자·공백 변형도 조용히 받아주지 않는다.
    expect(() => resolveDataSourceConfig({ AUCTIONBOSS_DATA_SOURCE: "SQLITE" })).toThrow(DataSourceConfigError);
  });

  it("spring인데 주소가 없거나 올바르지 않거나 http(s)가 아니면 오류다", () => {
    const source = { AUCTIONBOSS_DATA_SOURCE: "spring" };
    expect(() => resolveDataSourceConfig(source)).toThrow(/AUCTIONBOSS_SPRING_BASE/);
    expect(() => resolveDataSourceConfig({ ...source, AUCTIONBOSS_SPRING_BASE: "   " })).toThrow(DataSourceConfigError);
    expect(() => resolveDataSourceConfig({ ...source, AUCTIONBOSS_SPRING_BASE: "not a url" })).toThrow(/올바른 주소/);
    expect(() => resolveDataSourceConfig({ ...source, AUCTIONBOSS_SPRING_BASE: "file:///etc/passwd" })).toThrow(/http/);
    expect(() => resolveDataSourceConfig({ ...source, AUCTIONBOSS_SPRING_BASE: "ftp://x" })).toThrow(/http/);
  });
});

describe("getDataPort", () => {
  it("테스트용 포트를 끼우면 그것을 돌려주고, 비우면 환경 변수에서 다시 만든다", () => {
    const fake = {} as ReturnType<typeof getDataPort>;
    setDataPortForTesting(fake);
    expect(getDataPort()).toBe(fake);
    setDataPortForTesting(null);
    const created = getDataPort();
    expect(created).not.toBe(fake);
    expect(getDataPort()).toBe(created); // 프로세스 안에서 재사용한다
  });
});
