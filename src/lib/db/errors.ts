/** 존재하지 않는 물건을 참조했을 때. API 계층이 이 오류를 404로 바꾼다. */
export class ItemNotFoundError extends Error {
  override readonly name = "ItemNotFoundError";
  constructor(readonly itemId: number) {
    super(`물건을 찾을 수 없습니다: id=${itemId}`);
  }
}
