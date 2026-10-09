/**
 * 데이터 포트의 SQLite 구현체(switch-web-to-data-port D1·D2). 화면 코드가 SQLite에 닿는 유일한 지점이다.
 *
 * 기존 저장소 함수를 비동기로 감쌀 뿐 동작을 바꾸지 않는다.
 *  - `db`를 주면 그 연결로 저장소를 만든다(테스트). 안 주면 메서드가 처음 불릴 때 `getDb()`를 연다 —
 *    그래서 `spring` 모드에서는 이 모듈이 로드돼도 SQLite 파일이 열리지 않는다.
 *  - 판정의 "지금"은 저장소 기본값(`new Date()`)이다. `options.now`는 테스트가 시각을 못박는 용도다.
 */
import "server-only";

import {
  COLLECTOR_STATE_KEYS,
  createBookmarksRepository,
  createCollectorStateRepository,
  createRepository,
  createWorkerRunsRepository,
  getBookmarksRepository,
  getDb,
  getCollectorStateRepository,
  getRepository,
  getWorkerRunsRepository,
  type BookmarksRepository,
  type CollectorStateRepository,
  type AuctionRepository,
  type Db,
  type WorkerRunsRepository,
} from "@/lib/db";
import { readPhotoFile } from "@/lib/storage/photos";

import type { DataPort, ItemPhotoMeta, PhotoFile } from "./port";

export interface SqlitePortOptions {
  /** 워커 상태 판정의 "지금". 생략하면 호출 시점의 실제 시각. */
  now?: () => Date;
}

const PHOTO_CACHE_CONTROL = "public, max-age=86400, immutable";

interface Repositories {
  items: AuctionRepository;
  bookmarks: BookmarksRepository;
  runs: WorkerRunsRepository;
  collectorState: CollectorStateRepository;
}

export function createSqlitePort(db?: Db, options: SqlitePortOptions = {}): DataPort {
  const fixed: Repositories | null = db
    ? {
        items: createRepository(db),
        bookmarks: createBookmarksRepository(db),
        runs: createWorkerRunsRepository(db),
        collectorState: createCollectorStateRepository(db),
      }
    : null;
  // db를 안 줬으면 호출 때마다 기본 연결의 저장소를 얻는다(테스트가 연결을 바꿔도 따라간다).
  const repos = (): Repositories =>
    fixed ?? {
      items: getRepository(),
      bookmarks: getBookmarksRepository(),
      runs: getWorkerRunsRepository(),
      collectorState: getCollectorStateRepository(),
    };

  return {
    async health() {
      (db ?? getDb()).prepare("SELECT 1").get();
    },
    async listItems(query) {
      return repos().items.listItems(query);
    },
    async getItemById(id) {
      return repos().items.getItemById(id);
    },
    async listFilterOptions() {
      const { items } = repos();
      return {
        usageTypes: items.listUsageTypes(),
        sidoValues: items.listSidoValues(),
        sigunguValues: items.listSigunguValues(),
        courtValues: items.listCourtValues(),
      };
    },
    async getAnalysisHistory(id, { limit }) {
      const { items } = repos();
      return { analyses: items.listAnalyses(id, { limit }), total: items.countAnalyses(id) };
    },
    async listItemChanges(id) {
      return repos().items.listItemChanges(id);
    },
    async listItemPhotos(id) {
      // 서버 파일 경로는 포트 밖으로 내보내지 않는다.
      return repos().items.getItemPhotos(id).map(
        (p): ItemPhotoMeta => ({
          id: p.id,
          itemId: p.itemId,
          seq: p.seq,
          fileSize: p.fileSize,
          mimeType: p.mimeType,
          collectedAt: p.collectedAt,
        }),
      );
    },
    async getUnreadCount() {
      return repos().bookmarks.getUnreadCount();
    },
    async listBookmarkedItems({ page }) {
      return repos().bookmarks.listBookmarkedItems({ page });
    },
    async listFeed({ page }) {
      return repos().bookmarks.listFeed({ page });
    },
    async getWorkerStatus(worker) {
      const now = options.now?.().toISOString();
      return repos().runs.getWorkerStatus(worker, now === undefined ? undefined : { now });
    },
    async summarizeRuns({ worker, since }) {
      return repos().runs.summarizeRuns({ worker, since });
    },
    async listWorkerRuns({ worker, pageSize }) {
      return repos().runs.listWorkerRuns({ worker, pageSize });
    },
    async getRotationNextCourtCode() {
      return repos().collectorState.getCollectorState(COLLECTOR_STATE_KEYS.ROTATION_NEXT_COURT_CODE);
    },
    async addBookmark(id) {
      repos().bookmarks.addBookmark(id);
    },
    async removeBookmark(id) {
      repos().bookmarks.removeBookmark(id);
    },
    async markFeedRead() {
      repos().bookmarks.markFeedRead();
    },
    async getPhotoFile(itemId, seq): Promise<PhotoFile> {
      const photo = repos().items.getItemPhotos(itemId).find((p) => p.seq === seq);
      if (!photo) return { status: 404, message: "Not Found" };
      const buffer = readPhotoFile(photo.filePath);
      if (!buffer) return { status: 404, message: "File Not Found" };
      return {
        status: 200,
        body: new Uint8Array(buffer),
        contentType: photo.mimeType,
        cacheControl: PHOTO_CACHE_CONTROL,
      };
    },
  };
}
