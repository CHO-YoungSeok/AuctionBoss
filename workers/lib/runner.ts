/**
 * 분석 실행기 선택(design.md D1).
 *
 * `AUCTIONBOSS_ANALYZER_RUNNER`:
 * - `agy` → Antigravity CLI (`ANTHROPIC_API_KEY` 유무와 무관)
 * - 없음/빈 값/`claude` → 기존 규칙(`ANTHROPIC_API_KEY` 있으면 API, 없으면 Claude CLI)
 * - 그 밖 → throw. 오타로 의도와 다른 실행기가 조용히 쓰이면 안 되므로 기동 시 한 번 해석해
 *   첫 회차 전에 실패를 드러낸다.
 */
import { runAgyHeadless } from "./agy";
import { runClaude, type RunClaude } from "./claude";

export const ANALYZER_RUNNERS = ["claude", "agy"] as const;

export function resolveRunner(env: Record<string, string | undefined> = process.env): RunClaude {
  const raw = env.AUCTIONBOSS_ANALYZER_RUNNER;
  // 기존 `runClaude`가 API 키 유무를 호출 시점에 process.env에서 읽는다(그 동작은 그대로 둔다).
  if (raw === undefined || raw === "" || raw === "claude") return runClaude;
  if (raw === "agy") return runAgyHeadless;
  throw new Error(
    `AUCTIONBOSS_ANALYZER_RUNNER 값이 올바르지 않습니다: "${raw}" (허용: ${ANALYZER_RUNNERS.join(", ")})`,
  );
}
