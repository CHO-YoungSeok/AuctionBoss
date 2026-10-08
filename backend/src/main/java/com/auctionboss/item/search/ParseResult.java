package com.auctionboss.item.search;

import java.util.List;

import com.auctionboss.common.error.FieldIssue;

/** 쿼리 파서의 결과: 성공(조건) 또는 실패(이슈 목록). */
public sealed interface ParseResult {

	record Success(ItemSearchCondition condition) implements ParseResult {
	}

	record Failure(List<FieldIssue> issues) implements ParseResult {
	}

}
