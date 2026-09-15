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

  // ---------------------------------------------------------------------
  // 확장 필드 (enrich-item-fields, NOTES.md §11). 전부 optional — design.md D6:
  // 하나만 안 와도 회차 전체를 ResponseSchemaError로 죽이면 안 된다(부가 정보 때문에
  // 수집이 멈추는 것은 잘못된 트레이드오프).
  // ---------------------------------------------------------------------

  /** 최소 면적(㎡) */
  minArea: numericish,
  /** 최대 면적(㎡) */
  maxArea: numericish,
  /** 건물 구조·면적 서술. 줄바꿈 포함 가능(`"철근콘크리트구조\n84.99㎡"`) */
  pjbBuldList: textish,

  /** 차수별 최저매각가격 1~4차(고정 4슬롯, design.md D1). 1차는 위에서 이미 선언했다. */
  notifyMinmaePrice2: numericish,
  notifyMinmaePrice3: numericish,
  notifyMinmaePrice4: numericish,
  /** 차수별 최저매각가율(%). 1~2차만 실제 응답에서 CONFIRMED(NOTES §11) */
  notifyMinmaePriceRate1: numericish,
  notifyMinmaePriceRate2: numericish,

  /** 용도 대/중/소분류 코드. 코드표 미확인(UNVERIFIED) — 원문 보존 */
  lclsUtilCd: textish,
  mclsUtilCd: textish,
  sclsUtilCd: textish,

  /** 소재지 분해: 시/도, 시/군/구, 동, 대표지번, 건물명, 동/층/호 상세 */
  hjguSido: textish,
  hjguSigu: textish,
  hjguDong: textish,
  daepyoLotno: textish,
  buldNm: textish,
  buldList: textish,

  /** x·y 좌표. 좌표계(EPSG) 미확인(UNVERIFIED) — 숫자 변환 없이 원문 보존 */
  xCordi: textish,
  yCordi: textish,
  /** 좌표 수준 코드. 코드표 미확인(UNVERIFIED) */
  cordiLvl: textish,

  /** 매각기일 시각(예: `"1000"` = 10:00) */
  maeHh1: textish,
  /** 매각장소 */
  maePlace: textish,
  /** 매각결정기일 `YYYYMMDD` */
  maegyuljGiil: textish,
  /** 매각기일 회차 */
  maeGiilCnt: numericish,

  /** 비고 */
  mulBigo: textish,
  /** 중복 사건번호(`<br/>`로 여러 건을 이어 보낼 수 있음) */
  dupSaNo: textish,
  /** 병합 사건번호 */
  byungSaNo: textish,
  /** 담당계 이름 */
  jpDeptNm: textish,
  /** 담당계 연락처 */
  tel: textish,

  /** 진행상태 원시 코드. 코드표 미확인(UNVERIFIED) — 해석 금지 */
  jinstatCd: textish,
  /** 물건 상태 원시 코드. 코드표 미확인(UNVERIFIED) — 해석 금지 */
  mulStatcd: textish,
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

// ---------------------------------------------------------------------------
// 상세 조회 응답 스키마 (Stage B.4, POST /pgj/pgj15B/selectAuctnCsSrchRslt.on)
// 출처: NOTES.md §10.1, §10.2 (CONFIRMED — 2026-09-11 실측)
// ---------------------------------------------------------------------------

/**
 * 개별 사진 항목 스키마 (`dma_result.csPicLst` 배열의 각 원소).
 */
export const detailPicItemSchema = z.object({
  /** 사진 상대 경로 URL (예: "/nas_e_image_pgj/kp/2026/0629/") */
  picFileUrl: textish,
  /** 사진 제목/파일명. 예: "B000210202601301010371.jpg" */
  picTitlNm: textish,
  /** 사진 구분 코드 (예: "000244") */
  cortAuctnPicDvsCd: textish,
  /** 사진 순번 (문자열 또는 숫자) */
  cortAuctnPicSeq: numericish,
  /** 페이지 순번 */
  pageSeq: numericish,
  /** 법원코드 (예: "B000210") */
  cortOfcCd: textish,
  /** 내부 사건번호 (14자리 숫자열, 예: "20260130101037") */
  csNo: textish,
  /**
   * base64 인코딩된 바이너리 이미지 문자열.
   * ⚠️ XML의 setSrc("data:image/png...")와 달리 실제 바이너리는 GIF89a 매직 바이트를 가짐 (NOTES §10.2).
   */
  picFile: textish,
});

