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

  // -------------------------------------------------------------------------
  // 확장 필드 (enrich-item-fields, design.md D1~D4)
  //
  // 전부 **optional + `| null`**이다. 기존 10개 핵심 필드는 `| null`(필수 프로퍼티)로
  // "어댑터가 필드를 빠뜨리는 실수"를 타입 검사로 잡는다는 원칙을 썼지만, 이 확장
  // 필드들은 `?`(optional)를 함께 쓴다 — 이 change의 범위가 `src/lib/**`로 한정돼
  // `workers/**`·`src/app/**`에 있는 기존 `AuctionItemInput` 리터럴(예:
  // `workers/__tests__/collector.test.ts`)을 고칠 수 없기 때문이다. 그 파일들은 이
  // 필드들을 전혀 모른 채로 계속 컴파일돼야 한다. 저장소(`src/lib/db/repository.ts`)는
  // 이 생략(undefined)을 `?? null`로 받아 DB 바인딩에서 안전하게 처리한다.
  //
  // 값 없음 표현(design.md D3): 소스는 값이 없을 때 `""` 또는 `"0"`을 보낸다.
  // - **가격·면적·차수별 최저가율**은 0을 유효값으로 보지 않는다 — 이 도메인에서
  //   최저가 0원·면적 0㎡는 "값 없음"이지 실제 0이 아니다(기존 `pickMinBidPrice`가
  //   이미 0을 폴백 트리거로 쓰는 선례).
  // - **`failedBidCount`(기존 필드)의 0만 유효값**이다(신건). 아래 확장 필드 중에는
  //   0이 유효한 필드가 없다 — `auctionRound`(매각기일 회차)도 관측상 1부터 시작해
  //   가격·면적과 같은 규칙(0 = 값 없음)을 적용한다(판단 근거는 어댑터 주석 참조).
  // - **좌표·코드값은 숫자로 변환하지 않고 문자열 그대로 저장**하므로(D4) 애초에
  //   0-vs-없음 판정이 필요 없다.

  /** 최소 면적(㎡). 0은 값 없음(면적 0㎡는 실존하지 않는다, design.md D3). */
  minArea?: number | null;
  /** 최대 면적(㎡). 0은 값 없음(위와 동일). */
  maxArea?: number | null;
  /** 건물 구조·면적 서술. 원문에 줄바꿈이 포함될 수 있다(예: `"철근콘크리트구조\n84.99㎡"`). */
  buildingDescription?: string | null;

  /**
   * 차수별 최저매각가격(1~4차, design.md D1). 소스가 고정 4슬롯으로 주므로 배열이 아니라
   * 컬럼 4개로 둔다. 0은 값 없음(가격 0원은 값 없음, design.md D3) — `minBidPrice`(기존
   * 필드, `notifyMinmaePrice1` 우선 파생값)와 별개로 raw 차수별 값을 그대로 보존한다.
   */
  minBidPriceRound1?: number | null;
  minBidPriceRound2?: number | null;
  minBidPriceRound3?: number | null;
  minBidPriceRound4?: number | null;
  /**
   * 차수별 최저매각가율(%, 1~2차만 NOTES.md §11에서 CONFIRMED). 0은 값 없음(가격과 같은
   * 도메인 규칙 — 최저가율 0%는 값이 없다는 뜻이지 실제 비율이 아니다).
   */
  minBidPriceRateRound1?: number | null;
  minBidPriceRateRound2?: number | null;

  /**
   * 용도 대/중/소분류 코드. ⚠️ **코드표 미확인(UNVERIFIED, design.md D4)** — 해석하지
   * 않고 원문 문자열 그대로 저장한다. 화면에 라벨을 붙이면 추측이 사실처럼 보인다.
   */
  usageCodeLarge?: string | null;
  usageCodeMedium?: string | null;
  usageCodeSmall?: string | null;

  /** 소재지 구조화 값: 시/도, 시/군/구, 동, 대표지번, 건물명, 동/층/호 등 상세. */
  sido?: string | null;
  sigungu?: string | null;
  dong?: string | null;
  lotNumber?: string | null;
  buildingName?: string | null;
  /** 동/층/호 등 건물 상세(예: `"203동 4층 401호"`). `address`(조합 문자열)와 별개로 둔다. */
  buildingUnit?: string | null;

  /**
   * x·y 좌표와 좌표 수준. ⚠️ **좌표계(EPSG) 미확인(UNVERIFIED, design.md D4)** — 숫자로
   * 변환하지 않고 원문 문자열 그대로 저장한다(변환 자체가 이미 "이 값은 숫자다"라는
   * 해석이 될 수 있어서가 아니라, 실제로 어떤 단위·정밀도인지 몰라 연산에 쓸 수 없기
   * 때문이다). 지도에는 쓰지 않는다 — 저장만 해 두면 좌표계가 확인됐을 때 재수집 없이
   * 쓸 수 있다.
   */
  coordinateX?: string | null;
  coordinateY?: string | null;
  /** 좌표 수준 코드. ⚠️ 코드표 미확인 — 원문 보존, 해석 금지. */
  coordinateLevel?: string | null;

  /** 매각기일 시각. 원문 형식 그대로 보존(예: `"1000"` = 10:00, 콜론으로 재포맷하지 않는다). */
  auctionTime?: string | null;
  /** 매각장소. */
  auctionPlace?: string | null;
  /** 매각결정기일. `auctionDate`와 같은 규칙으로 `YYYY-MM-DD`로 변환한다. */
  auctionDecisionDate?: IsoDate | null;
  /** 매각기일 회차. 0은 값 없음으로 취급한다(관측상 회차는 1부터 시작 — 어댑터 주석 참조). */
  auctionRound?: number | null;

  /** 비고. */
  note?: string | null;
  /** 중복 사건번호. 소스가 `<br/>`로 여러 건을 이어 보낼 수 있어 원문 그대로 저장한다(분리 안 함). */
  duplicateCaseNo?: string | null;
  /** 병합 사건번호. */
  mergedCaseNo?: string | null;
  /** 담당계 이름. */
  courtDepartment?: string | null;
  /** 담당계 연락처. */
  courtPhone?: string | null;

  /**
   * 진행상태 원시 코드(`jinstatCd`). ⚠️ **코드표 미확인(UNVERIFIED, design.md D4)** —
   * 기존 `status`(유찰횟수에서 파생한 표시용 문자열)와 달리 해석하지 않은 원문이다.
   * 화면에는 그대로 노출하거나 아예 표시하지 않는다.
   */
  statusCode?: string | null;
  /** 물건 상태 원시 코드(`mulStatcd`). ⚠️ 코드표 미확인 — 원문 보존, 해석 금지. */
  itemStatusCode?: string | null;

  // -------------------------------------------------------------------------
  // 상세 조회 식별자 (add-item-photos stage A, NOTES.md §10.1)
  //
  // 상세 엔드포인트(`selectAuctnCsSrchRslt.on`)는 `{csNo, cortOfcCd, dspslGdsSeq}`를
  // 요구한다(NOTES §10.1 — DERIVED, 실제로 호출해 본 적은 없다). 그중 두 개만 여기 둔다:
  //
  // - `csNo` ↔ `internalCaseNo`(소스 필드 `saNo`): 목록 검색 요청 자체가 이미 같은 이름의
  //   필터 파라미터 `csNo`를 쓰고(NOTES §2.2), 응답 행의 `saNo`가 그 내부 식별자로 보인다.
  // - `cortOfcCd` ↔ `courtCode`(소스 필드 `boCd`): 목록 검색 요청의 `cortOfcCd` 파라미터와
  //   같은 값 체계다(예: `"B000210"`).
  //
  // 둘 다 "이 필드가 그 파라미터에 대응할 것"이라는 정황 근거(이름·값 체계 일치)는 있지만
  // 실제 상세 요청으로 검증된 적은 없다(DERIVED) — stage B가 확정한다.
  //
  // `dspslGdsSeq`는 **의도적으로 추가하지 않는다.** NOTES.md 전체(§2.2 요청 파라미터 목록,
  // §3.1 필드 매핑표, §11 확장 필드 확정표)를 뒤져도 검색 응답 행의 어떤 필드가
  // `dspslGdsSeq`에 대응하는지 확인된 적이 없다 — `maemulSer`(물건번호)나 `mokmulSer`
  // (목적물번호)로 추측할 수는 있지만 이름 유사성 외에 근거가 없고, 틀리게 짚으면 stage B의
  // 상세 요청이 조용히 엉뚱한 물건을 가져오게 된다. 근거 없는 필드를 추가하지 않는다는
  // 원칙(NOTES §11 "포함하지 않은 필드")을 그대로 따른다 — stage B가 실제 상세 요청을 보내
  // 이 값을 확정해야 한다.

  /**
   * 소스 내부 사건번호(`saNo`, 예: `"20110130028497"`). 상세 조회 요청의 `csNo` 파라미터에
   * 대응하는 것으로 보인다(위 설명 참조, DERIVED).
   *
   * ⚠️ **표시용 `caseNo`(`srnSaNo`, 예: `"2011타경28497"`)와 같은 값인지 UNVERIFIED다** —
   * 형식부터 다르다. 같다고 가정하지 않고 별도 필드로 보존한다(spec "상세 조회 식별자
   * 보존" 시나리오 — 화면 표시용 사건번호와 소스 내부 식별자가 다를 수 있으므로 같은
   * 값으로 가정해서는 안 된다).
   */
  internalCaseNo?: string | null;

  /**
   * 소스 법원코드(`boCd`, 예: `"B000210"`). 상세 조회 요청의 `cortOfcCd` 파라미터에
   * 대응하는 것으로 보인다(위 설명 참조, DERIVED). `CourtRef.courtCode`(수집 대상 설정,
   * 입력값)와 값 체계는 같지만, 이 필드는 소스 응답이 실제로 돌려준 값(출력값)이라
   * 별도로 둔다 — 설정이 비어 있어 법원 이름으로 코드를 찾은 경우에도 이 필드는 항상
   * 소스 응답의 실측값이다.
   */
  courtCode?: string | null;
}

