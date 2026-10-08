/** 존재하지 않는 물건을 참조했을 때. API 계층이 이 오류를 404로 바꾼다. */
export class ItemNotFoundError extends Error {
  override readonly name = "ItemNotFoundError";
  constructor(readonly itemId: number) {
    super(`물건을 찾을 수 없습니다: id=${itemId}`);
  }
}

/**
 * 존재하지 않는 회차를 종료(`finishRun`)하려 했을 때(add-collection-observability).
 * API 계층(`PATCH /api/worker-runs/[id]`)이 이 오류를 404로 바꾼다.
 */
export class WorkerRunNotFoundError extends Error {
  override readonly name = "WorkerRunNotFoundError";
  constructor(readonly runId: number) {
    super(`회차를 찾을 수 없습니다: id=${runId}`);
  }
}
