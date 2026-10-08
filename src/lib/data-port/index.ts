/**
 * 데이터 포트 선택(switch-web-to-data-port D2).
 *
 * `AUCTIONBOSS_DATA_SOURCE=sqlite|spring`(기본 `sqlite`)과 `AUCTIONBOSS_SPRING_BASE`로 원천을 고른다.
 * 처음 불릴 때 한 번 읽어 프로세스 안에서 재사용한다. 알 수 없는 값·주소 없음·`http(s)`가 아닌 주소는
 * 허용 값을 담은 오류로 던지며, 다른 원천으로 대신 동작하지 않는다.
 *
 * 서버 전용이다(`server-only`). Spring 주소가 브라우저 번들에 들어가면 안 된다.
 */
import "server-only";

import { DataSourceConfigError, type DataPort } from "./port";
import { createSpringPort } from "./spring/port";
import { createSqlitePort } from "./sqlite";

export * from "./port";

export const DATA_SOURCES = ["sqlite", "spring"] as const;
export type DataSourceKind = (typeof DATA_SOURCES)[number];

export type DataSourceConfig =
  | { kind: "sqlite" }
  | { kind: "spring"; baseUrl: string };

/** 환경 변수에서 원천 설정을 읽고 검증한다. 잘못되면 `DataSourceConfigError`. */
export function resolveDataSourceConfig(
  env: Record<string, string | undefined> = process.env,
): DataSourceConfig {
  const raw = env.AUCTIONBOSS_DATA_SOURCE?.trim();
  const kind = raw === undefined || raw === "" ? "sqlite" : raw;
  if (kind === "sqlite") return { kind };
  if (kind !== "spring") {
    throw new DataSourceConfigError(
      `AUCTIONBOSS_DATA_SOURCE 값이 올바르지 않습니다: "${kind}" (허용 값: ${DATA_SOURCES.join(", ")})`,
    );
  }
  const base = env.AUCTIONBOSS_SPRING_BASE?.trim();
  if (!base) {
    throw new DataSourceConfigError(
      "AUCTIONBOSS_DATA_SOURCE=spring이면 AUCTIONBOSS_SPRING_BASE(예: http://localhost:8080)가 필요합니다",
    );
  }
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new DataSourceConfigError(
      `AUCTIONBOSS_SPRING_BASE가 올바른 주소가 아닙니다: "${base}" (http:// 또는 https://로 시작해야 합니다)`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new DataSourceConfigError(
      `AUCTIONBOSS_SPRING_BASE는 http 또는 https 주소여야 합니다: "${base}"`,
    );
  }
  return { kind: "spring", baseUrl: url.toString() };
}

function createPort(config: DataSourceConfig): DataPort {
  return config.kind === "sqlite" ? createSqlitePort() : createSpringPort({ baseUrl: config.baseUrl });
}

let current: DataPort | undefined;

/** 화면과 화면용 라우트가 쓰는 포트. 처음 불릴 때 환경 변수로 정한다. */
export function getDataPort(): DataPort {
  current ??= createPort(resolveDataSourceConfig());
  return current;
}

/** 테스트 전용. 포트를 바꿔 끼우고 `null`이면 다음 `getDataPort()`가 환경 변수에서 다시 만든다. */
export function setDataPortForTesting(port: DataPort | null): void {
  current = port ?? undefined;
}