/** DB에 저장된 물건 한 건. */
export interface AuctionItem extends AuctionItemInput {
  id: number;
  /** 최초 수집 시각. 한번 기록되면 갱신되지 않는다. */
  firstSeenAt: IsoDateTime;
  /** 최종 수집 시각. 같은 물건을 다시 수집할 때마다 갱신된다. */
  lastSeenAt: IsoDateTime;
  /**
   * 감시 대상 필드의 가장 최근 **실제** 변경 시각(기준점 제외). null이면 변경 이력이 없다는
   * 뜻이다(기존 DB의 물건일 수도, 아직 한 번도 안 바뀐 물건일 수도 있다 — design.md D6은
   * 이 둘을 같게 다루라고 한다).
   *
   * `listItems`가 스칼라 서브쿼리로 채우는 값이다(design.md D6) — 목록 쿼리의
   * 필터·정렬·total에는 관여하지 않는다. optional인 이유: 이 값을 계산하지 않는 다른
   * 생성 경로(`getItemById`, 이 필드를 모르는 기존 워커·테스트 코드의 객체 리터럴)가
   * 매번 명시적으로 null을 채워 넣게 강제하지 않기 위함이다 — `getItemById`는 그래도
   * 항상 null을 채운다.
   */
  lastChangedAt?: IsoDateTime | null;
  /**
   * 관심 목록에 담겼는지(add-bookmarks-and-feed, design.md D6). `listItems`/`getItemById`가
   * 스칼라 서브쿼리로 채우는 값이다 — `lastChangedAt`과 같은 이유로 목록 쿼리의
   * 필터·정렬·total에는 관여하지 않는다. optional인 이유도 `lastChangedAt`과 같다: 이 값을
   * 계산하지 않는 다른 생성 경로(이 필드를 모르는 기존 워커·테스트 코드의 객체 리터럴)가
   * 매번 명시적으로 채워 넣게 강제하지 않기 위함이다.
   */
  bookmarked?: boolean;
  
