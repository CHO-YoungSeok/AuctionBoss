/**
 * 화면 HTML 기준선 스냅샷 (switch-web-to-data-port 1.3).
 *
 * 시드 SQLite(`seed-to-sqlite`)와 고정 시계로 화면 5개와 변형을 서버 컴포넌트 직접 호출로 렌더해
 * HTML을 디렉터리에 저장한다. 데이터 접근을 포트로 옮기는 작업 전후에 같은 명령을 돌려 바이트 단위로
 * 비교한다(`diff -r`). 운영 DB를 열지 않고(임시 SQLite), 외부 요청도 없다.
 *
 * 사용: npx tsx --tsconfig scripts/dev/tsconfig.snapshot.json scripts/dev/snapshot-screens.ts <출력 디렉터리>
 * (루트 tsconfig의 jsx가 preserve라 tsx가 JSX를 변환하려면 automatic 런타임 설정이 필요하다)
 *
 * 변형은 두 단계로 만든다.
 *  - 1단계(시드 그대로): 목록 필터·정렬·2페이지, 상세 분석 있음·없음·사진 대기·조회 불가·404,
 *    관심·피드 빈 상태, 상태 화면.
 *  - 2단계(쓰기 후): 관심 2건·분석 이력 13건·사진 수집됨/없음, 읽음 처리 후 관심·피드·상세·상태 화면.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { seedToSqlite } from "../seed/seed-to-sqlite";
import { withFixedNow } from "../seed/fixed-clock";

/** 모든 시각 표시와 쓰기 시각이 이 값으로 고정된다. */
export const SNAPSHOT_NOW = "2026-10-05T03:00:00.000Z";
const WRITE_NOW = "2026-10-05T02:00:00.000Z";

type Page = (props: never) => unknown;

interface Variant {
  name: string;
  load: () => Promise<Page>;
  props: unknown;
}

const root = path.resolve(__dirname, "../..");
const pageModule = (rel: string) => async () =>
  ((await import(path.join(root, "src/app", rel, "page.tsx"))) as { default: Page }).default;

function listVariant(name: string, params: Record<string, string | string[]>): Variant {
  return { name, load: pageModule("."), props: { searchParams: Promise.resolve(params) } };
}
function detailVariant(name: string, id: string): Variant {
  return { name, load: pageModule("items/[id]"), props: { params: Promise.resolve({ id }) } };
}
function simpleVariant(name: string, rel: string, params: Record<string, string> = {}): Variant {
  return { name, load: pageModule(rel), props: { searchParams: Promise.resolve(params) } };
}

async function renderVariant(v: Variant): Promise<string> {
  const page = await v.load();
  try {
    const element = await (page as (p: unknown) => unknown)(v.props);
    return renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
  } catch (error) {
    const digest = (error as { digest?: string }).digest;
    if (typeof digest === "string" && digest.includes("404")) return "<!-- notFound() -->";
    throw error;
  }
}

const PHASE1: Variant[] = [
  listVariant("list-default", {}),
  listVariant("list-sort-page2", { sort: "minBidPrice", dir: "desc", page: "2" }),
  listVariant("list-filter-usage-failed", { usage: "상가,오피스텔,근린시설", minFailed: "1" }),
  listVariant("list-filter-sido-court", { sido: "서울특별시", court: "서울중앙지방법원", sort: "bidRatio" }),
  listVariant("list-analyzed", { analyzed: "true" }),
  listVariant("list-empty-filtered", { q: "존재하지않는주소키워드" }),
  listVariant("list-lenient-garbage", { sort: "nope", minPrice: "abc", page: "0" }),
  detailVariant("detail-analyzed", "1"),
  detailVariant("detail-no-analysis-photo-pending", "3"),
  detailVariant("detail-photo-unavailable", "2"),
  detailVariant("detail-not-found", "999999"),
  detailVariant("detail-bad-id", "abc"),
  simpleVariant("bookmarks-empty", "bookmarks"),
  simpleVariant("feed-empty", "feed"),
  simpleVariant("status-seed", "status"),
];

