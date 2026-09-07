/**
 * 서비스 전체가 공유하는 정규화 도메인 모델.
 *
 * 규칙:
 * - 소스(법원경매정보 등) 고유 형식은 이 파일에 들어오지 않는다. 어댑터가 여기 정의된
 *   타입으로 변환해서 내보낸다 (design.md D3).
 * - 코드에서는 영문 필드명을 쓰고, 뜻이 분명하지 않은 필드에만 한글 주석을 붙인다.
 * - DB의 snake_case 컬럼명은 `src/lib/db` 밖으로 새어 나가지 않는다.
 */

/** 금액(원). 정수로만 다룬다 — 소수점 이하 단위가 없고 부동소수 오차를 피하기 위함. */
export type Won = number;

/** ISO 8601 날짜 문자열. 매각기일처럼 날짜만 있는 값은 `YYYY-MM-DD`. */
export type IsoDate = string;

/** ISO 8601 날짜·시각 문자열(UTC). 예: `2026-09-06T04:12:33.000Z`. */
export type IsoDateTime = string;

/**
 * 어댑터가 반환하는 물건 한 건. DB에 저장되기 전 형태라 `id`와 수집 시각이 없다.
 *
 * nullable 필드는 "소스가 값을 주지 않을 수 있다"는 뜻으로 optional(`?`)이 아니라
 * `| null`로 둔다 — 어댑터가 필드 자체를 빠뜨리는 실수를 타입 검사에서 잡기 위함.
 * 자연 키인 court/caseNo/itemNo는 spec상 누락 시 결과에서 제외되므로 non-null이다.
 */
export interface AuctionItemInput {
  /** 법원 (담당 법원 이름). 자연 키의 일부. */
  court: string;
  /** 사건번호. 예: `2025타경12345`. 자연 키의 일부. */
  caseNo: string;
  /** 물건번호. 한 사건에 여러 물건이 붙는다. 예: `1`. 자연 키의 일부. */
  itemNo: string;
  /** 소재지 */
  address: string | null;
  /** 용도. 예: `아파트`, `다세대주택`, `토지` */
  usageType: string | null;
  /** 감정가(원) */
  appraisalPrice: Won | null;
  /** 최저매각가격(원) */
  minBidPrice: Won | null;
  /** 매각기일 */
  auctionDate: IsoDate | null;
  /** 유찰횟수 */
  failedBidCount: number | null;
  /** 진행상태. 소스가 주는 문자열을 그대로 보존한다. 예: `진행`, `변경`, `취하` */
  status: string | null;
}

/** DB에 저장된 물건 한 건. */
export interface AuctionItem extends AuctionItemInput {
  id: number;
  /** 최초 수집 시각. 한번 기록되면 갱신되지 않는다. */
  firstSeenAt: IsoDateTime;
  /** 최종 수집 시각. 같은 물건을 다시 수집할 때마다 갱신된다. */
  lastSeenAt: IsoDateTime;
}

/** 분석 결과 저장 요청. */
export interface AnalysisInput {
  itemId: number;
  /** 분석 본문(markdown) */
  body: string;
  /** 분석에 쓴 모델 식별자. CLI 출력에 없을 수 있어 nullable. */
  model: string | null;
  /** 프롬프트 템플릿 버전. 예: `v1` (design.md D5) */
  promptVersion: string;
}

/** DB에 저장된 분석 결과. 물건당 여러 건이 쌓일 수 있고 최신 것을 표시한다. */
export interface Analysis extends AnalysisInput {
  id: number;
  analyzedAt: IsoDateTime;
}

/** 수집 대상 법원 한 곳. */
export interface CourtRef {
  /** 법원 이름. 예: `서울중앙지방법원` */
  name: string;
  /** 소스가 쓰는 법원 코드. 어댑터 구현 전에는 빈 문자열일 수 있다. */
  courtCode: string;
}

/** 수집 범위. `AuctionSource.fetchActiveItems(scope)`의 인자 타입. */
export interface CollectScope {
  courts: CourtRef[];
}

/** `config/collector.json`의 analysis 절. */
export interface AnalysisConfig {
  /** 분석 회차당 최대 건수 — Claude 호출 비용 통제용 (design.md D5) */
  maxItemsPerRun: number;
  /** 분석 워커 주기(ms) */
  intervalMs: number;
}

/** `config/collector.json` 전체. */
export interface CollectorConfig {
  scope: CollectScope;
  /** 수집 주기(ms) */
  intervalMs: number;
  analysis: AnalysisConfig;
}
