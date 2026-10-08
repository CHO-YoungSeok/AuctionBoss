/**
 * 수집 소스 어댑터 계약 (design.md D3).
 *
 * 규칙: 이 파일에는 특정 소스(법원경매정보 등)의 고유 형식이 절대 들어오지 않는다.
 * 어댑터가 소스 응답을 `AuctionItemInput`으로 변환해서 내보내고, 수집기·저장소·화면은
 * 이 인터페이스만 본다. 그래야 어댑터를 교체해도 바깥 코드가 그대로 동작한다
 * (spec auction-collection "소스 어댑터 계약").
 */
import type { AuctionItemInput, CollectScope } from "@/lib/domain";

/**
 * `fetchActiveItems`의 반환값.
 *
 * `pagesRequested`(이번 호출에서 실제로 요청한 페이지 수 합계)는 **소스 고유 형식이
 * 아니라 실행 메타데이터**다 — 어떤 소스든 "페이지 단위로 나눠 요청한다"는 개념
 * 자체는 소스 중립적이므로, 이 필드를 어댑터 밖(이 인터페이스)으로 노출해도
 * "소스 고유 형식이 어댑터 밖으로 새지 않는다"는 원칙을 깨지 않는다.
 *
 * 왜 필요한가(design.md D1): 회차 기록의 `pagesRequested`는 "설정된 페이지 상한"이
 * 아니라 "실제로 몇 페이지를 요청했는지"를 담아야 한다 — 그래야 "10분 주기가
 * 로봇탐지 대비 지속 가능한가"라는 질문에 실측으로 답할 수 있다. 상수를 기록하면
 * 그 질문에 절대 답할 수 없다.
 */
export interface FetchActiveItemsResult {
  items: AuctionItemInput[];
  /** 이번 호출에서 실제로 요청한 페이지 수(대상 법원 전체 합계). */
  pagesRequested: number;
}

/**
 * 사진 조회 입력. 정규화 모델이 보존한 소스 중립 필드(`courtCode`, `internalCaseNo`)다
 * (design.md D1). 화면 표시용 사건번호와 소스 내부 식별자는 다를 수 있다.
 */
export interface PhotoLookupRef {
  courtCode: string;
  internalCaseNo: string;
}

/**
 * 사진 한 장. 이미지 바이트의 표준 텍스트 표현(base64)이라 소스 고유 형식이 아니다.
 */
export interface SourcePhoto {
  seq: number;
  base64: string;
}

export interface FetchItemPhotosResult {
  photos: SourcePhoto[];
  /** 이번 호출에서 실제로 보낸 요청 수(세션 부트스트랩 포함). 실행 메타데이터. */
  requestsMade: number;
}

export interface AuctionSource {
  /**
   * 수집 범위에 해당하는 "진행 중" 물건을 전부 조회해 정규화 모델로 돌려준다.
   *
   * - 필수 필드(법원/사건번호/물건번호)가 없는 항목은 결과에서 제외한다(경고 로그).
   * - 실패(요청 실패·차단·응답 형식 변경)는 빈 배열이 아니라 **throw**로 알린다.
   *   "결과가 0건"과 "실패"를 호출자가 구분할 수 있어야 하기 때문이다.
   */
  fetchActiveItems(scope: CollectScope): Promise<FetchActiveItemsResult>;

  /**
   * 한 물건의 사진을 조회한다. 사진이 없으면 빈 결과, 요청 실패·차단·응답 형식 변경은
   * 빈 결과가 아니라 **throw**로 알린다(차단은 `SourceBlockedError`).
   */
  fetchItemPhotos(ref: PhotoLookupRef): Promise<FetchItemPhotosResult>;
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
