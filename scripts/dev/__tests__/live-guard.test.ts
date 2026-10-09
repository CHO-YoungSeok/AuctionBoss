import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 4단계 9.5: 실제 사이트로 나갈 수 있는 개발 스크립트가 `--i-confirm-live` 없이는 나가지 않음을 고정한다.
 * 이 스크립트들은 CI에서 돌지 않으므로(Docker·JDK 필요) 가드가 조용히 풀려도 다른 테스트가 잡지 못한다.
 * 이 테스트는 스크립트를 "실행"하는 경우에도 인자 검증에서 끝나는 경로만 쓴다(네트워크·Docker 없음).
 */
const dev = join(__dirname, "..");
const liveCheck = readFileSync(join(dev, "live-check-collector.sh"), "utf8");
const verify = readFileSync(join(dev, "verify-collector-on-spring.sh"), "utf8");
const fakeServer = readFileSync(join(dev, "fake-source-server.ts"), "utf8");

describe("실제 사이트 확인 스크립트의 가드", () => {
  it("live-check: 외부 요청 허용 true는 LIVE=1 분기 안에 한 번뿐이고, LIVE=1은 --i-confirm-live로만 켜진다", () => {
    expect(liveCheck.match(/external-requests-allowed=true/g)).toHaveLength(1);
    expect(liveCheck).toMatch(/if \[\[ "\$LIVE" == 1 \]\]; then src=\(--auctionboss\.source\.external-requests-allowed=true\)/);
    expect(liveCheck).toMatch(/^LIVE=0$/m);
    expect(liveCheck.match(/\bLIVE=1\b/g)).toHaveLength(1);
    expect(liveCheck).toMatch(/--i-confirm-live\) LIVE=1; shift ;;/);
  });

  it("live-check: dry-run은 루프백 가짜 서버 주소와 허용 false만 쓰고, 실제 주소 문자열은 스크립트에 없다", () => {
    expect(liveCheck).toContain('--auctionboss.source.base-url="$FAKE_BASE" --auctionboss.source.external-requests-allowed=false');
    expect(liveCheck).toContain('FAKE_BASE="http://127.0.0.1:');
    expect(liveCheck).not.toMatch(/courtauction\.go\.kr/);
  });

  it("verify-collector: 외부 요청 허용을 켜지 않고, 소스 주소는 127.0.0.1뿐이며, 실제 주소 문자열이 없다", () => {
    expect(verify).not.toMatch(/external-requests-allowed=true/);
    expect(verify).not.toMatch(/EXTERNAL_REQUESTS_ALLOWED/);
    expect(verify).not.toMatch(/courtauction\.go\.kr/);
    const baseUrls = [...verify.matchAll(/source\.base-url="?([^\s"]+)/g)].map((m) => m[1]!);
    expect(baseUrls.length).toBeGreaterThan(0);
    for (const u of baseUrls) expect(u).toMatch(/^http:\/\/127\.0\.0\.1:/);
  });

  it("가짜 소스 서버는 127.0.0.1에만 바인딩한다", () => {
    const listens = [...fakeServer.matchAll(/\.listen\([^)]*\)/g)].map((m) => m[0]);
    expect(listens.length).toBeGreaterThan(0);
    for (const l of listens) expect(l).toContain('"127.0.0.1"');
  });

  it("live-check 실행: 실제 모드는 대기 60초 미만을 거부하고, dry-run 전용 옵션과 함께 쓸 수 없다(종료 코드 2, 아무것도 시작 전)", () => {
    // 가드가 풀려도 실제 요청이 나가지 않게, 존재하지 않는 SQLite를 준다: 사전 확인이 실패해 컨테이너·요청 전에 종료 코드 1로 끝난다.
    const run = (args: string[]) =>
      spawnSync("bash", [join(dev, "live-check-collector.sh"), ...args, "--sqlite", "/nonexistent/none.db"], {
        encoding: "utf8",
        timeout: 20000,
      });
    const short = run(["--i-confirm-live", "--wait-seconds", "5"]);
    expect(short.status).toBe(2);
    expect(short.stderr).toContain("60초 이상");
    const mixed = run(["--i-confirm-live", "--dry-run-scenario", "backoff"]);
    expect(mixed.status).toBe(2);
    expect(mixed.stderr).toContain("실제 실행과 함께 쓸 수 없습니다");
  });
});