export type DetailPicItem = z.infer<typeof detailPicItemSchema>;

/**
 * 사건 기본정보 스키마 (`dma_result.csBaseInfo`).
 */
export const detailBaseInfoSchema = z.object({
  /** 법원코드 (= boCd) */
  cortOfcCd: textish,
  /** 법원명 (예: "서울중앙지방법원") */
  cortOfcNm: textish,
  /** 법원지원명 */
  cortSptNm: textish,
  /** 내부 사건번호 (= saNo, 14자리 숫자열) */
  csNo: textish,
  /** 사건명 (예: "자동차임의경매", "부동산임의경매") */
  csNm: textish,
  /** 접수일자 (YYYYMMDD) */
  csRcptYmd: textish,
  /** 개시일자 (YYYYMMDD) */
  csCmdcYmd: textish,
  /** 청구금액 (숫자 또는 문자열) */
  clmAmt: numericish,
  /** 부동산 항고 여부 ("Y" | "N") */
  rletApalYn: textish,
  /** 경매 정지 상태 코드 */
  auctnSuspStatCd: textish,
  /** 종국 구분 코드 */
  ultmtDvsCd: textish,
  /** 종국 일자 */
  csUltmtYmd: textish,
  /** 사건 진행 상태 코드 */
  csProgStatCd: textish,
  /** 판사/사법보좌관 명 */
  jdgeAojAsstnNm: textish,
  /** 경매 중복 병합 구분 코드 */
  auctnDpcnMrgDvsCd: textish,
  /** 사건 진행 정지 사유 */
  csProgSuspRsn: textish,
  /** 동산 사건번호 */
  mvprpCsNo: textish,
  /** 동산/부동산 구분 코드 (예: "00031R") */
  mvprpRletDvsCd: textish,
  /** 담당계 코드 (예: "1021") */
  jdbnCd: textish,
  /** 담당계 명칭 (예: "경매21계") */
  cortAuctnJdbnNm: textish,
  /** 담당계 전화번호 */
  jdbnTelno: textish,
  /** 집행관 전화번호 */
  execrCsTelno: textish,
  /** 법원 유형 코드 */
  cortTypCd: textish,
  /** 이전 사건번호 */
  expCsNo: textish,
  /** 최선 구분 코드 */
  lwstDvsCd: textish,
  /** 표시용 사건번호 (예: "2026타경101037") */
  userCsNo: textish,
});

export type DetailBaseInfo = z.infer<typeof detailBaseInfoSchema>;

/**
 * 상세 응답의 핵심 결과 객체 (`data.dma_result`).
 *
 * 설계 의도:
 * - `csBaseInfo`와 `csPicLst`의 존재와 배열 형태는 필수로 둔다.
 *   이게 없거나 깨지면 상세 응답 구조가 바뀐 것이므로 ResponseSchemaError로 처리한다.
 * - 반면 `csPicLst` 배열 내의 필드나 `csBaseInfo`의 각 필드는 optional(textish/numericish)로
 *   두어 특정 부가 필드 누락으로 전체 상세 조회가 실패하지 않도록 방어한다.
 */
export const detailResultSchema = z.object({
  csBaseInfo: detailBaseInfoSchema,
  csPicLst: z.array(detailPicItemSchema),
});

export type DetailResult = z.infer<typeof detailResultSchema>;

/** 로봇탐지 통과(`ipcheck === true`) 이후의 상세 `data` 본문. */
export const detailDataSchema = z.object({
  dma_result: detailResultSchema,
});

export type DetailData = z.infer<typeof detailDataSchema>;
