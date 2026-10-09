/**
 * /api/health, Spring 원천(migrate-data-and-cutover D9, 5.2). 웹은 DB를 직접 열지 않고 백엔드 헬스체크로 판정한다.
 * 이 파일은 `@/lib/db`의 모든 접근과 `better-sqlite3`를 던지게 한 채로 돈다 - SQLite를 열면 실패한다.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "@/lib/db",
  () =>
    new Proxy(
      {},
      {
        get: (_target, name) =>
          typeof name === "symbol" || name === "then"
            ? undefined
            : () => {
                throw new Error(`spring 모드에서 @/lib/db를 썼습니다: ${String(name)}`);
              },
      },
    ),
);
vi.mock("better-sqlite3", () => ({
  default: function Database() {
    throw new Error("spring 모드에서 SQLite를 열었습니다");
  },
}));

import { setDataPortForTesting } from "@/lib/data-port";
import { createSpringPort } from "@/lib/data-port/spring/port";

import { GET } from "../route";

const BASE = "http://backend.test:8080/?token=SECRETQUERY";

function useFetch(fetchImpl: typeof fetch, timeoutMs?: number) {
  setDataPortForTesting(createSpringPort({ baseUrl: BASE, fetch: fetchImpl, timeoutMs }));
}

afterEach(() => {
  setDataPortForTesting(null);
  vi.restoreAllMocks();
});

describe("GET /api/health (spring 원천)", () => {
  it("백엔드 200 -> 200 connected, 백엔드 /api/health만 부른다", async () => {
    const calls: string[] = [];
    useFetch((async (url: URL | string) => {
      calls.push(String(url));
      return new Response('{"status":"ok"}', { status: 200 });
    }) as typeof fetch);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.database).toBe("connected");
    expect(calls).toEqual(["http://backend.test:8080/api/health"]);
  });

  it("백엔드 503 -> 503 disconnected", async () => {
    useFetch((async () => new Response("{}", { status: 503 })) as typeof fetch);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("error");
    expect(body.database).toBe("disconnected");
    expect(body.error).toContain("503");
  });

  it("연결 실패 -> 503이고 오류 문자열에 주소·비밀 쿼리가 없다", async () => {
    useFetch((async () => {
      throw new Error("connect ECONNREFUSED http://backend.test:8080/?token=SECRETQUERY");
    }) as typeof fetch);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET();
    expect(res.status).toBe(503);
    const text = JSON.stringify(await res.json());
    expect(text).toContain("disconnected");
    expect(text).not.toContain("SECRETQUERY");
    expect(text).not.toContain("backend.test");
  });

  it("시간 초과 -> 503", async () => {
    useFetch(
      ((_url: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })) as typeof fetch,
      20,
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET();
    expect(res.status).toBe(503);
    expect((await res.json()).database).toBe("disconnected");
  });
});
