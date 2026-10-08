/**
 * 화면 렌더 테스트를 두 원천으로 돌리는 도우미(switch-web-to-data-port 5.4, design D6 ③).
 *
 * 준비(데이터 넣기)는 지금처럼 SQLite 저장소 함수로 하고, `spring`이면 포트만 Next 핸들러 대역 `fetch`를
 * 쓰는 Spring 구현체로 바꾼다. 기대값은 원천과 무관하게 하나다.
 */
import { afterEach, beforeEach } from "vitest";

import { setDataPortForTesting } from "../index";
import type { DataPort } from "../port";
import type { SpringRequestRecord } from "../spring/client";
import { createSpringPort } from "../spring/port";
import { createSqlitePort } from "../sqlite";
import { createNextStandIn, type NextStandIn } from "./next-stand-in";

export const DATA_SOURCES_UNDER_TEST = ["sqlite", "spring"] as const;
export type DataSourceUnderTest = (typeof DATA_SOURCES_UNDER_TEST)[number];

export interface TestPort {
  port: DataPort;
  /** `spring`일 때만. 받은 요청 기록. */
  standIn: NextStandIn | null;
  /** `spring`일 때 Spring 구현체가 보낸 요청(쿼리 값 없음). */
  sent: SpringRequestRecord[];
}

export function createTestPort(source: DataSourceUnderTest): TestPort {
  if (source === "sqlite") return { port: createSqlitePort(), standIn: null, sent: [] };
  const standIn = createNextStandIn();
  const sent: SpringRequestRecord[] = [];
  const port = createSpringPort({
    baseUrl: "http://spring.test:8080",
    fetch: standIn.fetch,
    onRequest: (record) => sent.push(record),
  });
  return { port, standIn, sent };
}

/** `describe` 안에서 부른다. 테스트마다 포트를 끼우고 끝나면 되돌린다. */
export function useDataSource(source: DataSourceUnderTest): void {
  beforeEach(() => setDataPortForTesting(createTestPort(source).port));
  afterEach(() => setDataPortForTesting(null));
}
