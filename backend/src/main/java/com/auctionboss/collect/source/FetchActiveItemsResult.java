package com.auctionboss.collect.source;

import java.util.List;

/** {@code pagesRequested}: 이번 호출에서 실제로 요청한 페이지 수(대상 법원 전체 합계). 실행 메타데이터다. */
public record FetchActiveItemsResult(List<SourceItem> items, int pagesRequested) {
}
