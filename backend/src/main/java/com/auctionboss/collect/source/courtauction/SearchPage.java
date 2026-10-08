package com.auctionboss.collect.source.courtauction;

import java.util.List;

/** 검색 응답에서 어댑터가 쓰는 부분: 총 행 수({@code totalCnt})와 행 목록. */
record SearchPage(Numericish totalCnt, List<SearchRow> rows) {
}
