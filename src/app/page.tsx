/**
 * 물건 목록 페이지(홈).
 *
 * 서버 컴포넌트에서 저장소를 직접 읽는다 — 자기 자신의 API를 fetch하면 같은 프로세스 안에서
 * 왕복 HTTP 요청이 한 번 더 생길 뿐 얻는 게 없다.
 */
import Link from "next/link";

import { DEFAULT_PAGE_SIZE, getRepository } from "@/lib/db";

import { formatCount, formatDate, formatText, formatWon } from "./_lib/format";

// 수집기가 새로 넣은 데이터가 바로 보여야 하므로 정적 프리렌더를 끈다.
// (이게 없으면 `next build`가 빌드 시점에 DB를 열어 페이지를 미리 렌더한다.)
export const dynamic = "force-dynamic";

const PAGE_SIZE = DEFAULT_PAGE_SIZE;

/** `?page=`는 사용자가 손으로 고칠 수 있는 값이라 잘못된 값은 1로 되돌린다. */
function parsePage(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !/^\d+$/.test(value)) return 1;
  return Math.max(1, Number(value));
}

export default async function ItemListPage({
  searchParams,
}: {
  // Next.js 15에서 페이지의 searchParams는 Promise다.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const page = parsePage(params.page);

  const { items, total, pageSize } = getRepository().listItems({ page, pageSize: PAGE_SIZE });
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <main className="page">
      <header className="page-header">
        <h1>물건 목록</h1>
        <p className="muted">
          {total > 0 ? `전체 ${total.toLocaleString("ko-KR")}건 · 매각기일 빠른 순` : null}
        </p>
      </header>

      {total === 0 ? (
        <p className="empty">아직 수집된 물건이 없습니다.</p>
      ) : (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>소재지</th>
                  <th>용도</th>
                  <th className="num">감정가</th>
                  <th className="num">최저매각가격</th>
                  <th>매각기일</th>
                  <th className="num">유찰횟수</th>
                  <th>진행상태</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <Link href={`/items/${item.id}`}>{formatText(item.address)}</Link>
                    </td>
                    <td>{formatText(item.usageType)}</td>
                    <td className="num">{formatWon(item.appraisalPrice)}</td>
                    <td className="num">{formatWon(item.minBidPrice)}</td>
                    <td>{formatDate(item.auctionDate)}</td>
                    <td className="num">{formatCount(item.failedBidCount)}</td>
                    <td>{formatText(item.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {items.length === 0 ? (
            <p className="empty">이 페이지에는 물건이 없습니다.</p>
          ) : null}

          <nav className="pagination">
            {page > 1 ? (
              <Link href={`/?page=${page - 1}`}>← 이전</Link>
            ) : (
              <span className="disabled">← 이전</span>
            )}
            <span className="page-indicator">
              {page} / {totalPages}
            </span>
            {page < totalPages ? (
              <Link href={`/?page=${page + 1}`}>다음 →</Link>
            ) : (
              <span className="disabled">다음 →</span>
            )}
          </nav>
        </>
      )}
    </main>
  );
}
