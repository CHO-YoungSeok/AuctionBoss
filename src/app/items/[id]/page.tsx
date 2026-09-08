/**
 * 물건 상세 페이지.
 *
 * 목록 항목 + 사건번호/물건번호/담당 법원/수집 시각, 그리고 최신 AI 분석 결과를 보여준다.
 */
import Link from "next/link";
import { notFound } from "next/navigation";

import { PROMPT_VERSION } from "@/lib/domain";
import { getRepository, getUnreadCount } from "@/lib/db";

import { AnalysisBody } from "../../_components/analysis-body";
import { BookmarkToggleForm } from "../../_components/bookmark-toggle-form";
import {
  ANALYSIS_FRESHNESS_DESCRIPTIONS,
  ANALYSIS_FRESHNESS_LABELS,
  SOURCE_LIMITATION_NOTICE,
  determineAnalysisFreshness,
} from "../../_lib/analysis-freshness";
import { splitAnalysisHistory } from "../../_lib/analysis-history";
import { detectFailedBidRateMismatch, formatMismatchDescription } from "../../_lib/bid-mismatch";
import { formatChangeDisplay, hasRealChange, isRealChange } from "../../_lib/change-history";
import {
  DISCOUNT_STAGE_LABELS,
  classifyDiscountStage,
  computeDiscountRatio,
  formatDiscountRatio,
} from "../../_lib/discount";
import {
  EMPTY,
  formatAuctionTime,
  formatCount,
  formatDate,
  formatDateTime,
  formatText,
  formatWon,
} from "../../_lib/format";
import { buildCourtVerifyLink } from "../../_lib/court-verify";
import {
  computePricePerArea,
  formatAreaRange,
  formatPricePerArea,
  formatRoundPrice,
  formatStructuredAddress,
  formatUsageCodes,
  listRoundPrices,
} from "../../_lib/item-extensions";
import { NOTE_FLAG_LABELS, detectNoteFlags } from "../../_lib/note-flags";

export const dynamic = "force-dynamic";

/**
 * 상세 페이지가 실제로 본문(markdown)을 렌더링하는 "이전 분석"의 최대 건수(코드 리뷰
 * finding 3b). 감시 필드가 회차마다 뒤집히는 물건은 한 달 사이 재분석이 수백 건 쌓일 수
 * 있는데(finding 3), 이전에는 `listAnalyses(itemId)`를 한도 없이 불러 전부 인라인
 * 렌더링했다 — 그런 물건 하나의 상세 페이지가 수백~수천 건의 markdown 본문(수 MB)을
 * 그대로 안게 된다. 실제 전체 건수는 `countAnalyses`로 별도 표시하고, 본문을 그리는
 * 건 이 상수(최신 포함 총 조회 건수)로 항상 유계다.
 */
const MAX_ANALYSES_FETCHED = 11; // 최신 1건 + 이전 10건

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="field">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * 줄바꿈이 포함될 수 있는 값(건물 구조·면적 서술, 예: `pjbBuldList` 원문
 * `"철근콘크리트구조\n84.99㎡"`)을 위한 Field. `.multiline-value`(globals.css)가
 * `white-space: pre-wrap`을 줘서 줄바꿈이 한 줄로 뭉개지지 않게 한다(spec: 여러 줄 값
 * 표시). 값이 없을 때는 EMPTY 자체에는 줄바꿈이 없으니 일반 Field와 다르게 보이지 않는다.
 */
function MultilineField({ label, value }: { label: string; value: string }) {
  return (
    <div className="field">
      <dt>{label}</dt>
      <dd className="multiline-value">{value}</dd>
    </div>
  );
}

