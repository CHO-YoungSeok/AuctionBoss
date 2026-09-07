/**
 * 물건 상세 페이지.
 *
 * 목록 항목 + 사건번호/물건번호/담당 법원/수집 시각, 그리고 최신 AI 분석 결과를 보여준다.
 */
import Link from "next/link";
import { notFound } from "next/navigation";

import { getRepository } from "@/lib/db";

import { splitAnalysisHistory } from "../../_lib/analysis-history";
import { formatChangeDisplay, hasRealChange, isRealChange } from "../../_lib/change-history";
import { formatCount, formatDate, formatDateTime, formatText, formatWon } from "../../_lib/format";

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

  return (
    <main className="page">
      <p className="breadcrumb">
        <Link href="/">← 물건 목록</Link>
      </p>

      <header className="page-header">
        <h1>{formatText(item.address)}</h1>
        <p className="muted">
          {formatText(item.court)} · {formatText(item.caseNo)} (물건번호 {formatText(item.itemNo)})
        </p>
      </header>

      <section className="card">
        <h2>물건 정보</h2>
        <dl className="fields">
          <Field label="소재지" value={formatText(item.address)} />
          <Field label="용도" value={formatText(item.usageType)} />
          <Field label="감정가" value={formatWon(item.appraisalPrice)} />
          <Field label="최저매각가격" value={formatWon(item.minBidPrice)} />
          <Field label="매각기일" value={formatDate(item.auctionDate)} />
          <Field label="유찰횟수" value={formatCount(item.failedBidCount)} />
          <Field label="진행상태" value={formatText(item.status)} />
          <Field label="사건번호" value={formatText(item.caseNo)} />
          <Field label="물건번호" value={formatText(item.itemNo)} />
          <Field label="담당 법원" value={formatText(item.court)} />
          <Field label="최초 수집 시각" value={formatDateTime(item.firstSeenAt)} />
          <Field label="최종 수집 시각" value={formatDateTime(item.lastSeenAt)} />
        </dl>
      </section>

      <section className="card">
        <h2>AI 분석</h2>
        {analysis ? (
          <>
            <p className="muted">
              분석 시각 {formatDateTime(analysis.analyzedAt)} · 프롬프트 버전{" "}
              {formatText(analysis.promptVersion)}
              {analysis.model ? ` · 모델 ${analysis.model}` : ""}
            </p>
            {/* 본문은 markdown이지만 1단계에서는 렌더링 라이브러리 없이 원문을 그대로 보여준다. */}
            <pre className="analysis-body">{analysis.body}</pre>

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
                      <pre className="analysis-body">{previous.body}</pre>
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
        ) : (
          <p className="empty">분석 대기 중</p>
        )}
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
    </main>
  );
}
