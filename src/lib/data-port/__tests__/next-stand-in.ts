/**
 * Spring 대역 `fetch`(switch-web-to-data-port 5.1, design D6 ②③).
 *
 * Spring 대신 같은 경로·형태의 Next 라우트 핸들러(기존 JSON API + 3장의 화면용 읽기 라우트)를 같은
 * 프로세스에서 부른다. 라우트는 `AUCTIONBOSS_DB`의 SQLite를 읽으므로 테스트가 넣은 데이터로 바로
 * 응답한다. 받은 요청은 `(메서드, 경로 틀, 쿼리 키 집합)`으로 기록한다 — 골든 포함 검사(5.3)와
 * 요청 수 검사(5.5)가 쓴다. 이 틀이 Spring 실제 응답과 같다는 증명은 골든(`ScenarioContractTest`)이다.
 */
import * as analysesSave from "@/app/api/analyses/route";
import * as bookmarkById from "@/app/api/bookmarks/[itemId]/route";
import * as bookmarks from "@/app/api/bookmarks/route";
import * as feedRead from "@/app/api/feed/read/route";
import * as feed from "@/app/api/feed/route";
import * as rotation from "@/app/api/collector-state/rotation/route";
import * as filterOptions from "@/app/api/items/filter-options/route";
import * as itemAnalyses from "@/app/api/items/[id]/analyses/route";
import * as itemChanges from "@/app/api/items/[id]/changes/route";
import * as itemPhotos from "@/app/api/items/[id]/photos/route";
import * as itemById from "@/app/api/items/[id]/route";
import * as items from "@/app/api/items/route";
import * as photoFile from "@/app/api/photos/[itemId]/[seq]/route";
import * as runById from "@/app/api/worker-runs/[id]/route";
import * as runs from "@/app/api/worker-runs/route";
import * as runsStatus from "@/app/api/worker-runs/status/route";
import * as runsSummary from "@/app/api/worker-runs/summary/route";

import { getDataPort, setDataPortForTesting } from "../index";
import { createSqlitePort } from "../sqlite";

/** 받은 요청의 틀. 경로의 숫자·`{변수}` 구간은 `{id}`로, 쿼리는 키 집합(정렬)으로 줄인다. */
export interface RequestShape {
  method: string;
  path: string;
  queryKeys: string[];
}

export function requestShape(method: string, pathname: string, queryKeys: Iterable<string>): RequestShape {
  const path = pathname
    .split("/")
    .map((segment) => (/^-?\d+$/.test(segment) || /^\{\w+\}$/.test(segment) ? "{id}" : segment))
    .join("/");
  return { method: method.toUpperCase(), path, queryKeys: [...new Set(queryKeys)].sort() };
}

export function shapeKey(shape: RequestShape): string {
  return `${shape.method} ${shape.path}${shape.queryKeys.length > 0 ? `?${shape.queryKeys.join("&")}` : ""}`;
}

/**
 * 사진 라우트는 포트(`getDataPort()`)를 쓴다. Spring 대역이 Spring 구현체를 다시 부르면 무한히 돌므로,
 * 대역 안에서는 SQLite 구현체로 바꿔 끼우고 끝나면 되돌린다(대역은 "Spring 쪽"이다).
 */
async function withSqlitePort<T>(run: () => Promise<T>): Promise<T> {
  const previous = getDataPort();
  setDataPortForTesting(createSqlitePort());
  try {
    return await run();
  } finally {
    setDataPortForTesting(previous);
  }
}

async function dispatch(method: string, pathname: string, req: Request): Promise<Response> {
  const key = `${method} ${pathname}`;
  switch (key) {
    case "GET /api/items":
      return items.GET(req);
    case "GET /api/items/filter-options":
      return filterOptions.GET();
    case "GET /api/bookmarks":
      return bookmarks.GET(req);
    case "POST /api/bookmarks":
      return bookmarks.POST(req);
    case "GET /api/feed":
      return feed.GET(req);
    case "POST /api/feed/read":
      return feedRead.POST();
    case "GET /api/worker-runs":
      return runs.GET(req);
    case "POST /api/worker-runs":
      return runs.POST(req);
    case "GET /api/worker-runs/summary":
      return runsSummary.GET(req);
    case "GET /api/worker-runs/status":
      return runsStatus.GET(req);
    case "GET /api/collector-state/rotation":
      return rotation.GET();
    case "POST /api/analyses":
      return analysesSave.POST(req);
  }
  const params = <T extends Record<string, string>>(value: T): Promise<T> => Promise.resolve(value);
  let m: RegExpExecArray | null;
  if (method === "GET" && (m = /^\/api\/items\/([^/]+)\/analyses$/.exec(pathname)))
    return itemAnalyses.GET(req, { params: params({ id: m[1] }) });
  if (method === "GET" && (m = /^\/api\/items\/([^/]+)\/changes$/.exec(pathname)))
    return itemChanges.GET(req, { params: params({ id: m[1] }) });
  if (method === "GET" && (m = /^\/api\/items\/([^/]+)\/photos$/.exec(pathname)))
    return itemPhotos.GET(req, { params: params({ id: m[1] }) });
  if (method === "GET" && (m = /^\/api\/items\/([^/]+)$/.exec(pathname)))
    return itemById.GET(req, { params: params({ id: m[1] }) });
  if (method === "DELETE" && (m = /^\/api\/bookmarks\/([^/]+)$/.exec(pathname)))
    return bookmarkById.DELETE(req, { params: params({ itemId: m[1] }) });
  if (method === "PATCH" && (m = /^\/api\/worker-runs\/([^/]+)$/.exec(pathname)))
    return runById.PATCH(req, { params: params({ id: m[1] }) });
  if (method === "GET" && (m = /^\/api\/photos\/([^/]+)\/([^/]+)$/.exec(pathname)))
    return withSqlitePort(() => photoFile.GET(req as never, { params: params({ itemId: m![1], seq: m![2] }) }));
  throw new Error(`Next 대역이 지원하지 않는 요청: ${key}`);
}

export interface NextStandIn {
  fetch: typeof fetch;
  /** 지금까지 받은 요청(순서대로). */
  readonly requests: RequestShape[];
  reset(): void;
}

export function createNextStandIn(): NextStandIn {
  const requests: RequestShape[] = [];
  const standInFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    requests.push(requestShape(method, url.pathname, url.searchParams.keys()));
    const req = new Request(url, { method, body: init?.body ?? null, headers: init?.headers });
    return dispatch(method, url.pathname, req);
  };
  return {
    fetch: standInFetch as typeof fetch,
    requests,
    reset() {
      requests.length = 0;
    },
  };
}