  photoStatus?: PhotoStatus;
  photoCount?: number;
  photoCollectedAt?: string | null;
}

/**
 * 값이 바뀌면 변경 이력을 남기는 감시 대상 필드 (design.md D1).
 * `field`에는 이 이름을 그대로 쓴다 — DB 컬럼명(snake_case)이 아니다.
 */
export const WATCHED_FIELDS = ["minBidPrice", "failedBidCount", "auctionDate", "status"] as const;
export type WatchedField = (typeof WATCHED_FIELDS)[number];

/**
 * 이력 행의 종류: 최초 저장 시의 기준점인지, 실제 값 변경인지 (코드 리뷰 finding 1).
 *
 * 이전에는 `oldValue === null`을 이 구별의 유일한 마커로 썼다. 하지만 "값이 없던 필드에
 * 값이 생기는" 실제 변경(예: 비어 있던 매각기일이 잡히는 경우)도 `oldValue === null`이라
 * 기준점과 구별할 수 없었다 — 그 변경이 상세 화면·재분석 대상 선정·목록의 "최근 변동"
 * 표시에서 통째로 사라지는 버그였다. `kind`가 이제 유일한 마커다.
 */
export type ItemChangeKind = "baseline" | "change";

/**
 * 물건의 감시 대상 필드 변경 이력 한 건 (design.md D1).
 *
 * `oldValue`/`newValue`는 항상 문자열이다 — 가격(숫자)·매각기일·상태(문자열)가 섞여 있어
 * DB에도 TEXT로 저장되고(D1), 표시 계층이 `field`를 보고 해석한다.
 *
 * `kind === "baseline"`이면 최초 저장 시의 기준점 행이지 실제 변경이 아니다(design.md D2,
 * finding 1로 마커가 `oldValue === null`에서 `kind`로 바뀌었다) — 표시 계층은 이 값으로
 * 기준점과 실제 변경을 구별해야 한다.
 */
