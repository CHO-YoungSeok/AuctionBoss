/**
 * Spring 구현체 자리표시자(switch-web-to-data-port tasks 4장에서 구현한다).
 *
 * `index.ts`가 이 시그니처로 연결해 두었으므로 4장은 이 파일만 채우면 된다.
 */
import "server-only";

import { DataSourceError, type DataPort } from "../port";

export interface SpringPortOptions {
  baseUrl: string;
  /** 테스트가 대역 `fetch`를 주입한다. 기본은 전역 `fetch`. */
  fetch?: typeof fetch;
}

export function createSpringPort(options: SpringPortOptions): DataPort {
  throw new DataSourceError(
    "createSpringPort",
    options.baseUrl,
    null,
    new Error("Spring 데이터 포트 구현체는 아직 구현되지 않았습니다(tasks 4장)"),
  );
}
