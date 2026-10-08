/**
 * Spring HTTP 클라이언트 단위 테스트(switch-web-to-data-port 4.2). 가짜 `fetch`로 연결 실패, 시간 초과,
 * 500, 스키마 불일치, 허용 404, 로그에 검색어가 남지 않음을 확인한다.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { DataSourceError } from "../port";
import { createSpringClient } from "../spring/client";

const schema = z.object({ total: z.number() });
const BASE = "http://spring.test:8080";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let errorSpy: ReturnType<typeof vi.spyOn>;

function quietErrors(): void {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Spring 클라이언트", () => {
  it("no-store와 시간 제한 신호를 붙여 기본 주소 기준으로 부른다", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ total: 3 }));
    const client = createSpringClient({ baseUrl: BASE, fetch: fetchMock as unknown as typeof fetch });

    const result = await client.json({
      method: "GET",
      path: "/api/items",
      search: new URLSearchParams({ page: "2" }),
      schema,
    });

    expect(result).toEqual({ found: true, data: { total: 3 } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe(`${BASE}/api/items?page=2`);
    expect(init.method).toBe("GET");
    expect(init.cache).toBe("no-store");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("연결 실패는 DataSourceError(상태 없음)다", async () => {
    quietErrors();
    const client = createSpringClient({
      baseUrl: BASE,
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });

    const error = await client.json({ method: "GET", path: "/api/items", schema }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DataSourceError);
    expect(error).toMatchObject({ method: "GET", path: "/api/items", status: null });
  });

  it("시간 초과는 DataSourceError다", async () => {
    quietErrors();
    const hanging = ((_url: URL, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const client = createSpringClient({ baseUrl: BASE, fetch: hanging, timeoutMs: 20 });

    const error = await client.json({ method: "GET", path: "/api/items", schema }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DataSourceError);
    expect((error as DataSourceError).status).toBeNull();
  });

  it("500은 DataSourceError(상태 500)다", async () => {
    quietErrors();
    const client = createSpringClient({
      baseUrl: BASE,
      fetch: (async () => jsonResponse({ error: "boom" }, 500)) as typeof fetch,
    });

    const error = await client.json({ method: "GET", path: "/api/items", schema }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DataSourceError);
    expect((error as DataSourceError).status).toBe(500);
  });

  it("스키마와 다른 본문은 DataSourceError이고, 어느 필드인지만 남고 값은 남지 않는다", async () => {
    quietErrors();
    const client = createSpringClient({
      baseUrl: BASE,
      fetch: (async () => jsonResponse({ total: "민감한값" })) as typeof fetch,
    });

    const error = await client.json({ method: "GET", path: "/api/items", schema }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DataSourceError);
    expect((error as DataSourceError).message).toContain("total");
    expect((error as DataSourceError).message).not.toContain("민감한값");
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("민감한값");
  });

  it("JSON이 아닌 본문은 DataSourceError다", async () => {
    quietErrors();
    const client = createSpringClient({
      baseUrl: BASE,
      fetch: (async () => new Response("<html>", { status: 200 })) as typeof fetch,
    });

    await expect(client.json({ method: "GET", path: "/api/items", schema })).rejects.toBeInstanceOf(
      DataSourceError,
    );
  });

  it("허용한 404만 { found: false }이고, 허용하지 않으면 DataSourceError다", async () => {
    quietErrors();
    const client = createSpringClient({
      baseUrl: BASE,
      fetch: (async () => jsonResponse({ error: "없음" }, 404)) as typeof fetch,
    });

    expect(await client.json({ method: "GET", path: "/api/items/1", schema, allowNotFound: true })).toEqual({
      found: false,
    });
    await expect(client.json({ method: "GET", path: "/api/items", schema })).rejects.toMatchObject({
      status: 404,
    });
  });

  it("okStatuses에 든 상태(201)는 성공이고 본문을 JSON으로 보낸다", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ total: 1 }, 201));
    const client = createSpringClient({ baseUrl: BASE, fetch: fetchMock as unknown as typeof fetch });

    const result = await client.json({
      method: "POST",
      path: "/api/bookmarks",
      body: { itemId: 5 },
      schema,
      okStatuses: [200, 201],
    });

    expect(result.found).toBe(true);
    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"itemId":5}');
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("실패 로그와 오류 메시지에 검색어 값이 없다(경로와 원인만)", async () => {
    quietErrors();
    const client = createSpringClient({
      baseUrl: BASE,
      fetch: (async () => jsonResponse({ error: "boom" }, 500)) as typeof fetch,
    });

    const error = await client
      .json({ method: "GET", path: "/api/items", search: new URLSearchParams({ q: "비밀검색어" }), schema })
      .catch((e: unknown) => e);

    expect((error as DataSourceError).message).not.toContain("비밀검색어");
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("비밀검색어");
    expect(JSON.stringify(errorSpy.mock.calls)).toContain("/api/items");
  });

  it("요청 기록 훅은 쿼리 키만 받는다(값 없이, 정렬·중복 제거)", async () => {
    const seen: unknown[] = [];
    const client = createSpringClient({
      baseUrl: BASE,
      fetch: (async () => jsonResponse({ total: 1 })) as typeof fetch,
      onRequest: (record) => seen.push(record),
    });

    await client.json({
      method: "GET",
      path: "/api/items",
      search: new URLSearchParams("usage=b&usage=a&q=비밀"),
      schema,
    });

    expect(seen).toEqual([{ method: "GET", path: "/api/items", queryKeys: ["q", "usage"] }]);
  });
});
