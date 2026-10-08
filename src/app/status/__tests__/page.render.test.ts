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

import { COLLECTOR_STATE_KEYS, closeDb, finishRun, setCollectorState, startRun } from "@/lib/db";

import { setDataPortForTesting } from "@/lib/data-port";

import { DATA_SOURCES_UNDER_TEST, createTestPort, useDataSource } from "@/lib/data-port/__tests__/data-sources";
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

// `StatusPage`는 async 서버 컴포넌트다(switch-web-to-data-port 2.6) — 데이터를 읽은 뒤 엘리먼트를 돌려준다.
async function renderStatus(): Promise<string> {
  const element = await StatusPage();
  return renderToStaticMarkup(createElement(() => element));
}

describe.each(DATA_SOURCES_UNDER_TEST)("상태 화면 — 사진 워커 (fix-photo-worker-and-deploy-config 4.2) [%s 원천]", (source) => {
  useDataSource(source);
  it("회차 기록이 없으면 세 워커 카드 모두 오류 대신 안내 문구를 보여준다", async () => {
    const html = await renderStatus();
    expect(html).toContain("사진 수집 워커");
    expect(html.split("아직 실행 기록이 없습니다.").length - 1).toBe(3);
  });

  it("사진 회차 기록이 있으면 시도·저장·사진 없음·실패 건수가 표시된다", async () => {
    const runId = startRun("photos");
    finishRun(runId, {
      outcome: "success",
      detail: { attempted: 4, collected: 2, empty: 1, failed: 1, requestsMade: 5 },
    });

    const html = await renderStatus();
    expect(html).toContain("시도 4 · 저장 2 · 사진 없음 1 · 실패 1");
    // 사진 카드에만 기록이 생겼으므로 안내 문구는 나머지 두 워커에만 남는다.
    expect(html.split("아직 실행 기록이 없습니다.").length - 1).toBe(2);
  });
});

describe.each(DATA_SOURCES_UNDER_TEST)("상태 화면 — 로테이션 정보와 설정 오류 (switch-web-to-data-port 2.6) [%s 원천]", (source) => {
  useDataSource(source);
  let originalConfigEnv: string | undefined;

  beforeEach(() => {
    originalConfigEnv = process.env.AUCTIONBOSS_CONFIG;
  });

  afterEach(() => {
    setDataPortForTesting(null);
    if (originalConfigEnv === undefined) delete process.env.AUCTIONBOSS_CONFIG;
    else process.env.AUCTIONBOSS_CONFIG = originalConfigEnv;
  });

  it("설정이 정상이면 수집 워커 카드에만 로테이션 정보가 나온다", async () => {
    const html = await renderStatus();
    expect(html).toContain("한 바퀴 소요 시간");
    expect(html).toContain("다음 로테이션 위치");
    expect(html.split("다음 로테이션 위치").length - 1).toBe(1);
    expect(html).not.toContain("수집 설정을 불러올 수 없어");
  });

  it("설정 파일을 읽지 못하면 로테이션 자리만 안내 문구로 바뀌고 나머지 화면은 그대로 나온다", async () => {
    // SQLite 구현체(와 Spring 대역의 Next 라우트)의 `getWorkerStatus`도 같은 설정 파일을 읽어 먼저 던지므로, 이 안내 경로는
    // 상태 판정이 설정과 무관하게 돌아오는 원천(Spring: 백엔드가 자기 설정으로 판정)에서만 보인다.
    // 그 상황을 만들려고 상태 판정만 대체한 포트를 끼운다.
    setDataPortForTesting({
      ...createTestPort(source).port,
      getWorkerStatus: async () => ({ state: "stale", lastSuccessAt: null, lastRun: null }),
    });
    process.env.AUCTIONBOSS_CONFIG = path.join(workDir, "없는-설정.json");
    const html = await renderStatus();
    expect(html).toContain("수집 설정을 불러올 수 없어 로테이션 정보를 표시할 수 없습니다");
    expect(html).not.toContain("다음 로테이션 위치");
    // 상태 카드 세 개와 회차 영역은 그대로다.
    expect(html).toContain("정보 수집 워커");
    expect(html).toContain("사진 수집 워커");
    expect(html.split("아직 실행 기록이 없습니다.").length - 1).toBe(3);
  });

  it("collector_state에 기록된 다음 법원이 로테이션 위치에 반영된다", async () => {
    setCollectorState(COLLECTOR_STATE_KEYS.ROTATION_NEXT_COURT_CODE, "B000212");
    const html = await renderStatus();
    expect(html).toContain("서울남부지방법원 (3/5)");
  });
});