export default async function ItemDetailPage({
  params,
}: {
  // Next.js 15에서 페이지의 params는 Promise다.
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // 숫자가 아닌 id는 조회하지 않고 바로 404. Number("12abc")가 NaN이 되는 것에 의존하지 않는다.
  if (!/^\d+$/.test(id)) notFound();

  const repository = getRepository();
  const item = repository.getItemById(Number(id));
  if (!item) notFound();

  // getLatestAnalysis가 아니라 listAnalyses로 받아 최신/이전을 직접 나눈다 — "이전 분석이
  // 몇 건 있는지"와 그 내용을 화면에서 보여줘야 하기 때문이다(spec: 재분석된 물건 상세).
  // 분리 판정은 순수 헬퍼(analysis-history.ts)로 뽑아 테스트로 고정했다.
  //
  // 다만 한도 없이 전체를 받지 않는다(finding 3b) — `limit`으로 렌더링 대상만 잘라 받고,
  // "몇 건 있는지"는 별도로 `countAnalyses`(잘리지 않는 진짜 전체 건수)에서 가져온다.
  const totalAnalysesCount = repository.countAnalyses(item.id);
  const { latest: analysis, previous: previousAnalyses } = splitAnalysisHistory(
    repository.listAnalyses(item.id, { limit: MAX_ANALYSES_FETCHED }),
  );
  // 전체 건수 대비 실제로 렌더링하는 이전 분석 건수 — 나머지는 본문을 아예 불러오지 않는다.
  const hiddenPreviousCount = Math.max(0, totalAnalysesCount - 1 - previousAnalyses.length);

  // 기준점(oldValue===null) 행은 화면에 표시하지 않는다 — 실제 변경만 이력으로 보여준다
  // (design.md D2). 빈 이력(레거시 물건)과 기준점만 있는 이력(신규 물건, 아직 변동 없음)은
  // hasRealChange가 똑같이 false로 판정하므로 여기서 따로 갈라 처리하지 않는다.
  const changes = repository.listItemChanges(item.id);
  const realChanges = changes.filter(isRealChange).map(formatChangeDisplay);

  // 확장 정보(enrich-item-fields task 4.1) 표시 판정은 전부 순수 헬퍼(item-extensions.ts)로
  // 뽑아 테스트로 고정했다 — 이 페이지는 그 결과를 문자열로 받아서 그리기만 한다.
  const areaText = formatAreaRange(item);
  const pricePerAreaText = formatPricePerArea(computePricePerArea(item));
  const roundPrices = listRoundPrices(item);
  // 값이 있는 회차만 이어붙인다 — 없는 회차는 빈 행을 만들지 않고 그냥 걸러진다(task 4.4).
  const roundPricesText =
    roundPrices.length > 0 ? roundPrices.map(formatRoundPrice).join(" · ") : EMPTY;
  // 용도 대/중/소분류 코드는 코드표가 미확인이라(design.md D4) 원본 문자열만 보여주고
  // 라벨을 붙이지 않는다 — 아래 JSX의 필드 라벨 자체가 "원본 코드, 의미 미확인"임을 밝힌다.
  const usageCodesText = formatUsageCodes(item);
  const structuredAddressText = formatStructuredAddress(item);

  // 저감률(design.md D1, tasks.md 1.1) — 계산 불가(감정가 없음·0 등)면 discountStage도
  // 항상 null이다(classifyDiscountStage 계약).
  const discountRatio = computeDiscountRatio(item);
  const discountStage = classifyDiscountStage(discountRatio);

  // 유찰-저감률 불일치(ux-overhaul-phase1 design.md D3, tasks.md 3.1~3.3) — 어느 쪽이
  // 맞는지 판단하지 않고 모순 사실만 알린다.
  const mismatch = detectFailedBidRateMismatch(item);

  // 비고 플래그(design.md D4, tasks.md 4.1~4.4) — 패턴 판정이라 원문을 대체하지 않는다.
  // 원문은 아래(가격 카드 위)에 항상 그대로 보인다.
  const noteFlags = detectNoteFlags(item);
  const hasNote = typeof item.note === "string" && item.note.trim() !== "";

  // 분석 최신성(design.md D3, tasks.md 3.1) — 재분석 대상 선정(repository.ts의
  // NEEDS_ANALYSIS_PREDICATE)과 같은 두 조건(변경/프롬프트 버전)을 재사용한다. 화면과
  // 워커가 다른 판정을 내지 않도록 판정 로직을 새로 만들지 않는다.
  const analysisFreshness = determineAnalysisFreshness(analysis, changes, PROMPT_VERSION);

  // 원본 확인(design.md D2, tasks.md 4.1~4.2) — homeUrl은 court-verify.ts의 계약대로 물건과
  // 무관하게 항상 같은 고정 URL이다. 딥링크(w2xPath/csNo 등 물건 지정 파라미터)를 만들지
  // 않는다.
  const courtVerifyLink = buildCourtVerifyLink(item);

  // 관심 물건·변동 피드로 가는 경로에 미확인 개수를 보여준다(task 4.5) — 목록 페이지와
  // 같은 이유.
  const unreadCount = getUnreadCount();

  return (
    <main className="page">
      <p className="breadcrumb">
        <Link href="/">← 물건 목록</Link>
        {" · "}
        {/* add-collection-observability task 5.4: 수집·분석 워커 상태로 가는 경로. */}
        <Link href="/status">워커 상태</Link>
        {" · "}
        <Link href="/bookmarks">관심 물건</Link>
        {" · "}
        <Link href="/feed">
          변동 피드{unreadCount > 0 ? ` (미확인 ${unreadCount.toLocaleString("ko-KR")}건)` : ""}
        </Link>
      </p>

      <header className="page-header">
        <h1>{formatText(item.address)}</h1>
        <p className="muted">
          {formatText(item.court)} · {formatText(item.caseNo)} (물건번호 {formatText(item.itemNo)})
        </p>
        {/* 상세에서도 관심 담기/빼기와 현재 담긴 상태를 보여준다(spec: "상세에서 관심
            토글"). item.bookmarked는 getItemById가 채운다(repository.ts design.md D6). */}
        <p className="bookmark-toggle-row">
          <BookmarkToggleForm
            itemId={item.id}
            bookmarked={item.bookmarked ?? false}
            returnTo={`/items/${item.id}`}
          />
        </p>
      </header>

      {/*
        비고 우선 표시(ux-overhaul-phase1 design.md D4, tasks.md 4.3, spec: "비고 우선
        표시") — 입찰 가부를 가르는 내용(일괄매각·지분매각·대항력 포기조건 등)이 다른
        정보를 다 검토한 뒤에야 발견되면 안 된다. 이전에는 "부가 정보" 카드(최하단
        6번째)에만 있었다 — 이번에 그 자리에서 이 위치로 옮겼다(정보 자체는 사라지지
        않는다, 자리만 바뀌었다). 비고가 없으면 카드 자체를 렌더링하지 않는다.
      */}
      {hasNote ? (
        <section className="card note-card">
          <h2>사건 비고</h2>
          {noteFlags.length > 0 ? (
            <p>
              {noteFlags.map((flag) => (
                <span key={flag} className="badge-note">
                  {NOTE_FLAG_LABELS[flag]}
                </span>
              ))}
            </p>
          ) : null}
          {/* 배지는 패턴 판정이라 원문을 대체하지 않는다(design.md D4) — 배지가 없어도
              (패턴에 안 걸려도) 원문은 항상 그대로 보인다. */}
          <p className="multiline-value">{item.note}</p>
        </section>
      ) : null}

      {/*
        재배치(design.md D4, tasks.md 5.1): 사람이 경매 물건을 볼 때의 순서 —
        (비고, 있으면) → 가격 → 물건 개요 → AI 분석 → 변경 이력 → 원본 확인 → 부가 정보.
        재배치 전에 표시되던 27개 필드(물건 정보 12개 + 확장 정보 15개)는 하나도
        지우지 않았다 — 카드 소속만 바뀌었을 뿐이다(tasks.md 5.2 회귀 확인 대상).
        저감률 1개만 이번에 새로 추가된 필드다(design.md D4의 가격 섹션 구성 그대로).
      */}
      <section className="card">
        <h2>가격</h2>
        <dl className="fields">
          <Field label="감정가" value={formatWon(item.appraisalPrice)} />
          <Field label="최저매각가격" value={formatWon(item.minBidPrice)} />
          {/* 저감률(design.md D1) — 감정가 0·null이나 최저가 없음이면 discountRatio가
              null이라 EMPTY("-")로 표시된다. 단계 라벨은 색이 아니라 텍스트로 구별된다
              (spec: "색에만 의존해서는 안 된다"). */}
          <Field
            label="저감률"
            value={
              discountRatio === null || discountStage === null
                ? EMPTY
                : `${formatDiscountRatio(discountRatio)} (${DISCOUNT_STAGE_LABELS[discountStage]})`
            }
          />
          {/* 면적당 가격(design.md D2) — pricePerAreaText가 이미 기준 면적을 밝힌다
              (basisAmbiguous일 때만, item-extensions.ts formatPricePerArea). */}
          <Field label="면적당 가격" value={pricePerAreaText} />
          <Field label="차수별 최저가" value={roundPricesText} />
        </dl>
        {/* 유찰-저감률 불일치(design.md D3, tasks.md 3.3) — 어느 쪽이 맞는지 우리가
            판단해 한쪽을 감추지 않는다. 두 값과 그 차이를 그대로 보여준다. */}
        {mismatch?.mismatched ? (
          <p className="muted">
            <span className="badge-mismatch">유찰-저감률 불일치</span>{" "}
            {formatMismatchDescription(mismatch)}
          </p>
        ) : null}
      </section>

      {/*
        물건 개요(design.md D4) — 용도·면적·소재지·매각기일과, 이 물건을 특정하는 사건
        정보(사건번호·물건번호·담당 법원·수집 시각, spec: "물건 상세 열람")를 묶는다.
        값이 없는 항목은 EMPTY("-")로 표시되고(spec: 확장 정보가 없는 물건), 이 카드는
        확장 필드가 전부 비어 있어도(이 기능 이전 수집분) 오류 없이 그려진다 — 모든 값이
        item-extensions.ts/format.ts의 순수 함수를 거쳐 항상 문자열이기 때문이다.

        진행상태 원본 코드(statusCode/itemStatusCode)와 좌표(coordinateX/Y/Level)는 의도적으로
        표시하지 않는다(design.md D4) — 코드표·좌표계가 미확인이라 라벨을 붙이면 추측이
        사실처럼 보이고, 좌표는 지도 없이 숫자만 보여줘 봐야 사용자에게 의미가 없다.
      */}
      <section className="card">
        <h2>물건 개요</h2>
        <dl className="fields">
          <Field label="용도" value={formatText(item.usageType)} />
          <Field label="면적" value={areaText} />
          <Field label="소재지" value={formatText(item.address)} />
          <Field label="소재지 상세" value={structuredAddressText} />
          <Field label="매각기일" value={formatDate(item.auctionDate)} />
          {/* ux-overhaul-phase1 tasks.md 5.3, spec: "매각기일 시각 표시" — 저장 계층은
              원문("1000")을 그대로 보존하지만(domain 필드 주석), 표시 계층은 읽을 수 있는
              형태("10:00")로 바꾼다. 389건 전부가 이 형식이라 지금까지는 원문 그대로
              노출되고 있었다. */}
          <Field label="매각기일 시각" value={formatAuctionTime(item.auctionTime)} />
          <Field label="매각장소" value={formatText(item.auctionPlace)} />
          <Field label="매각결정기일" value={formatDate(item.auctionDecisionDate)} />
          <Field label="매각기일 회차" value={formatCount(item.auctionRound)} />
          <Field label="유찰횟수" value={formatCount(item.failedBidCount)} />
          <Field label="진행상태" value={formatText(item.status)} />
          <Field label="사건번호" value={formatText(item.caseNo)} />
          <Field label="물건번호" value={formatText(item.itemNo)} />
          <Field label="담당 법원" value={formatText(item.court)} />
          <Field label="최초 수집 시각" value={formatDateTime(item.firstSeenAt)} />
          <Field label="최종 수집 시각" value={formatDateTime(item.lastSeenAt)} />
        </dl>
        <MultilineField label="건물 구조" value={formatText(item.buildingDescription)} />
      </section>

      <section className="card">
        <h2>AI 분석</h2>
        {/* 분석 최신성 배지(design.md D3, tasks.md 3.2) — 대기 중/최신/갱신 예정 세 상태를
            항상 배지+설명 문구로 보여준다. "갱신 예정"은 표시 중인 분석이 현재 값 기준이
            아닐 수 있다는 경고로 읽히도록 문구를 썼다(analysis-freshness.ts). 색에만
            의존하지 않는다 — 라벨 텍스트 자체가 상태를 구별한다. */}
        <p className="muted">
          <span className={`analysis-freshness-badge analysis-freshness-${analysisFreshness}`}>
            {ANALYSIS_FRESHNESS_LABELS[analysisFreshness]}
          </span>{" "}
          {ANALYSIS_FRESHNESS_DESCRIPTIONS[analysisFreshness]}
        </p>
        {/* 소스 한계 상설 고지(ux-overhaul-phase1 tasks.md 7.3, spec: "소스 한계 고지") —
            분석 유무·최신성과 무관하게 항상 보인다. 권리관계·임차인·등기 정보가 이
            소스에 없다는 사실을 분석 본문만 읽고 오해하면 안 된다(spec, MUST NOT). */}
        <p className="muted">{SOURCE_LIMITATION_NOTICE}</p>
        {analysis ? (
          <>
            <p className="muted">
              분석 시각 {formatDateTime(analysis.analyzedAt)} · 프롬프트 버전{" "}
              {formatText(analysis.promptVersion)}
              {analysis.model ? ` · 모델 ${analysis.model}` : ""}
            </p>
            {/* 본문은 markdown 서식(굵게/인라인 코드)을 실제로 렌더링한다 — 파싱은
                analysis-body-parse.ts의 순수 함수, 표시는 AnalysisBody 컴포넌트가 맡는다.
                dangerouslySetInnerHTML을 쓰지 않으므로 `<script>` 등은 항상 텍스트로
                이스케이프된다(analysis-body.tsx 상단 주석 참고). */}
            <AnalysisBody body={analysis.body} className="analysis-body" />

            {previousAnalyses.length > 0 && (
              // 클라이언트 JS 없이(프로젝트 규칙) 이전 분석을 열람할 수 있어야 하므로
              // React state 토글이 아니라 네이티브 <details>/<summary>를 쓴다 — 기본
              // 접힘 상태로 "몇 건 있는지"만 보여주고, 클릭(또는 열람 목적의 키보드 조작)만
              // 으로 내용이 펼쳐진다. 분석이 정확히 1건일 때는 previousAnalyses가 빈
              // 배열이라 이 블록 자체가 렌더링되지 않는다(spec: 빈 "이전 분석" 섹션 금지).
              <details className="analysis-history">
                {/* 표제는 실제 전체 건수(countAnalyses)를 쓴다 — 렌더링 한도(finding 3b) 때문에
                    "지금 보여줄 수 있는 것"과 "실제로 몇 건 있는지"가 다를 수 있고, 후자를
                    숨기면 재분석이 얼마나 자주 일어났는지 운영자가 알 방법이 없어진다. */}
                <summary>이전 분석 {totalAnalysesCount - 1}건 보기</summary>
                <ul className="analysis-history-list">
                  {previousAnalyses.map((previous) => (
                    <li key={previous.id}>
                      <p className="muted">
                        분석 시각 {formatDateTime(previous.analyzedAt)} · 프롬프트 버전{" "}
                        {formatText(previous.promptVersion)}
                        {previous.model ? ` · 모델 ${previous.model}` : ""}
                      </p>
                      <AnalysisBody body={previous.body} className="analysis-body" />
                    </li>
                  ))}
                </ul>
                {hiddenPreviousCount > 0 && (
                  <p className="muted">
                    그 외 {hiddenPreviousCount}건은 표시하지 않습니다(최근 {MAX_ANALYSES_FETCHED - 1}건만
                    렌더링).
                  </p>
                )}
              </details>
            )}
          </>
        ) : null}
      </section>

      <section className="card">
        <h2>변경 이력</h2>
        {hasRealChange(changes) ? (
          <ul className="change-list">
            {realChanges.map((change) => (
              <li key={change.id} className="change-row">
                <span className="change-time">{formatDateTime(change.changedAt)}</span>
                <span className="change-field">{change.label}</span>
                <span
                  className={
                    change.direction ? `change-value change-${change.direction}` : "change-value"
                  }
                >
                  {change.text}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">아직 변동이 없습니다.</p>
        )}
      </section>

      {/*
        원본 확인(design.md D2, tasks.md 4.1~4.2). 물건별 GET URL이 존재하지 않으므로
        (design.md Context) 홈 링크만 준다 — 그 자리에서 검색에 필요한 값(법원명·사건번호)을
        `<input readonly>`로 제공해 클릭 한 번으로 전체 선택이 되게 한다(클립보드 복사는
        JS가 필요하지만, readonly input의 전체 선택은 아니다 — 프로젝트의 "클라이언트 JS
        없음" 규칙을 지킨다). `courtVerifyLink.homeUrl`은 물건과 무관한 고정값이다
        (court-verify.ts) — `w2xPath=`로 상세 화면을 강제로 여는 링크는 절대 만들지 않는다.
      */}
      <section className="card">
        <h2>법원경매정보에서 확인</h2>
        <p className="muted">
          <a href={courtVerifyLink.homeUrl} target="_blank" rel="noreferrer noopener">
            법원경매정보 홈으로 이동 →
          </a>
        </p>
        <dl className="fields court-verify-fields">
          <div className="field">
            <dt>
              <label htmlFor="court-verify-court">법원명</label>
            </dt>
            <dd>
              <input
                id="court-verify-court"
                type="text"
                readOnly
                value={courtVerifyLink.court}
                className="court-verify-input"
              />
            </dd>
          </div>
          <div className="field">
            <dt>
              <label htmlFor="court-verify-case-no">사건번호</label>
            </dt>
            <dd>
              <input
                id="court-verify-case-no"
                type="text"
                readOnly
                value={courtVerifyLink.caseNo}
                className="court-verify-input"
              />
            </dd>
          </div>
        </dl>
        <p className="muted">
          위 법원명과 사건번호로 법원경매정보 홈에서 검색하면 이 물건을 찾을 수 있습니다.
        </p>
      </section>

      {/*
        부가 정보(design.md D4) — 담당계·사건 비고·코드값 등, 1차 판단에는 필요 없지만
        확인해야 할 때 찾아보는 정보. 코드표 미확인(design.md D4)인 용도 코드는 라벨을
        붙이지 않고 원본 문자열만 노출한다.
      */}
      <section className="card">
        <h2>부가 정보</h2>

        <h3>용도 분류 (원본 코드, 의미 미확인)</h3>
        <dl className="fields">
          <Field label="용도 코드" value={usageCodesText} />
        </dl>

        {/* 비고 원문은 design.md D4(tasks.md 4.3)로 가격 카드 위로 승격되었다 — 여기서는
            중복·병합 사건번호만 남는다(정보 자체는 사라지지 않았다, 재배치 규칙 그대로). */}
        <h3>중복사건</h3>
        <dl className="fields">
          {/* dupSaNo는 `<br/>` 구분자를 원문 그대로 보존한 값이다(NOTES.md §11) — HTML로
              해석해 줄바꿈으로 렌더링하지 않는다. 실제로 있는 그대로("<br/>" 리터럴)를
              보여줘야 값을 조작해 보여주는 것이 아니다. */}
          <Field label="중복 사건번호" value={formatText(item.duplicateCaseNo)} />
          <Field label="병합 사건번호" value={formatText(item.mergedCaseNo)} />
        </dl>

        <h3>담당계 · 연락처</h3>
        <dl className="fields">
          <Field label="담당계" value={formatText(item.courtDepartment)} />
          <Field label="연락처" value={formatText(item.courtPhone)} />
        </dl>
      </section>
    </main>
  );
}
