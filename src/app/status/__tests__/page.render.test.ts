/**
 * 상태 화면(`/status`)을 실제로 렌더링해 사진 워커 카드를 확인한다
 * (fix-photo-worker-and-deploy-config 4.2). 물건 상세 렌더 테스트와 같은 방식 —
 * 임시 DB 파일을 쓰고 서버 컴포넌트를 직접 호출해 `renderToStaticMarkup`으로 HTML을 본다.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, finishRun, startRun } from "@/lib/db";

import StatusPage from "../page";

let workDir: string;
let originalDbEnv: string | undefined;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "auctionboss-status-render-"));
  originalDbEnv = process.env.AUCTIONBOSS_DB;
  process.env.AUCTIONBOSS_DB = path.join(workDir, "test.db");
  closeDb();
});

afterEach(() => {
  closeDb();
  if (originalDbEnv === undefined) delete process.env.AUCTIONBOSS_DB;
  else process.env.AUCTIONBOSS_DB = originalDbEnv;
  rmSync(workDir, { recursive: true, force: true });
});

function renderStatus(): string {
  return renderToStaticMarkup(createElement(() => StatusPage()));
}

describe("상태 화면 — 사진 워커 (fix-photo-worker-and-deploy-config 4.2)", () => {
  it("회차 기록이 없으면 세 워커 카드 모두 오류 대신 안내 문구를 보여준다", () => {
    const html = renderStatus();
    expect(html).toContain("사진 수집 워커");
    expect(html.split("아직 실행 기록이 없습니다.").length - 1).toBe(3);
  });

  it("사진 회차 기록이 있으면 시도·저장·사진 없음·실패 건수가 표시된다", () => {
    const runId = startRun("photos");
    finishRun(runId, {
      outcome: "success",
      detail: { attempted: 4, collected: 2, empty: 1, failed: 1, requestsMade: 5 },
    });

    const html = renderStatus();
    expect(html).toContain("시도 4 · 저장 2 · 사진 없음 1 · 실패 1");
    // 사진 카드에만 기록이 생겼으므로 안내 문구는 나머지 두 워커에만 남는다.
    expect(html.split("아직 실행 기록이 없습니다.").length - 1).toBe(2);
  });
});
