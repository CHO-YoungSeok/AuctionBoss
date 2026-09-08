/**
 * 테스트용 응답 fixture.
 *
 * 출처 표기 원칙:
 * - `REAL_ROW`는 `NOTES.md` §8의 **실제 응답 1행을 그대로** 옮긴 것이다.
 *   (단 `addrGbncd`/`rdNm`은 §8 발췌에 포함돼 있지 않아 §3의 규칙 설명을 근거로
 *    테스트용으로 채웠다 — 아래 주석 참조.)
 * - 나머지 행은 §8 하단 "같은 응답 10행 요약" 표와 §3의 주소 예시에서 값을 가져와
 *   조립한 것이다. 사건번호/매각기일/유찰횟수/용도/최저가는 실제 관측값이고,
 *   그 외 필드(금액 세부, 코드값 등)는 테스트를 위해 만든 값이다.
 * - WAF 차단 페이지 문구는 §6.1에 기록된 실제 문구를 옮겼다.
 */

/** NOTES §8 — 실제 응답 행 (verbatim). */
export const REAL_ROW = {
  docid: "B0002102011013002849711",
  boCd: "B000210",
  saNo: "20110130028497",
  maemulSer: "1",
  mokmulSer: "1",
  srnSaNo: "2011타경28497",
  jpDeptCd: "1001",
  jinstatCd: "0002100001",
  mulStatcd: "01",
  mulJinYn: "Y",
  maemulUtilCd: "01",
  mulBigo: "",
  gamevalAmt: "711000000",
  minmaePrice: "711000000",
  yuchalCnt: "1",
  maeAmt: "0",
  inqCnt: "55",
  gwansMulRegCnt: "8",
  ipchalGbncd: "000331",
  maeGiil: "20260908",
  maegyuljGiil: "20260915",
  maeHh1: "1000",
  notifyMinmaePrice1: "711000000",
  notifyMinmaePrice2: "0",
  notifyMinmaePriceRate1: "100",
  maeGiilCnt: "1",
  ipgiganFday: "",
  ipgiganTday: "",
  maePlace: "경매법정(제4별관211호)",
  hjguSido: "서울특별시",
  hjguSigu: "성북구",
  hjguDong: "정릉동",
  daepyoLotno: "1032",
  buldNm: "정릉2차 대주피오레",
  buldList: "203동 4층 401호",
  lclsUtilCd: "20000",
  mclsUtilCd: "20100",
  sclsUtilCd: "20104",
  xCordi: "312690",
  yCordi: "555963",
  pjbBuldList: "철근콘크리트구조\n84.99㎡",
  minArea: "84",
  maxArea: "84",
  dupSaNo: "2015타경14083<br/>2021타경102844",
  byungSaNo: "",
  jiwonNm: "서울중앙지방법원",
  jpDeptNm: "경매1계",
  tel: "530-1820 (제4별관 민사집행과)",
  dspslUsgNm: "아파트",
  convAddr: "[집합건물 철근콘크리트구조\n84.99㎡]",
  printSt: "서울특별시 성북구 정릉동 1032 정릉2차 대주피오레 203동 4층 401호",
  printCsNo: "서울중앙지방법원<br/>2011타경28497<br/>2015타경14083<br/>2021타경102844<br/>(중복)",
  colMerge: "201101300284971",
  // ↓ §8 발췌에는 없던 필드. §3이 "page 1의 10행 전부에서 상관관계 확인"이라 했으므로
  //   실제 응답에는 존재하며, 이 행의 printSt가 지번주소이므로 "A"로 둔다.
  addrGbncd: "A",
  rdNm: "",
};

/**
 * 일괄매각 물건 — 같은 (사건, 물건번호)에 목적물 3행.
 * 사건번호/매각기일/유찰횟수/용도/최저가는 §8 요약표의 실제 관측값,
 * 주소는 §3에 적힌 실제 관측 주소다.
 */
export const BUNDLE_ROWS = [
  {
    docid: "B0002102024013000370211",
    boCd: "B000210",
    saNo: "20240130003702",
    maemulSer: "1",
    mokmulSer: "1",
    srnSaNo: "2024타경3702",
    jiwonNm: "서울중앙지방법원",
    dspslUsgNm: "상가,오피스텔,근린시설",
    gamevalAmt: "3050651500",
    minmaePrice: "2440521200",
    notifyMinmaePrice1: "2440521200",
    maeGiil: "20260910",
    yuchalCnt: "0",
    mulBigo: "일괄매각",
    addrGbncd: "A",
    rdNm: "",
    printSt: "서울특별시 종로구 종로4가 185",
  },
  {
    docid: "B0002102024013000370212",
    boCd: "B000210",
    saNo: "20240130003702",
    maemulSer: "1",
    mokmulSer: "2",
    srnSaNo: "2024타경3702",
    jiwonNm: "서울중앙지방법원",
    dspslUsgNm: "상가,오피스텔,근린시설",
    gamevalAmt: "3050651500",
    minmaePrice: "2440521200",
    notifyMinmaePrice1: "2440521200",
    maeGiil: "20260910",
    yuchalCnt: "0",
    mulBigo: "일괄매각",
    addrGbncd: "A",
    rdNm: "",
    printSt: "서울특별시 종로구 종로4가 185-1",
  },
  {
    docid: "B0002102024013000370213",
    boCd: "B000210",
    saNo: "20240130003702",
    maemulSer: "1",
    mokmulSer: "3",
    srnSaNo: "2024타경3702",
    jiwonNm: "서울중앙지방법원",
    dspslUsgNm: "상가,오피스텔,근린시설",
    gamevalAmt: "3050651500",
    minmaePrice: "2440521200",
    notifyMinmaePrice1: "2440521200",
    maeGiil: "20260910",
    yuchalCnt: "0",
    mulBigo: "일괄매각",
    // §3의 실제 예시대로 도로명 표기 행
    addrGbncd: "R",
    rdNm: "종로",
    printSt: "서울특별시 종로구 종로 204",
  },
];

