import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const LIVE = path.resolve(__dirname, "../../../data/auctionboss.db");
const SCRIPT = path.resolve(__dirname, "../compare-screens.sh");

function run(env: Record<string, string>, tmp: string) {
  return spawnSync("bash", [SCRIPT], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: tmp, ...env } as unknown as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 20_000,
  });
}

// 원천 지정 환경 변수의 입력 검사만 본다(Docker·Next를 띄우기 전에 끝나므로 CI에서도 돈다).
describe("compare-screens.sh 원천 지정 환경 변수(migrate-data-and-cutover 4.2)", () => {
  it("운영 원본 경로·없는 파일·SQLITE_DB 없는 SKIP_SEED는 종료 코드 2로 거부하고 임시 디렉터리를 남기지 않는다", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "cmp-guard-"));
    try {
      const live = run({ SQLITE_DB: "data/auctionboss.db" }, tmp);
      expect(live.status).toBe(2);
      expect(live.stderr).toContain("운영 원본");
      expect(run({ SQLITE_DB: path.join(tmp, "missing.db") }, tmp).status).toBe(2);
      const skip = run({ SKIP_SEED: "1" }, tmp);
      expect(skip.status).toBe(2);
      expect(skip.stderr).toContain("SQLITE_DB");
      const leftovers = spawnSync("ls", [tmp], { encoding: "utf8" }).stdout.trim();
      expect(leftovers).toBe("");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("SPRING_BASE만 주면(SKIP_FORMS 없이) 외부 Spring에 폼 쓰기를 보내지 않도록 종료 코드 2로 거부한다", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "cmp-guard-"));
    try {
      const r = run({ SPRING_BASE: "http://127.0.0.1:9" }, tmp);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("SKIP_FORMS");
      expect(spawnSync("ls", [tmp], { encoding: "utf8" }).stdout.trim()).toBe("");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // 운영 원본이 있는 머신에서만 의미가 있다(CI에는 없다).
  it.skipIf(!existsSync(LIVE))("심볼릭 링크로 운영 원본을 가리켜도 거부한다", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "cmp-guard-"));
    try {
      const link = path.join(tmp, "link.db");
      symlinkSync(LIVE, link);
      const r = run({ SQLITE_DB: link }, tmp);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("운영 원본");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
