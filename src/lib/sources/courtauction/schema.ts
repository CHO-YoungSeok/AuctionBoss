/**
 * `POST /pgj/pgjsearch/searchControllerMain.on` 응답의 zod 스키마.
 *
 * 출처: `NOTES.md` §3 (CONFIRMED — 실제 응답에서 추출한 필드명).
 *
 * 설계 의도 — **무엇을 필수로 둘 것인가**:
 * - `data.dma_pageInfo` / `data.dlt_srchResult`의 **존재와 모양**은 필수로 둔다.
 *   이게 깨지면 사이트가 응답 구조를 바꾼 것이고, spec의 "응답 형식 변경 감지"가
 *   가리키는 상황이다 → `ResponseSchemaError`.
 * - 반면 **행 안쪽 필드는 전부 optional**로 둔다. 자연 키(`jiwonNm`/`srnSaNo`/
 *   `maemulSer`)가 빠진 행은 spec이 "결과에서 제외 + 경고 로그"를 요구하므로,
 *   스키마에서 필수로 걸어 회차 전체를 죽이면 오히려 spec 위반이 된다.
 *   즉 "행 하나가 이상함"과 "응답 구조가 바뀜"을 다른 경로로 처리한다.
 *
 * 금액/횟수는 소스가 **문자열**로 준다(NOTES §3.1). 그래도 언젠가 숫자로 바뀔 수 있어
 * `string | number` 양쪽을 받아 두고 변환은 어댑터에서 한다.
 */
import { z } from "zod";

/** 소스가 문자열/숫자 어느 쪽으로 줘도 받는다. `null`도 허용(빈 값 표현). */
const numericish = z.union([z.string(), z.number()]).nullish();
const textish = z.string().nullish();

/**
 * 검색 결과 행 하나 = (사건, 물건번호, 목적물번호) 튜플.
 * 우리가 실제로 읽는 필드만 선언한다. 나머지 필드는 zod 기본 동작대로 버려진다.
 */
export const searchRowSchema = z.object({
  /** 행 고유 ID = boCd + saNo + maemulSer + mokmulSer */
  docid: textish,
  /** 법원코드 (= cortOfcCd) */
  boCd: textish,
  /** 내부 사건번호 */
  saNo: textish,
  /** 물건번호 — 자연 키의 일부 */
  maemulSer: textish,
  /** 목적물번호 — 이 번호만 다른 여러 행이 한 물건이다 */
  mokmulSer: textish,
  /** 표시용 사건번호. 예: `2011타경28497` — 자연 키의 일부 */
  srnSaNo: textish,
  /** 법원 이름 — 자연 키의 일부 */
  jiwonNm: textish,
  /** 소재지 표시 문자열 */
  printSt: textish,
  /** 주소 구분: `A`=지번주소, `R`=도로명주소 (NOTES §3) */
  addrGbncd: textish,
  /** 도로명. `addrGbncd === "R"`일 때만 값이 있다 */
  rdNm: textish,
  /** 용도. 예: `아파트` */
  dspslUsgNm: textish,
  /** 감정평가액 */
  gamevalAmt: numericish,
  /** 최저매각가격(내부값) */
  minmaePrice: numericish,
  /** 최저매각가격(공고 1차) — 화면의 "최저매각가격" 컬럼이 쓰는 값 */
  notifyMinmaePrice1: numericish,
  /** 매각기일 `YYYYMMDD` */
  maeGiil: textish,
  /** 유찰횟수 */
  yuchalCnt: numericish,
});

export type SearchRow = z.infer<typeof searchRowSchema>;

/** `data.dma_pageInfo`. `totalCnt`는 문자열("444")로 온다. */
export const pageInfoSchema = z.object({
  pageNo: z.union([z.string(), z.number()]).nullish(),
  pageSize: z.union([z.string(), z.number()]).nullish(),
  startRowNo: z.union([z.string(), z.number()]).nullish(),
  /** 총 **행** 수. 페이지 수 계산은 반드시 이 값으로 한다 (NOTES §5) */
  totalCnt: z.union([z.string(), z.number()]),
  /** 총 **물건** 수. 행 접기 때문에 totalCnt보다 작다 — 페이지 계산에 쓰면 안 된다 */
  groupTotalCount: z.union([z.string(), z.number()]).nullish(),
});

export type PageInfo = z.infer<typeof pageInfoSchema>;

/** 로봇탐지 통과(`ipcheck === true`) 이후의 `data` 본문. */
export const searchDataSchema = z.object({
  dma_pageInfo: pageInfoSchema,
  dlt_srchResult: z.array(searchRowSchema),
});

export type SearchData = z.infer<typeof searchDataSchema>;
