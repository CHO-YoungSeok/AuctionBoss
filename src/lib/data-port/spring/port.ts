/**
 * Spring 구현체(switch-web-to-data-port D1·D3, 4장). 서버에서만 `fetch`로 Spring API를 부른다.
 *
 * 메서드와 엔드포인트의 대응은 design.md D1 표를 따른다. 404는 SQLite 구현체와 같은 값으로 바꾼다:
 * 물건 없음 → `null`, 이력·사진 목록 → 빈 결과, 관심 등록·해제 → `ItemNotFoundError`. 그 밖의
 * 실패(연결·시간 초과·기대하지 않은 상태·스키마 불일치)는 `DataSourceError`다.
 */
import "server-only";

import type { z } from "zod";

import { ItemNotFoundError, itemQuerySearchParams } from "@/lib/domain";

import { DataSourceError, type DataPort, type PhotoFile } from "../port";
import { createSpringClient, type SpringRequestRecord } from "./client";
import {
  analysisHistoryResponseSchema,
  bookmarkAddResponseSchema,
  bookmarkRemoveResponseSchema,
  feedReadResponseSchema,
  feedResponseSchema,
  filterOptionsResponseSchema,
  itemChangesResponseSchema,
  itemDetailResponseSchema,
  itemListResponseSchema,
  itemPhotosResponseSchema,
  rotationResponseSchema,
  runsSummaryResponseSchema,
  workerRunListResponseSchema,
  workerStatusSchema,
} from "./schemas";

export interface SpringPortOptions {
  baseUrl: string;
  /** 테스트가 대역 `fetch`를 주입한다. 기본은 전역 `fetch`. */
  fetch?: typeof fetch;
  /** 요청 시간 제한(ms). 기본 5000. */
  timeoutMs?: number;
  /** 보낸 요청마다 불린다(요청 수 확인용). 쿼리 값은 담지 않는다. */
  onRequest?: (record: SpringRequestRecord) => void;
}

function params(entries: Record<string, string | number>): URLSearchParams {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) search.set(key, String(value));
  return search;
}

export function createSpringPort(options: SpringPortOptions): DataPort {
  const client = createSpringClient(options);

  /** 200만 허용하는 GET. 404도 오류다. */
  async function get<S extends z.ZodTypeAny>(
    path: string,
    schema: S,
    search?: URLSearchParams,
  ): Promise<z.infer<S>> {
    const result = await client.json({ method: "GET", path, search, schema });
    if (!result.found) throw new DataSourceError("GET", path, 404, new Error("없는 경로"));
    return result.data;
  }

  return {
    async health() {
      const path = "/api/health";
      let response;
      try {
        response = await client.raw("GET", path);
      } catch (error) {
        // 원인 문자열(연결 오류가 주소를 담을 수 있다)은 버리고 메서드·경로·상태만 남긴다.
        if (error instanceof DataSourceError) throw new DataSourceError(error.method, error.path, error.status);
        throw new DataSourceError("GET", path, null);
      }
      if (response.status !== 200) throw new DataSourceError("GET", path, response.status);
    },
    async listItems(query) {
      // 직렬화가 워커 전용 필드를 받으면 던진다(조용히 버리지 않는다).
      return get("/api/items", itemListResponseSchema, itemQuerySearchParams(query));
    },
    async getItemById(id) {
      const result = await client.json({
        method: "GET",
        path: `/api/items/${id}`,
        schema: itemDetailResponseSchema,
        allowNotFound: true,
      });
      return result.found ? result.data.item : null;
    },
    async listFilterOptions() {
      return get("/api/items/filter-options", filterOptionsResponseSchema);
    },
    async getAnalysisHistory(id, { limit }) {
      const result = await client.json({
        method: "GET",
        path: `/api/items/${id}/analyses`,
        search: params({ limit }),
        schema: analysisHistoryResponseSchema,
        allowNotFound: true,
      });
      return result.found ? result.data : { analyses: [], total: 0 };
    },
    async listItemChanges(id) {
      const result = await client.json({
        method: "GET",
        path: `/api/items/${id}/changes`,
        schema: itemChangesResponseSchema,
        allowNotFound: true,
      });
      return result.found ? result.data.changes : [];
    },
    async listItemPhotos(id) {
      const result = await client.json({
        method: "GET",
        path: `/api/items/${id}/photos`,
        schema: itemPhotosResponseSchema,
        allowNotFound: true,
      });
      return result.found ? result.data.photos : [];
    },
    async getUnreadCount() {
      // 미확인 개수는 피드 응답에 들어 있다. 행은 1건만 받는다.
      const feed = await get("/api/feed", feedResponseSchema, params({ pageSize: 1 }));
      return feed.unreadCount;
    },
    async listBookmarkedItems({ page }) {
      return get("/api/bookmarks", itemListResponseSchema, params({ page }));
    },
    async listFeed({ page }) {
      const { entries, total, page: currentPage, pageSize } = await get(
        "/api/feed",
        feedResponseSchema,
        params({ page }),
      );
      return { entries, total, page: currentPage, pageSize };
    },
    async getWorkerStatus(worker) {
      return get("/api/worker-runs/status", workerStatusSchema, params({ worker }));
    },
    async summarizeRuns({ worker, since }) {
      return get("/api/worker-runs/summary", runsSummaryResponseSchema, params({ worker, since }));
    },
    async listWorkerRuns({ worker, pageSize }) {
      return get("/api/worker-runs", workerRunListResponseSchema, params({ worker, pageSize }));
    },
    async getRotationNextCourtCode() {
      return (await get("/api/collector-state/rotation", rotationResponseSchema)).nextCourtCode;
    },

    async addBookmark(id) {
      const result = await client.json({
        method: "POST",
        path: "/api/bookmarks",
        body: { itemId: id },
        schema: bookmarkAddResponseSchema,
        okStatuses: [200, 201],
        allowNotFound: true,
      });
      if (!result.found) throw new ItemNotFoundError(id);
    },
    async removeBookmark(id) {
      const result = await client.json({
        method: "DELETE",
        path: `/api/bookmarks/${id}`,
        schema: bookmarkRemoveResponseSchema,
        allowNotFound: true,
      });
      if (!result.found) throw new ItemNotFoundError(id);
    },
    async markFeedRead() {
      await client.json({
        method: "POST",
        path: "/api/feed/read",
        schema: feedReadResponseSchema,
      });
    },

    async getPhotoFile(itemId, seq): Promise<PhotoFile> {
      const path = `/api/photos/${itemId}/${seq}`;
      const response = await client.raw("GET", path);
      if (response.status === 200) {
        const contentType = response.headers.get("content-type");
        const cacheControl = response.headers.get("cache-control");
        if (contentType === null || cacheControl === null) {
          throw new DataSourceError("GET", path, 200, new Error("사진 응답에 필수 헤더가 없습니다"));
        }
        return { status: 200, body: response.bytes, contentType, cacheControl };
      }
      if (response.status === 400 || response.status === 404) {
        return { status: response.status, message: new TextDecoder().decode(response.bytes) };
      }
      throw new DataSourceError("GET", path, response.status, new Error("기대하지 않은 상태 코드"));
    },
  };
}