const PHASE2: Variant[] = [
  listVariant("p2-list-bookmarked", { bookmarked: "true" }),
  listVariant("p2-list-default", {}),
  detailVariant("p2-detail-many-analyses", "1"),
  detailVariant("p2-detail-photos-collected", "4"),
  detailVariant("p2-detail-photo-empty", "5"),
  simpleVariant("p2-bookmarks", "bookmarks"),
  simpleVariant("p2-bookmarks-page2", "bookmarks", { page: "2" }),
  simpleVariant("p2-feed-unread", "feed"),
  simpleVariant("p2-feed-page2", "feed", { page: "2" }),
  simpleVariant("p2-status-runs", "status"),
];

/** 2단계 쓰기. 저장소 함수를 직접 쓴다(포트 이전과 무관하게 같은 데이터가 만들어져야 한다). */
async function applyWrites(): Promise<void> {
  const db = await import(path.join(root, "src/lib/db/index.ts"));
  for (const id of [1, 3, 5]) db.addBookmark(id, { now: WRITE_NOW });
  for (let i = 1; i <= 13; i++) {
    db.insertAnalysis(
      { itemId: 1, body: `## 재분석 ${i}\n\n본문 ${i}`, model: "claude-test", promptVersion: i % 2 === 0 ? "v1" : "v0" },
      { now: new Date(Date.parse(WRITE_NOW) - (14 - i) * 3600_000).toISOString() },
    );
  }
  db.getRepository().saveItemPhotos(
    4,
    [
      { seq: 1, filePath: "4/1.jpg", fileSize: 1234, mimeType: "image/jpeg" },
      { seq: 2, filePath: "4/2.png", fileSize: 4321, mimeType: "image/png" },
    ],
    "collected",
    { now: WRITE_NOW },
  );
  db.getRepository().updateItemPhotoStatus(5, "empty", { now: WRITE_NOW });
  db.markFeedRead("2026-09-20T00:00:00.000Z"); // 일부만 읽은 상태(미확인이 남는다)
  const runId = db.startRun("collector", { now: "2026-10-05T02:30:00.000Z" });
  db.finishRun(runId, { outcome: "success", detail: undefined }, { now: "2026-10-05T02:31:00.000Z" });
  db.recordSkippedRun("analyzer", "backoff", { now: "2026-10-05T02:40:00.000Z" });
  db.startRun("photos", { now: "2026-10-05T02:50:00.000Z" });
}

export async function snapshotScreens(outDir: string): Promise<string[]> {
  const workDir = mkdtempSync(path.join(tmpdir(), "auctionboss-snapshot-"));
  const originalDb = process.env.AUCTIONBOSS_DB;
  process.env.AUCTIONBOSS_DB = path.join(workDir, "snapshot.db");
  seedToSqlite(process.env.AUCTIONBOSS_DB);
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  try {
    const render = async (variants: Variant[]) => {
      for (const v of variants) {
        const html = await withFixedNow(SNAPSHOT_NOW, () => renderVariant(v));
        writeFileSync(path.join(outDir, `${v.name}.html`), html);
        written.push(v.name);
      }
    };
    await render(PHASE1);
    await withFixedNow(SNAPSHOT_NOW, applyWrites);
    await render(PHASE2);
  } finally {
    const { closeDb } = await import(path.join(root, "src/lib/db/index.ts"));
    closeDb();
    if (originalDb === undefined) delete process.env.AUCTIONBOSS_DB;
    else process.env.AUCTIONBOSS_DB = originalDb;
    rmSync(workDir, { recursive: true, force: true });
  }
  return written;
}

if (require.main === module) {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error("사용: npx tsx --tsconfig scripts/dev/tsconfig.snapshot.json scripts/dev/snapshot-screens.ts <출력 디렉터리>");
    process.exit(2);
  }
  snapshotScreens(path.resolve(outDir)).then(
    (names) => console.log(`${names.length}개 저장: ${outDir}`),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
