import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// 리허설 사이드카가 쓰는 두 기능: 고정 포트(--port)와 차단 응답 예약(/__block). 기본 동작(임의 포트, 정상 응답)은 그대로여야 한다.
const root = join(__dirname, "..", "..", "..");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

async function waitFor(file: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    try {
      const v = readFileSync(file, "utf8");
      if (v) return v;
    } catch {
      /* 아직 없음 */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("가짜 서버가 뜨지 않았습니다");
}

describe("scripts/dev/fake-source-server", () => {
  let dir: string;
  let child: ChildProcess;
  let port: number;
  const base = () => `http://127.0.0.1:${port}`;
  const search = () => fetch(`${base()}/pgj/pgjsearch/searchControllerMain.on`, { method: "POST", body: "{}" });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "fake-source-"));
    port = await freePort();
    child = spawn(
      process.execPath,
      [
        join(root, "node_modules/.bin/tsx"),
        "--tsconfig",
        "scripts/dev/tsconfig.snapshot.json",
        "scripts/dev/fake-source-server.ts",
        "--port-file",
        join(dir, "port"),
        "--port",
        String(port),
      ],
      { cwd: root, stdio: "ignore" },
    );
    expect(await waitFor(join(dir, "port"))).toBe(String(port));
  }, 60_000);

  afterAll(() => {
    child?.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  });

  it("--port로 준 포트에서 받고 검색은 JSON 객체로 답한다", async () => {
    const r = await search();
    expect(r.status).toBe(200);
    expect((await r.text()).trimStart().startsWith("{")).toBe(true);
  });

  it("/__block?n=2는 다음 검색 2건에 JSON이 아닌 차단 페이지(HTTP 200)로 답하고 그 뒤 정상으로 돌아온다", async () => {
    expect(await (await fetch(`${base()}/__block?n=2`)).json()).toEqual({ blockNext: 2 });
    for (let i = 0; i < 2; i++) {
      const t = await (await search()).text();
      expect(t.trimStart().startsWith("<")).toBe(true);
    }
    expect((await (await search()).text()).trimStart().startsWith("{")).toBe(true);
  });

  it("차단 예약은 검색에만 적용되고 세션·상세 응답은 그대로다", async () => {
    await fetch(`${base()}/__block?n=1`);
    const idx = await fetch(`${base()}/pgj/index.on`);
    expect(idx.status).toBe(200);
    expect(await idx.text()).toContain("index");
    const stats = (await (await fetch(`${base()}/__stats`)).json()) as { hosts: Record<string, number> };
    expect(Object.keys(stats.hosts).every((h) => h.startsWith("127.0.0.1:"))).toBe(true);
    await search(); // 예약 소진
  });
});