/** 도로명(R) 행만 있는 물건 — §3이 "2024타경2501은 R 행만 있었다"고 적은 경우. */
export const ROAD_ONLY_ROW = {
  docid: "B0002102024013000250111",
  boCd: "B000210",
  saNo: "20240130002501",
  maemulSer: "1",
  mokmulSer: "1",
  srnSaNo: "2024타경2501",
  jiwonNm: "서울중앙지방법원",
  dspslUsgNm: "다세대",
  gamevalAmt: "700000000",
  minmaePrice: "448000000",
  notifyMinmaePrice1: "358400000",
  maeGiil: "20260910",
  yuchalCnt: "3",
  addrGbncd: "R",
  rdNm: "남부순환로192길",
  printSt: "서울특별시 관악구 남부순환로192길 10",
};

/**
 * 자연 키와 기존 10개 핵심 필드만 있고 **확장 필드가 전부 없는** 행 (task 3.4/3.5).
 * 이 기능 이전에 수집된 행이거나, 사이트가 확장 필드명을 바꾼 경우를 흉내낸다.
 * `minBidPrice`는 `minmaePrice`로만 채워지도록(§3.1 폴백 규칙) `notifyMinmaePrice1`을
 * 아예 빼 뒀다 — 넣으면 `minBidPriceRound1`(확장 필드)도 같이 채워져 "확장 필드가
 * 전부 비었다"는 전제가 깨진다.
 */
export const NO_EXTENDED_FIELDS_ROW = {
  docid: "B0002102026013009999911",
  boCd: "B000210",
  saNo: "20260130099999",
  maemulSer: "1",
  mokmulSer: "1",
  srnSaNo: "2026타경9999",
  jiwonNm: "서울중앙지방법원",
  dspslUsgNm: "아파트",
  gamevalAmt: "500000000",
  minmaePrice: "400000000",
  maeGiil: "20261001",
  yuchalCnt: "0",
  addrGbncd: "A",
  printSt: "서울특별시 어딘가 1",
};

/** 자연 키(`srnSaNo`)가 빠진 행 — spec의 "필수 필드 누락 → 제외 + 경고" 대상. */
export const MISSING_KEY_ROW = {
  docid: "B0002102024013009999911",
  boCd: "B000210",
  saNo: "20240130099999",
  maemulSer: "1",
  mokmulSer: "1",
  srnSaNo: "",
  jiwonNm: "서울중앙지방법원",
  dspslUsgNm: "아파트",
  gamevalAmt: "100000000",
  notifyMinmaePrice1: "100000000",
  maeGiil: "20261001",
  yuchalCnt: "0",
  addrGbncd: "A",
  printSt: "서울특별시 어딘가",
};

export interface ValidBodyOptions {
  rows?: unknown[];
  totalCnt?: number | string;
  pageNo?: number;
  pageSize?: number;
  groupTotalCount?: number;
}

/** 정상 응답 (NOTES §8의 봉투 구조 그대로). */
export function validBody(options: ValidBodyOptions = {}): string {
  const rows = options.rows ?? [REAL_ROW, ...BUNDLE_ROWS, ROAD_ONLY_ROW];
  return JSON.stringify({
    status: 200,
    message: "검색 결과가 조회되었습니다.",
    timestamp: 1788675327824,
    errors: null,
    token: null,
    data: {
      dma_pageInfo: {
        pageNo: options.pageNo ?? 1,
        pageSize: options.pageSize ?? 100,
        bfPageNo: 1,
        startRowNo: 1,
        totalCnt: String(options.totalCnt ?? rows.length),
        totalYn: "Y",
        groupTotalCount: options.groupTotalCount ?? rows.length,
      },
      ipcheck: true,
      dlt_srchResult: rows,
    },
  });
}

/** 로봇탐지 차단 응답 (NOTES §6.1 verbatim, HTTP 200으로 온다). */
export const ROBOT_BLOCKED_BODY = JSON.stringify({
  status: 200,
  message: "해당 IP는 비정상적인 접속으로 보안정책에의하여 차단되었습니다.",
  errors: null,
  data: { ipcheck: false },
});

/** WAF HTML 차단 페이지 (NOTES §6.1의 문구, HTTP 200으로 온다). */
export const WAF_BLOCKED_BODY = `<html><head><title>Blocked</title></head><body>
The request / response that are contrary to the Web firewall security policies have been blocked.
<br>Detect time : 2026-09-06 15:17:52
<br>Detect client IP : 203.0.113.10
<br>Detect URL : /pgj/pgjsearch/searchControllerMain.on
</body></html>`;

/** 스키마 위반: `dlt_srchResult`가 배열이 아니다 (= 사이트가 구조를 바꾼 경우). */
export const SCHEMA_VIOLATION_BODY = JSON.stringify({
  status: 200,
  message: "검색 결과가 조회되었습니다.",
  data: {
    dma_pageInfo: { pageNo: 1, totalCnt: "1" },
    ipcheck: true,
    dlt_srchResult: { rows: [REAL_ROW] },
  },
});

/** 스키마 위반: `dma_pageInfo`가 통째로 없다. */
export const MISSING_PAGE_INFO_BODY = JSON.stringify({
  status: 200,
  data: { ipcheck: true, dlt_srchResult: [REAL_ROW] },
});
