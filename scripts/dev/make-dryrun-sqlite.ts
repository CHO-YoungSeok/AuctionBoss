/**
 * live-check-collector.sh dry-run용 임시 TS SQLite 만들기 (port-collector-to-spring tasks 8.3).
 *
 * 기존 TS 어댑터와 저장소를 루프백 가짜 소스 서버에 붙여 "TS가 같은 응답을 저장했다면"의 SQLite를 만든다. 실제 운영 DB(data/)는
 * 열지 않고, 외부 요청은 하지 않는다(루프백이 아니면 거부).
 *
 *   npx tsx --tsconfig scripts/dev/tsconfig.snapshot.json scripts/dev/make-dryrun-sqlite.ts <baseUrl> <sqlite 경로> [옵션]
 *     --recent-run   15분 안에 끝난 TS 수집 회차 기록을 넣는다(사전 확인이 실패하는 경로 확인용)
 *     --backoff      남은 백오프를 넣는다
 *     --stale-run    오래된 TS 회차 기록만 넣는다(사전 확인 통과 경로용)
 */
import { CourtAuctionAdapter, type Logger } from "../../src/lib/sources";
import { closeDb, createCollectorStateRepository, createRepository, openDatabase } from "../../src/lib/db";
import { loopbackOnlyFetch } from "../collector-golden/loopback";

const silent: Logger = { info() {}, warn() {}, error() {} };

async function main() {
  const [baseUrl, dbPath, ...flags] = process.argv.slice(2);
  if (!baseUrl || !dbPath) {
    console.error("사용법: make-dryrun-sqlite.ts <baseUrl> <sqlite 경로> [--recent-run|--backoff|--stale-run]");
    process.exit(2);
  }
  const adapter = new CourtAuctionAdapter({ baseUrl, fetchFn: loopbackOnlyFetch, logger: silent, sleep: async () => {} });
  const { items } = await adapter.fetchActiveItems({ courts: [{ name: "서울중앙지방법원", courtCode: "B000210" }] });
  const db = openDatabase(dbPath);
  try {
    const { inserted } = createRepository(db).upsertItems(items);
    const run = (minutesAgo: number) => {
      const at = (m: number) => new Date(Date.now() - m * 60000).toISOString();
      db.prepare(
        "INSERT INTO worker_runs (worker, started_at, finished_at, outcome, created_at) VALUES ('collector', ?, ?, 'success', ?)",
      ).run(at(minutesAgo + 1), at(minutesAgo), at(minutesAgo));
    };
    if (flags.includes("--recent-run")) run(3);
    if (flags.includes("--stale-run")) run(120);
    if (flags.includes("--backoff")) {
      createCollectorStateRepository(db).extendBackoffUntil(new Date(Date.now() + 30 * 60000));
    }
    console.log(`임시 TS SQLite: 물건 ${inserted}건`);
  } finally {
    closeDb();
    db.close();
  }
}

void main();
