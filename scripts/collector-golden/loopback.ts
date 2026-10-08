/**
 * Node 루프백 재생 서버 (port-collector-to-spring D5).
 *
 * 127.0.0.1에만 바인딩하고, 준비한 응답을 받은 순서대로 한 번씩 돌려주며 받은 요청(메서드, 경로,
 * 받은 순서 그대로의 헤더, 본문)을 기록한다. 외부 사이트에는 절대 요청하지 않는다. 어댑터에는 이
 * 서버의 주소만 넘기고, `loopbackOnlyFetch`가 다른 호스트로 가는 요청을 한 번 더 막는다.
 *
 * 기록 값에서 서버 주소(`127.0.0.1:<임의 포트>`)는 자리표시자로 바꾼다. 포트가 매번 달라 골든이
 * 비결정적이 되기 때문이다: 헤더·본문·오류 메시지의 `http://127.0.0.1:<포트>`는 `{base}`로,
 * `host` 헤더 값은 `{host}`로 쓴다.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export const BASE_PLACEHOLDER = "{base}";
export const HOST_PLACEHOLDER = "{host}";

export interface ReplayResponse {
  status: number;
  /** `Set-Cookie` 헤더 값들. */
  setCookie?: string[];
  body: string;
  /** true면 응답 대신 소켓을 끊는다(연결 끊김 재현). */
  closeSocket?: boolean;
}

export interface RecordedRequest {
  method: string;
  path: string;
  /** 서버가 받은 순서 그대로의 [이름, 값]. 이름은 클라이언트가 보낸 대소문자 그대로다. */
  headers: [string, string][];
  /** 본문 원문(없으면 빈 문자열). */
  body: string;
}

export interface LoopbackResult<T> {
  result: T;
  requests: RecordedRequest[];
  /** 동시에 처리 중이던 요청 수의 최대값. */
  maxConcurrent: number;
}

/** 루프백 주소가 아닌 곳으로 가는 요청을 막는 fetch. 실제 `fetch`를 그대로 부른다. */
export async function loopbackOnlyFetch(input: string, init?: RequestInit): Promise<Response> {
  const host = new URL(input).hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(`외부 요청 금지: ${host}`);
  }
  return await fetch(input, init);
}

/**
 * 응답 목록을 순서대로 재생하는 서버를 띄우고 `fn(baseUrl, requests)`를 실행(requests는 지금까지 받은 요청이 쌓이는 배열)한 뒤 서버를 닫는다.
 * 준비한 응답보다 요청이 많으면 500과 안내 문구를 돌려준다(골든 작성 실수를 드러내기 위해).
 */
export async function withLoopbackServer<T>(
  responses: readonly ReplayResponse[],
  fn: (baseUrl: string, requests: readonly RecordedRequest[]) => Promise<T>,
): Promise<LoopbackResult<T>> {
  const requests: RecordedRequest[] = [];
  let next = 0;
  let inFlight = 0;
  let maxConcurrent = 0;
  let host = "";

  const mask = (value: string) => value.split(`http://${host}`).join(BASE_PLACEHOLDER);

  const server = http.createServer((req, res) => {
    inFlight += 1;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const headers: [string, string][] = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i]!;
        const value = req.rawHeaders[i + 1]!;
        headers.push([name, name.toLowerCase() === "host" ? HOST_PLACEHOLDER : mask(value)]);
      }
      requests.push({
        method: req.method ?? "",
        path: req.url ?? "",
        headers,
        body: mask(Buffer.concat(chunks).toString("utf8")),
      });

      const response = responses[next];
      next += 1;
      if (response === undefined) {
        res.statusCode = 500;
        res.end("재생할 응답이 없습니다(골든 사례의 responses가 부족합니다)");
      } else if (response.closeSocket) {
        req.socket.destroy();
      } else {
        res.statusCode = response.status;
        if (response.setCookie?.length) res.setHeader("set-cookie", response.setCookie);
        res.setHeader("content-type", "application/json;charset=UTF-8");
        res.end(response.body);
      }
      inFlight -= 1;
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const result = await fn(`http://${host}`, requests);
    return { result, requests, maxConcurrent };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** 오류 메시지·본문 등에 들어간 서버 주소를 자리표시자로 바꾼다. */
export function maskBase(text: string, baseUrl: string): string {
  return text.split(baseUrl).join(BASE_PLACEHOLDER);
}
