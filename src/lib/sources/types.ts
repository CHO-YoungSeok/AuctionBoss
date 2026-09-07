/**
 * 수집 소스 어댑터 계약 (design.md D3).
 *
 * 규칙: 이 파일에는 특정 소스(법원경매정보 등)의 고유 형식이 절대 들어오지 않는다.
 * 어댑터가 소스 응답을 `AuctionItemInput`으로 변환해서 내보내고, 수집기·저장소·화면은
 * 이 인터페이스만 본다. 그래야 어댑터를 교체해도 바깥 코드가 그대로 동작한다
 * (spec auction-collection "소스 어댑터 계약").
 */
import type { AuctionItemInput, CollectScope } from "@/lib/domain";

export interface AuctionSource {
  /**
   * 수집 범위에 해당하는 "진행 중" 물건을 전부 조회해 정규화 모델로 돌려준다.
   *
   * - 필수 필드(법원/사건번호/물건번호)가 없는 항목은 결과에서 제외한다(경고 로그).
   * - 실패(요청 실패·차단·응답 형식 변경)는 빈 배열이 아니라 **throw**로 알린다.
   *   "결과가 0건"과 "실패"를 호출자가 구분할 수 있어야 하기 때문이다.
   */
  fetchActiveItems(scope: CollectScope): Promise<AuctionItemInput[]>;
}

/**
 * 어댑터/워커가 쓰는 최소 로거. `console`이 그대로 들어맞고, 테스트에서는 호출을
 * 기록하는 가짜를 넣는다.
 */
export interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export const consoleLogger: Logger = {
  info: (message, ...args) => console.log(message, ...args),
  warn: (message, ...args) => console.warn(message, ...args),
  error: (message, ...args) => console.error(message, ...args),
};
