package com.auctionboss.collect.source;

import java.util.List;

/** 응답이 기대한 형식과 다르다. 조용히 넘기지 않는 "형식 변경 감지" 경로. 메시지는 첫 줄 뒤에 {@code "  - 이슈"}가 한 줄씩 붙는다. */
public class ResponseSchemaException extends SourceException {

	private final List<String> issues;

	public ResponseSchemaException(String message, List<String> issues, Throwable cause) {
		super(issues.isEmpty() ? message : message + "\n" + String.join("\n", issues.stream().map(i -> "  - " + i).toList()),
				cause);
		this.issues = List.copyOf(issues);
	}

	public ResponseSchemaException(String message, List<String> issues) {
		this(message, issues, null);
	}

	@Override
	public String kind() {
		return "ResponseSchemaError";
	}

	public List<String> issues() {
		return issues;
	}

}
