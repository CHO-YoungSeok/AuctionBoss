/**
 * 물건 상세 페이지.
 *
 * 목록 항목 + 사건번호/물건번호/담당 법원/수집 시각, 그리고 최신 AI 분석 결과를 보여준다.
 */
import Link from "next/link";
import { notFound } from "next/navigation";

import { getRepository } from "@/lib/db";

import { formatCount, formatDate, formatDateTime, formatText, formatWon } from "../../_lib/format";

export const dynamic = "force-dynamic";

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

  const analysis = repository.getLatestAnalysis(item.id);

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
          </>
        ) : (
          <p className="empty">분석 대기 중</p>
        )}
      </section>
    </main>
  );
}
