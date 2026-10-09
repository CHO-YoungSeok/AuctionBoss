/**
 * 상태 화면(`/status`)을 실제로 렌더링해 사진 워커 카드와 로테이션 정보를 확인한다
 * (fix-photo-worker-and-deploy-config 4.2, switch-web-to-data-port 2.6). 백엔드 대역 `fetch`(Spring 원천)로
 * 데이터를 받는다(migrate-data-and-cutover 8.2).
 */
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useFakeBackend } from "@/lib/data-port/__tests__/fake-backend";
import StatusPage from "../page";

// `StatusPage`는 async 서버 컴포넌트다(switch-web-to-data-port 2.6) — 데이터를 읽은 뒤 엘리먼트를 돌려준다.
async function renderStatus(): Promise<string> {
  const element = await StatusPage();
  return renderToStaticMarkup(createElement(() => element));
}

describe("상태 화면 — 사진 워커 (fix-photo-worker-and-deploy-config 4.2) [Spring 원천]", () => {
  const backend = useFakeBackend();

  it("회차 기록이 없으면 세 워커 카드 모두 오류 대신 안내 문구를 보여준다", async () => {
    const html = await renderStatus();
    expect(html).toContain("사진 수집 워커");
    expect(html.split("아직 실행 기록이 없습니다.").length - 1).toBe(3);
  });

  it("사진 회차 기록이 있으면 시도·저장·사진 없음·실패 건수가 표시된다", async () => {
    backend.addRun("photos", "success", { attempted: 4, collected: 2, empty: 1, failed: 1, requestsMade: 5 });

    const html = await renderStatus();
    expect(html).toContain("시도 4 · 저장 2 · 사진 없음 1 · 실패 1");
    // 사진 카드에만 기록이 생겼으므로 안내 문구는 나머지 두 워커에만 남는다.
    expect(html.split("아직 실행 기록이 없습니다.").length - 1).toBe(2);
  });
});

describe("상태 화면 — 로테이션 정보와 설정 오류 (switch-web-to-data-port 2.6) [Spring 원천]", () => {
  const backend = useFakeBackend();
  let workDir: string;
  let originalConfigEnv: string | undefined;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "auctionboss-status-render-"));
    originalConfigEnv = process.env.AUCTIONBOSS_CONFIG;
  });

  afterEach(() => {
    if (originalConfigEnv === undefined) delete process.env.AUCTIONBOSS_CONFIG;
    else process.env.AUCTIONBOSS_CONFIG = originalConfigEnv;
    rmSync(workDir, { recursive: true, force: true });
  });

  it("설정이 정상이면 수집 워커 카드에만 로테이션 정보가 나온다", async () => {
    const html = await renderStatus();
    expect(html).toContain("한 바퀴 소요 시간");
    expect(html).toContain("다음 로테이션 위치");
    expect(html.split("다음 로테이션 위치").length - 1).toBe(1);
    expect(html).not.toContain("수집 설정을 불러올 수 없어");
  });

  it("설정 파일을 읽지 못하면 로테이션 자리만 안내 문구로 바뀌고 나머지 화면은 그대로 나온다", async () => {
    // Spring 원천은 백엔드가 자기 설정으로 상태를 판정하므로, 웹 쪽 설정 파일을 못 읽어도 상태 판정은 돌아온다.
    // 그 상황에서 로테이션 자리만 안내 문구로 바뀌는지 본다.
    process.env.AUCTIONBOSS_CONFIG = path.join(workDir, "없는-설정.json");
    const html = await renderStatus();
    expect(html).toContain("수집 설정을 불러올 수 없어 로테이션 정보를 표시할 수 없습니다");
    expect(html).not.toContain("다음 로테이션 위치");
    // 상태 카드 세 개와 회차 영역은 그대로다.
    expect(html).toContain("정보 수집 워커");
    expect(html).toContain("사진 수집 워커");
    expect(html.split("아직 실행 기록이 없습니다.").length - 1).toBe(3);
  });

  it("백엔드가 알려 준 다음 법원이 로테이션 위치에 반영된다", async () => {
    backend.rotationNextCourtCode = "B000212";
    const html = await renderStatus();
    expect(html).toContain("서울남부지방법원 (3/5)");
  });
});
