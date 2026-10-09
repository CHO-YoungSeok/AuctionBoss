/**
 * 데이터 포트 선택(switch-web-to-data-port D2, migrate-data-and-cutover 8장).
 *
 * 원천은 Spring 백엔드(`spring`) 하나다. `AUCTIONBOSS_DATA_SOURCE`를 비우면 `spring`이고, 백엔드 주소는
 * `AUCTIONBOSS_SPRING_BASE`로 받는다. 은퇴한 값 `sqlite`는 은퇴했음을 알리는 오류, 알 수 없는 값·주소 없음·
 * `http(s)`가 아닌 주소는 허용 값(또는 필요한 설정)을 담은 오류로 던진다 — 다른 원천으로 대신 동작하거나
 * 데이터베이스 파일을 만들지 않는다. 처음 불릴 때 한 번 읽어 프로세스 안에서 재사용한다.
 *
 * 서버 전용이다(`server-only`). Spring 주소가 브라우저 번들에 들어가면 안 된다.
 */
import "server-only";

import { DataSourceConfigError, type DataPort } from "./port";
import { createSpringPort } from "./spring/port";

export * from "./port";

export const DATA_SOURCES = ["spring"] as const;
export type DataSourceKind = (typeof DATA_SOURCES)[number];

export type DataSourceConfig = { kind: "spring"; baseUrl: string };

/** 환경 변수에서 원천 설정을 읽고 검증한다. 잘못되면 `DataSourceConfigError`. */
export function resolveDataSourceConfig(
  env: Record<string, string | undefined> = process.env,
): DataSourceConfig {
  const raw = env.AUCTIONBOSS_DATA_SOURCE?.trim();
  const kind = raw === undefined || raw === "" ? "spring" : raw;
  if (kind === "sqlite") {
    throw new DataSourceConfigError(
      "AUCTIONBOSS_DATA_SOURCE=sqlite는 은퇴했습니다. Spring 백엔드(spring)만 지원합니다 — " +
        "AUCTIONBOSS_DATA_SOURCE를 비우거나 spring으로 두고 AUCTIONBOSS_SPRING_BASE를 설정하세요",
    );
  }
  if (kind !== "spring") {
    throw new DataSourceConfigError(
      `AUCTIONBOSS_DATA_SOURCE 값이 올바르지 않습니다: "${kind}" (허용 값: ${DATA_SOURCES.join(", ")})`,
    );
  }
  const base = env.AUCTIONBOSS_SPRING_BASE?.trim();
  if (!base) {
    throw new DataSourceConfigError(
      "AUCTIONBOSS_SPRING_BASE(예: http://localhost:8080)가 필요합니다",
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
  return createSpringPort({ baseUrl: config.baseUrl });
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
