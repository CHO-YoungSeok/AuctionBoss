/**
 * 커밋된 계약 골든(1단계 읽기 골든 + 시나리오 골든)에 든 요청 틀의 집합(switch-web-to-data-port 5.3).
 *
 * 골든은 Spring이 실제로 같은 응답을 낸다고 `ContractTest`·`ScenarioContractTest`가 증명한 요청이다.
 * `spring-requests-golden.test.ts`에서 Spring 구현체가 보낸 요청 틀이 모두 여기 있어야, "구현체가 이 요청을
 * 보낸다"(대역 fetch 테스트)와 "백엔드가 이 요청에 이 응답을 낸다"(골든)가 같은 요청 위에서 이어진다.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { requestShape, shapeKey, type RequestShape } from "./fake-backend";

export const CONTRACTS_DIR = path.resolve(__dirname, "../../../../backend/src/test/resources/contracts");

interface GoldenRequest {
  method?: string;
  path: string;
  query?: string;
}

function shapeOf(request: GoldenRequest): RequestShape {
  return requestShape(request.method ?? "GET", request.path, new URLSearchParams(request.query ?? "").keys());
}

/**
 * 성공(2xx) 응답을 증명한 골든만 센다. 400·404 골든은 같은 틀이라도 "정상 응답이 일치한다"는 것을
 * 증명하지 않는다(예: `GET /api/feed?pageSize=201`은 400이다).
 */
function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

/** `shapeKey` 문자열의 집합. */
export function loadGoldenShapes(dir: string = CONTRACTS_DIR): Set<string> {
  const keys = new Set<string>();
  const read = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));

  for (const name of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const golden = read(path.join(dir, name)) as { request: GoldenRequest; status: number };
    if (isSuccess(golden.status)) keys.add(shapeKey(shapeOf(golden.request)));
  }
  const scenarioDir = path.join(dir, "scenarios");
  for (const name of readdirSync(scenarioDir).filter((f) => f.endsWith(".json"))) {
    const golden = read(path.join(scenarioDir, name)) as {
      steps: { request: GoldenRequest; status: number }[];
    };
    for (const step of golden.steps) if (isSuccess(step.status)) keys.add(shapeKey(shapeOf(step.request)));
  }
  return keys;
}