export interface ItemChange {
  id: number;
  itemId: number;
  field: WatchedField;
  oldValue: string | null;
  newValue: string | null;
  changedAt: IsoDateTime;
  kind: ItemChangeKind;
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

export const PHOTO_STATUSES = ["uncollected", "collected", "empty", "failed"] as const;
export type PhotoStatus = (typeof PHOTO_STATUSES)[number];

export interface ItemPhoto {
  id: number;
  itemId: number;
  seq: number;
  filePath: string;
  fileSize: number;
  mimeType: string;
  collectedAt: string;
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
  /**
   * 분석 회차당 최대 **신규** 분석 건수 — Claude 호출 비용 통제용 (design.md D5).
   * 재분석은 이 한도와 무관하다 — `maxReanalysisPerRun`이 따로 있다.
   */
  maxItemsPerRun: number;
  /**
   * 분석 회차당 최대 **재분석** 건수(design.md D5). 신규 분석과 별개의 독립된 한도다 —
   * 총 호출 수 상한은 `maxItemsPerRun + maxReanalysisPerRun`이다. 기본값은 2 — 재분석은
   * 유찰이 발생할 때마다 생기고 상한이 없으면 유찰이 몰린 날 호출이 폭증한다.
   */
  maxReanalysisPerRun: number;
  /**
   * 재분석 쿨다운(시간 단위, 코드 리뷰 finding 3). 물건의 최신 분석이 이 시간 이내면
   * 감시 필드가 다시 바뀌어도 재분석 대상에서 제외한다. 소스가 감시 필드를 회차마다
   * 뒤집어 보고하면(예: `failedBidCount`가 일시적으로 유실됐다 복구되는 패턴) 매 회차가
   * 유효한 변경으로 기록돼 재분석이 하루 수백 번 유발될 수 있다 — 회차당 건수 제한
   * (`maxReanalysisPerRun`)만으로는 그 물건이 매 회차 한도를 계속 차지하는 것을 막지
   * 못한다. 기본값 24 — 실제 유찰은 월 단위로 일어나므로 24시간 안에서는 정상적인
   * 재분석 요구가 없다는 전제다. 0을 허용한다(쿨다운 없음 = 이전 동작).
   */
  reanalysisCooldownHours: number;
  /** 분석 워커 주기(ms) */
  intervalMs: number;
}

/** `config/collector.json`의 observability 절 (add-collection-observability design.md D6). */
export interface ObservabilityConfig {
  /**
   * 워커별 최대 회차 기록 보존 건수. 이 건수를 넘으면 오래된 기록부터 정리된다
   * (design.md D6). 기간이 아니라 건수로 두는 이유: 주기를 바꿔도 상한이 곧 최대 행
   * 수라는 의미가 흔들리지 않는다.
   */
  maxRunsPerWorker: number;
  /**
   * 상태 판정(design.md D5)에서 "오래 방치됨"으로 볼 배수. 마지막 성공(또는 마지막
   * 기록)이 워커의 기대 주기(`intervalMs`) × 이 값보다 오래되면 `stale`로 판정한다.
   */
  staleAfterIntervals: number;
}

/**
 * `config/collector.json`의 `scope` 절 (scale-collection-scheduling design.md D1/D2/D3).
 * `CollectScope`(어댑터 `fetchActiveItems(scope)`의 인자 타입)를 그대로 확장해 법원
 * 목록은 공유하되, 회차 예산 설정 두 개를 추가로 지닌다. 이 예산 필드들은 어댑터가
 * 알 필요가 없으므로(로테이션·예산은 워커의 스케줄링 관심사) `CollectScope` 자체에는
 * 넣지 않는다 — 어댑터에 넘기는 실제 `CollectScope` 값은 여전히 courts만 가진다.
 */
export interface CollectorScopeConfig extends CollectScope {
  /**
   * 회차당 처리할 법원 수 상한(design.md D1, 기본값 1). 예산의 단위는 요청 수가 아니라
   * 법원 수다 — 법원의 페이지 수는 요청을 보내보기 전에는 모르므로, 요청 수로 자르면
   * 법원이 절반만 수집된 채로 남을 수 있다(그러면 "이 법원 물건이 줄었다"로 오해된다).
   * 법원 1곳뿐이면 이 값이 1이든 몇이든 매 회차 그 법원만 수집한다(design.md D5).
   */
  maxCourtsPerRun: number;
  /**
   * 회차당 요청 수 안전장치(design.md D1). 이미 시작한 법원의 수집은 끊지 않되, 이 값을
   * 넘으면 이번 회차에서 **다음** 법원을 새로 시작하지 않는다. `maxCourtsPerRun`(법원 수
   * 예산)을 대신하는 값이 아니라 그 보조 안전장치다 — 안전한 실측값은 아직 없고
   * (`design.md` Open Questions), 기본값은 현재 검증된 서울중앙 1곳 기준(약 13요청)을
   * 넘지 않게 잡는다.
   */
  maxRequestsPerRun: number;
}

/**
 * `config/collector.json`의 photos 절(fix-photo-worker-and-deploy-config D3/D4). 사진 워커는
 * 수집 워커와 같은 IP 요청 예산을 나눠 쓰므로 수집보다 드물고 느리게 돈다.
 */
export interface PhotosConfig {
  /** 사진 워커 주기(ms). */
  intervalMs: number;
  /** 회차당 처리할 물건 수 상한. */
  maxItemsPerRun: number;
  /** 같은 회차 안에서 물건 사이에 둘 요청 간격(ms). */
  requestDelayMs: number;
  /** 실패한 물건을 다시 대상으로 삼기까지의 간격(시간). 마지막 시도 시각 기준. */
  retryAfterHours: number;
}

/** `config/collector.json` 전체. */
export interface CollectorConfig {
  scope: CollectorScopeConfig;
  /** 수집 주기(ms) */
  intervalMs: number;
  analysis: AnalysisConfig;
  photos: PhotosConfig;
  observability: ObservabilityConfig;
}

// ---------------------------------------------------------------------------
// 실행 회차 관측 (add-collection-observability, design.md D1/D5)
// ---------------------------------------------------------------------------

/** 회차를 기록하는 워커 종류. */
export const WORKER_KINDS = ["collector", "analyzer", "photos"] as const;
export type WorkerKind = (typeof WORKER_KINDS)[number];

/**
 * 회차 결과 구분(design.md D1). `blocked`를 `failed`의 하위가 아니라 별도 값으로 둔다 —
 * 스펙이 구별을 MUST로 요구하고, 화면·집계에서 따로 취급해야 한다.
 */
export const RUN_OUTCOMES = ["running", "success", "failed", "blocked", "skipped"] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/**
 * `skipped` 회차의 사유. `error_kind` 컬럼에 그대로 들어간다(design.md D1) — 별 컬럼을
 * 만들 만한 정보량이 아니라는 판단.
 */
export const SKIP_REASONS = ["overlap", "backoff"] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/** collector 회차의 표시용 수치(design.md D1) — `detail` JSON에 그대로 저장된다. */
export interface CollectorRunDetail {
  /** 이번 회차가 대상으로 삼은 법원 이름들. */
  targetCourts: string[];
  /**
   * 실제로 요청한 페이지 수(설정된 상한이 아니라 소스가 실제로 수행한 요청 수,
   * `AuctionSource.fetchActiveItems`가 돌려준 값 그대로). design.md D1 참고.
   */
  pagesRequested: number;
  /** 소스에서 가져온 물건 수. */
  itemsFetched: number;
  inserted: number;
  updated: number;
  /**
   * 감시 대상 필드가 실제로 바뀐 물건 수. `worker_runs.items_changed` 컬럼(집계용)과
   * 항상 같은 값이어야 한다 — 두 값의 동기화는 `finishRun` 한 곳에서만 이뤄진다
   * (design.md D1 risk, 코드 리뷰 대상).
   */
  changed: number;
}

/** analyzer 회차의 표시용 수치(design.md D1) — `detail` JSON에 그대로 저장된다. */
export interface AnalyzerRunDetail {
  /** 신규 분석 건수. */
  newCount: number;
  /** 재분석 건수. */
  reanalysisCount: number;
  succeeded: number;
  failed: number;
}

/** photos 회차의 표시용 수치(fix-photo-worker-and-deploy-config D3) — `detail` JSON에 저장된다. */
export interface PhotosRunDetail {
  /** 시도한 물건 수. */
  attempted: number;
  /** 사진을 저장한 물건 수. */
  collected: number;
  /** 사진이 없다고 확인된 물건 수. */
  empty: number;
  /** 실패한 물건 수(차단으로 중단된 물건은 포함하지 않는다). */
  failed: number;
  /** 실제로 보낸 요청 수(세션 부트스트랩 포함). */
  requestsMade: number;
}

/** 워커별로 다른 `detail` JSON의 형태. `worker` 컬럼 값으로 어느 쪽인지 구별한다. */
export type WorkerRunDetail = CollectorRunDetail | AnalyzerRunDetail | PhotosRunDetail;

/** `worker_runs` 테이블의 회차 한 건(design.md D1). */
export interface WorkerRun {
  id: number;
  worker: WorkerKind;
  startedAt: IsoDateTime;
  /** 아직 끝나지 않은(`outcome: "running"`) 회차는 null이다. */
  finishedAt: IsoDateTime | null;
  outcome: RunOutcome;
  /** 오류 클래스 이름(예: `RobotDetectedError`) 또는 `skipped`의 사유(`overlap`/`backoff`). */
  errorKind: string | null;
  errorMessage: string | null;
  detail: WorkerRunDetail | null;
  /**
   * 집계용 컬럼(design.md D1). `detail`이 collector 형태면 `detail.changed`와 항상 같은
   * 값이고, analyzer 회차나 detail이 없는 회차는 null이다.
   */
  itemsChanged: number | null;
}

/** `getWorkerStatus`가 판정하는 상태(design.md D5). */
export const WORKER_STATUS_STATES = ["ok", "blocked", "failed", "stale"] as const;
export type WorkerStatusState = (typeof WORKER_STATUS_STATES)[number];

/** 워커의 현재 상태 판정 결과(design.md D5). 기록에서 매번 도출되고 저장되지 않는다. */
export interface WorkerStatus {
  state: WorkerStatusState;
  /** 가장 최근 성공 회차의 종료 시각. 성공 회차가 없으면 null. */
  lastSuccessAt: IsoDateTime | null;
  /** 가장 최근 회차(결과와 무관, `running`/`skipped` 포함). 기록이 전혀 없으면 null. */
  lastRun: WorkerRun | null;
}

// ---------------------------------------------------------------------------
// 관심 물건 · 변동 피드 (add-bookmarks-and-feed, design.md D1~D4)
// ---------------------------------------------------------------------------

/**
 * 변동 피드 한 건. `item_changes`를 관심 물건(`bookmarks`)으로 걸러 읽은 것일 뿐 별도로
 * 저장되지 않는다(design.md D2) — `kind`가 항상 `"change"`인 행만 나온다(기준점은 피드에
 * 나오지 않는다, MUST NOT).
 *
 * 물건 식별을 위한 최소 표시 정보(`itemAddress`)를 함께 담는다 — 피드 화면이 "어떤 물건"인지
 * 보여주려고 물건을 따로 조회하지 않아도 되게 하기 위함이다. 물건 상세로 가는 링크는
 * `itemId`로 만든다.
 */
export interface FeedEntry {
  /** `item_changes.id` — 이 피드 항목의 근거가 된 이력 행. */
  id: number;
  itemId: number;
  /** 표시용 소재지. 물건이 소재지 없이 저장됐으면 null. */
  itemAddress: string | null;
  field: WatchedField;
  oldValue: string | null;
  newValue: string | null;
  changedAt: IsoDateTime;
  /**
   * 이 물건이 관심 목록에 담긴 시각(`bookmarks.created_at`). "관심 등록 후 변동만" 필터
   * (`sinceBookmarkedAt`, design.md D2)의 기준이다.
   */
  bookmarkedAt: IsoDateTime;
}
