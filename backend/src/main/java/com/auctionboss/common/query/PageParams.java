package com.auctionboss.common.query;

import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

import com.auctionboss.common.error.FieldIssue;
import com.auctionboss.common.error.InvalidRequestException;
import com.auctionboss.common.json.JsStrings;

/**
 * 목록 API의 URL 파라미터 검증 공통부(원본 {@code worker-run-query.ts}, {@code feed-query.ts}).
 *
 * <ul>
 * <li>값은 JS {@code trim()}으로 다듬는다. 인식한 파라미터가 빈 값이면 그 필드의 이슈다.</li>
 * <li>같은 파라미터가 여러 번 오면 첫 값만 쓴다. 모르는 파라미터는 무시한다.</li>
 * <li>이슈의 {@code field}는 URL 파라미터 이름이다. 이슈는 호출 순서대로 쌓인다.</li>
 * </ul>
 */
public final class PageParams {

	public static final int DEFAULT_PAGE_SIZE = 20;

	public static final int MAX_PAGE_SIZE = 200;

	private static final Pattern DIGITS = Pattern.compile("[0-9]+");

	/** Number.MAX_SAFE_INTEGER. */
	private static final double MAX_SAFE_INTEGER = 9_007_199_254_740_991d;

	private final Map<String, List<String>> params;

	private final java.util.ArrayList<FieldIssue> issues = new java.util.ArrayList<>();

	private PageParams(Map<String, List<String>> params) {
		this.params = params;
	}

	public static PageParams of(Map<String, List<String>> params) {
		return new PageParams(params);
	}

	/** 페이지 번호와 크기. 검증된 값이다. */
	public record Page(long page, int pageSize) {

		/** 건너뛸 행 수. int 범위를 넘으면 JPA가 표현하지 못하므로 호출자가 빈 페이지로 처리한다. */
		public long offset() {
			return (page - 1) * pageSize;
		}

	}

	/** 인식한 파라미터가 없으면 null, 있으면 trim한 첫 값(빈 값이면 ""). */
	public String read(String name) {
		List<String> values = params.get(name);
		if (values == null || values.isEmpty()) {
			return null;
		}
		String first = values.get(0);
		return first == null ? "" : JsStrings.trim(first);
	}

	public void issue(String field, String message) {
		issues.add(new FieldIssue(field, message));
	}

	public boolean hasIssues() {
		return !issues.isEmpty();
	}

	/** 이슈가 있으면 400({@code 잘못된 요청 파라미터입니다}) 예외를 던진다. */
	public void throwIfInvalid() {
		if (!issues.isEmpty()) {
			throw new InvalidRequestException(issues);
		}
	}

	/** {@code page}, {@code pageSize}를 검사한다(이 순서로 이슈가 쌓인다). 없으면 1과 20. */
	public Page page() {
		Long page = integer("page", 1, null);
		Long pageSize = integer("pageSize", 1, (long) MAX_PAGE_SIZE);
		return new Page(page == null ? 1 : page, pageSize == null ? DEFAULT_PAGE_SIZE : pageSize.intValue());
	}

	/**
	 * {@code ^\d+$} 정수. 정수 형식이 아니면 그 이슈 하나로 끝나고, 형식이 맞으면 안전 정수 범위, 하한, 상한을 각각 검사한다(zod의
	 * refine 체인처럼 앞 검사가 실패해도 뒤 검사는 계속한다). 문제가 있거나 없으면 null.
	 */
	public Long integer(String name, long min, Long max) {
		String raw = read(name);
		if (raw == null) {
			return null;
		}
		if (!DIGITS.matcher(raw).matches()) {
			issue(name, name + "은(는) 정수여야 합니다");
			return null;
		}
		double value = Double.parseDouble(raw);
		boolean ok = true;
		if (value > MAX_SAFE_INTEGER) {
			issue(name, name + "이(가) 너무 큽니다");
			ok = false;
		}
		if (value < min) {
			issue(name, name + "는 " + min + " 이상이어야 합니다");
			ok = false;
		}
		if (max != null && value > max) {
			issue(name, name + "는 " + max + " 이하여야 합니다");
			ok = false;
		}
		return ok ? Long.valueOf((long) value) : null;
	}

}
