/**
 * 데이터 포트(switch-web-to-data-port design.md D1) — 화면이 쓰는 데이터 접근의 전부.
 *
 * 화면(페이지·컴포넌트)과 화면용 라우트(관심 토글, 읽음 처리, 사진 파일)는 이 인터페이스만
 * 안다. 구현체는 둘이다: SQLite(`sqlite.ts`, 지금의 저장소 함수를 감쌈)와 Spring(`spring/port.ts`,
 * 서버에서만 HTTP). 이 파일은 `@/lib/db`를 가져오지 않는다(타입도 마찬가지) — 포트의 계약이
 * 저장소 구현에 기대지 않게 하려는 것이다.
 *
 * ## 계약 요약
 * - 모든 메서드는 `Promise`를 돌려준다. 반환 타입은 화면이 받던 `@/lib/domain` 타입 그대로다.
 * - 판정의 "지금"은 데이터를 가진 쪽의 시각이다(`getWorkerStatus`, `markFeedRead`에 `now`가 없다).
 * - 없는 물건: `getItemById`는 `null`, 목록형 조회(`getAnalysisHistory`, `listItemChanges`,
 *   `listItemPhotos`)는 빈 결과, `addBookmark`/`removeBookmark`는 `ItemNotFoundError`.
 *   Spring 구현체는 404를 같은 값으로 바꿔야 한다.
 * - 구현체는 도메인 오류(`ItemNotFoundError`)와 `DataSourceError`만 던진다.
 */
import type {
  Analysis,
  AuctionItem,
  FeedEntry,
  ItemChange,
  ItemPhoto,
  ItemQuery,
  WorkerKind,
  WorkerRun,
  WorkerStatus,
} from "@/lib/domain";

export { ItemNotFoundError } from "@/lib/domain";

/** 사진 목록 한 건. 서버 파일 경로(`filePath`)는 HTTP 응답에 싣지 않는다(spec "사진 목록 API 호환"). */
export type ItemPhotoMeta = Omit<ItemPhoto, "filePath">;

export interface ItemListResult {
  items: AuctionItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface FeedListResult {
  entries: FeedEntry[];
  total: number;
  page: number;
  pageSize: number;
}

/** 목록 화면의 필터 선택지(용도·시도·시군구·법원). 저장된 데이터에서 도출하며 정렬되어 있다. */
export interface FilterOptions {
  usageTypes: string[];
  sidoValues: string[];
  sigunguValues: string[];
  courtValues: string[];
}

/** 최신순 분석 `limit`건과 잘리지 않은 전체 건수. */
export interface AnalysisHistory {
  analyses: Analysis[];
  total: number;
}

export interface WorkerRunListResult {
  runs: WorkerRun[];
  total: number;
  page: number;
  pageSize: number;
}

export interface RunsSummaryResult {
  totalRuns: number;
  successCount: number;
  failedCount: number;
  blockedCount: number;
  skippedCount: number;
  runningCount: number;
  successRate: number | null;
  itemsChanged: number;
}

/**
 * 사진 파일 읽기 결과. 화면용 사진 라우트가 상태·본문·헤더를 그대로 응답에 옮긴다.
 * 오류 본문 문자열은 두 구현체가 같아야 한다(`Not Found`: 사진 기록 없음, `File Not Found`:
 * 기록은 있으나 파일 없음).
 */
export type PhotoFile =
  | { status: 200; body: Uint8Array; contentType: string; cacheControl: string }
  | { status: 400 | 404; message: string };

export interface DataPort {
  // ---- 상태 ----
  /**
   * 원천이 응답하는지 묻는다(`/api/health`용). 정상이면 값 없이 끝나고, 아니면 던진다.
   * Spring 원천은 백엔드 `/api/health`를 부르며(SQLite 파일을 열지 않는다), SQLite 원천은 `SELECT 1`이다.
   * 던지는 오류에는 원인 문자열을 담지 않는다(주소·쿼리 같은 값이 응답으로 새지 않게).
   */
  health(): Promise<void>;

  // ---- 읽기 13 ----
  /** 화면 조건(`parseItemQueryLenient` 결과)과 `{ pageSize: 1 }`, `{ analyzed: true, pageSize: 1 }` 같은 건수 조회. */
  listItems(query: ItemQuery): Promise<ItemListResult>;
  getItemById(id: number): Promise<AuctionItem | null>;
  listFilterOptions(): Promise<FilterOptions>;
  /** 최신순 `limit`건과 전체 건수. 없는 물건은 `{ analyses: [], total: 0 }`. */
  getAnalysisHistory(id: number, options: { limit: number }): Promise<AnalysisHistory>;
  listItemChanges(id: number): Promise<ItemChange[]>;
  listItemPhotos(id: number): Promise<ItemPhotoMeta[]>;
  getUnreadCount(): Promise<number>;
  listBookmarkedItems(query: { page: number }): Promise<ItemListResult>;
  listFeed(query: { page: number }): Promise<FeedListResult>;
  /** "지금"은 데이터를 가진 쪽의 서버 시각이다. */
  getWorkerStatus(worker: WorkerKind): Promise<WorkerStatus>;
  summarizeRuns(query: { worker: WorkerKind; since: string }): Promise<RunsSummaryResult>;
  listWorkerRuns(query: { worker: WorkerKind; pageSize: number }): Promise<WorkerRunListResult>;
  /** 다음 로테이션 법원 코드. 기록이 없으면 `null`. */
  getRotationNextCourtCode(): Promise<string | null>;

  // ---- 쓰기 3 ----
  /** 중복 등록은 조용히 무시한다. 없는 물건은 `ItemNotFoundError`. */
  addBookmark(id: number): Promise<void>;
  /** 담기지 않은 물건의 해제는 오류가 아니다. 없는 물건은 `ItemNotFoundError`. */
  removeBookmark(id: number): Promise<void>;
  /** 읽음 시각은 데이터를 가진 쪽이 정한다. */
  markFeedRead(): Promise<void>;

  // ---- 파일 1 ----
  getPhotoFile(itemId: number, seq: number): Promise<PhotoFile>;
}

/**
 * 데이터 원천에서 값을 얻지 못했을 때(Spring 연결 실패·시간 초과·기대하지 않은 상태·스키마 불일치).
 * 화면 요청은 이 오류로 끝나며 다른 원천으로 대신 읽지 않는다. 메시지에는 메서드와 경로만 담고
 * 쿼리 값(주소 검색어 등)은 담지 않는다.
 */
export class DataSourceError extends Error {
  override readonly name = "DataSourceError";
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number | null,
    override readonly cause?: unknown,
  ) {
    super(
      `데이터 원천 오류: ${method} ${path}` +
        (status !== null ? ` (상태 ${status})` : "") +
        (cause instanceof Error ? ` - ${cause.message}` : ""),
    );
  }
}

/** `AUCTIONBOSS_DATA_SOURCE` 설정 오류. 허용 값을 메시지에 담는다. */
export class DataSourceConfigError extends Error {
  override readonly name = "DataSourceConfigError";
}
