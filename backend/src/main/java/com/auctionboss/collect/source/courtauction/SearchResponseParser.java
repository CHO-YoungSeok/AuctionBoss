package com.auctionboss.collect.source.courtauction;

import com.auctionboss.collect.source.ResponseSchemaException;
import java.util.ArrayList;
import java.util.List;

import tools.jackson.databind.JsonNode;

/**
 * 검색 응답 3단 검사와 파싱. 필수로 두는 것은 {@code dma_pageInfo}와 {@code dlt_srchResult}의 존재와 모양뿐이다(깨지면 사이트가 응답
 * 구조를 바꾼 것). 행 안쪽 필드는 전부 선택이다.
 */
final class SearchResponseParser {

	private SearchResponseParser() {
	}

	static SearchPage parse(String raw) {
		JsonNode data = ResponseEnvelope.openData(raw, "응답 본문을 JSON으로 파싱하지 못했습니다");

		List<String> issues = new ArrayList<>();
		JsonNode pageInfo = data.get("dma_pageInfo");
		Numericish totalCnt = null;
		if (pageInfo == null || !pageInfo.isObject()) {
			issues.add("dma_pageInfo: Invalid input: expected object, received " + FieldReader.typeName(pageInfo));
		}
		else {
			FieldReader info = new FieldReader(pageInfo, "dma_pageInfo.", issues);
			info.numeric("pageNo");
			info.numeric("pageSize");
			info.numeric("startRowNo");
			totalCnt = info.numeric("totalCnt");
			if (totalCnt == null && !hasIssueFor(issues, "dma_pageInfo.totalCnt")) {
				issues.add("dma_pageInfo.totalCnt: Invalid input: expected string | number, received "
						+ FieldReader.typeName(pageInfo.get("totalCnt")));
			}
			info.numeric("groupTotalCount");
		}

		List<SearchRow> rows = new ArrayList<>();
		JsonNode result = data.get("dlt_srchResult");
		if (result == null || !result.isArray()) {
			issues.add("dlt_srchResult: Invalid input: expected array, received " + FieldReader.typeName(result));
		}
		else {
			int index = 0;
			for (JsonNode row : result) {
				if (!row.isObject()) {
					issues.add("dlt_srchResult." + index + ": Invalid input: expected object, received "
							+ FieldReader.typeName(row));
				}
				else {
					rows.add(SearchRow.parse(row, "dlt_srchResult." + index + ".", issues));
				}
				index++;
			}
		}

		if (!issues.isEmpty()) {
			throw new ResponseSchemaException("응답 형식이 기대와 다릅니다 (사이트가 응답 구조를 바꿨을 수 있습니다)", issues);
		}
		return new SearchPage(totalCnt, rows);
	}

	private static boolean hasIssueFor(List<String> issues, String path) {
		return issues.stream().anyMatch(i -> i.startsWith(path + ":"));
	}

}
