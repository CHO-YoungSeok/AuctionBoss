package com.auctionboss.item.search;

import java.math.BigInteger;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

import com.auctionboss.common.error.FieldIssue;

/**
 * 목록 조회 파라미터 strict 파서. 원본 {@code src/lib/domain/item-query.ts}의
 * {@code parseItemQuery}와 같은 규칙이다(lenient 파서는 옮기지 않았다).
 *
 * <ul>
 * <li>값은 앞뒤 공백(JS {@code trim()}과 같은 범위)을 제거한다.</li>
 * <li>인식된 파라미터가 빈 값이면 그 파라미터를 오류로 보고한다(다른 파라미터는 계속 검증).</li>
 * <li>스칼라 파라미터가 여러 번 오면 첫 값만 쓴다. {@code usage}, {@code sido}, {@code sigungu}는 반복 파라미터다.</li>
 * <li>모르는 파라미터는 무시한다.</li>
 * <li>필드 단위 오류가 하나라도 있으면 교차 검증(가격·날짜 범위, needsAnalysis와 promptVersion)은 하지 않는다.
 * 원본(zod)도 그렇게 동작한다.</li>
 * <li>{@code field}는 URL 파라미터 이름이다.</li>
 * </ul>
 */
public final class ItemQueryParser {

	/** JS 안전 정수 상한(2^53 - 1). 원본의 Number.isSafeInteger 검사와 같다. */
	private static final BigInteger MAX_SAFE_INTEGER = BigInteger.valueOf(9_007_199_254_740_991L);

	private static final long WON_PER_EOK = 100_000_000L;

	private static final long WON_PER_MAN = 10_000L;

	public static final int MAX_USAGE_TYPES = 50;

	public static final int MAX_REGION_VALUES = 50;

	private static final Set<String> MULTI_VALUE = Set.of("usage", "sido", "sigungu");

	/** 인식하는 파라미터(원본 ITEM_QUERY_PARAMS 순서). 빈 값 오류가 이 순서로 보고된다. */
	private static final List<String> KNOWN = List.of("page", "pageSize", "analyzed", "needsAnalysis",
			"promptVersion", "usage", "minPrice", "maxPrice", "minFailed", "q", "sort", "dir", "sido", "sigungu",
			"minEok", "minMan", "maxEok", "maxMan", "dateFrom", "dateTo", "excludePast", "bookmarked", "court",
			"minDiscountRate", "hasPhotos");

	private static final Pattern DIGITS = Pattern.compile("[0-9]+");

	private static final Pattern DATE_SHAPE = Pattern.compile("[0-9]{4}-[0-9]{2}-[0-9]{2}");

	/** JS String.prototype.trim()이 지우는 공백류(유니코드 공백, 줄바꿈, BOM). */
	private static final Pattern JS_TRIM = Pattern.compile("^[\\s\\p{Z}\\uFEFF]+|[\\s\\p{Z}\\uFEFF]+$");

	private ItemQueryParser() {
	}

	public static ParseResult parse(Map<String, List<String>> params) {
		return new Run(params).run();
	}

	private static String jsTrim(String value) {
		return JS_TRIM.matcher(value).replaceAll("");
	}

	/** 한 번의 파싱. 필드 단위 이슈와 교차 검증 이슈를 따로 모은다. */
	private static final class Run {

		private final Map<String, List<String>> collected = new LinkedHashMap<>();

		private final List<FieldIssue> emptyIssues = new ArrayList<>();

		private final List<FieldIssue> fieldIssues = new ArrayList<>();

		private final List<FieldIssue> crossIssues = new ArrayList<>();

		Run(Map<String, List<String>> input) {
			for (String name : KNOWN) {
				List<String> raw = input.get(name);
				if (raw == null || raw.isEmpty()) {
					continue;
				}
				List<String> values = new ArrayList<>(raw.size());
				for (String v : raw) {
					values.add(v == null ? "" : jsTrim(v));
				}
				if (values.stream().anyMatch(String::isEmpty)) {
					emptyIssues.add(new FieldIssue(name, name + " 값은 비어 있을 수 없습니다"));
					continue;
				}
				collected.put(name, MULTI_VALUE.contains(name) ? values : List.of(values.get(0)));
			}
		}

		ParseResult run() {
			Long page = longMin("page", 1, "page는 1 이상이어야 합니다");
			Integer pageSize = integer("pageSize", 1, ItemSearchCondition.MAX_PAGE_SIZE, "pageSize는 1 이상이어야 합니다",
					"pageSize는 " + ItemSearchCondition.MAX_PAGE_SIZE + " 이하여야 합니다");
			Boolean analyzed = bool("analyzed", "analyzed는 true 또는 false여야 합니다");
			Boolean needsAnalysisFlag = onlyTrue("needsAnalysis", "needsAnalysis는 true만 지원합니다");
			String promptVersion = scalar("promptVersion");
			List<String> usage = multi("usage", MAX_USAGE_TYPES, "usage는 한 번에 " + MAX_USAGE_TYPES + "개 이하만 지정할 수 있습니다");
			Long minPrice = longValue("minPrice");
			Long maxPrice = longValue("maxPrice");
			Long minFailed = longValue("minFailed");
			String q = scalar("q");
			SortKey sort = sort();
			SortDirection dir = dir();
			List<String> sido = multi("sido", MAX_REGION_VALUES, "sido는 한 번에 " + MAX_REGION_VALUES + "개 이하만 지정할 수 있습니다");
			List<String> sigungu = multi("sigungu", MAX_REGION_VALUES,
					"sigungu는 한 번에 " + MAX_REGION_VALUES + "개 이하만 지정할 수 있습니다");
			Long minEok = longValue("minEok");
			Long minMan = longValue("minMan");
			Long maxEok = longValue("maxEok");
			Long maxMan = longValue("maxMan");
			LocalDate dateFrom = date("dateFrom");
			LocalDate dateTo = date("dateTo");
			Boolean excludePast = onlyTrue("excludePast", "excludePast는 true만 지원합니다");
			Boolean bookmarked = bool("bookmarked", "bookmarked는 true 또는 false여야 합니다");
			String court = scalar("court");
			Integer minDiscountRate = integer("minDiscountRate", 0, 100, "minDiscountRate는 0에서 100 사이여야 합니다",
					"minDiscountRate는 0에서 100 사이여야 합니다");
			Boolean hasPhotos = bool("hasPhotos", "hasPhotos는 true 또는 false여야 합니다");

			Long effMin = null;
			Long effMax = null;
			if (fieldIssues.isEmpty()) {
				if (Boolean.TRUE.equals(needsAnalysisFlag) && promptVersion == null) {
					crossIssues.add(new FieldIssue("needsAnalysis", "needsAnalysis=true이면 promptVersion이 함께 있어야 합니다"));
				}
				if (minPrice != null && maxPrice != null && minPrice > maxPrice) {
					crossIssues.add(new FieldIssue("minPrice", "minPrice는 maxPrice보다 클 수 없습니다"));
					crossIssues.add(new FieldIssue("maxPrice", "minPrice는 maxPrice보다 클 수 없습니다"));
				}
				Bound min = bound(minPrice, minEok, minMan, "minPrice", "minEok", "minMan");
				Bound max = bound(maxPrice, maxEok, maxMan, "maxPrice", "maxEok", "maxMan");
				boolean bothRawOnly = min.rawOnly() && max.rawOnly();
				if (!bothRawOnly) {
					crossBounds(min, max);
				}
				effMin = min.value;
				effMax = max.value;
				if (dateFrom != null && dateTo != null && dateFrom.isAfter(dateTo)) {
					crossIssues.add(new FieldIssue("dateFrom", "dateFrom은 dateTo보다 늦을 수 없습니다"));
					crossIssues.add(new FieldIssue("dateTo", "dateFrom은 dateTo보다 늦을 수 없습니다"));
				}
			}

			List<FieldIssue> all = new ArrayList<>(emptyIssues);
			all.addAll(fieldIssues);
			all.addAll(crossIssues);
			if (!all.isEmpty()) {
				return new ParseResult.Failure(all);
			}
			ItemSearchCondition condition = new ItemSearchCondition(page != null ? page : 1L,
					pageSize != null ? pageSize : ItemSearchCondition.DEFAULT_PAGE_SIZE, analyzed,
					needsAnalysisFlag != null, promptVersion, usage, effMin, effMax,
					minFailed == null ? null : (int) Math.min(minFailed, Integer.MAX_VALUE), q, sido, sigungu, dateFrom, dateTo,
					excludePast != null, bookmarked, court, minDiscountRate, hasPhotos, sort, dir);
			return new ParseResult.Success(condition);
		}

		// ---- 억/만원 결합 ----

		/** 결합된 원 단위 하한/상한과 그 값을 만든 파라미터 이름들. */
		private record Bound(Long value, BigInteger exact, List<String> sourceFields) {

			boolean rawOnly() {
				return sourceFields.size() == 1 && (sourceFields.get(0).equals("minPrice") || sourceFields.get(0).equals("maxPrice"));
			}
		}

		/** 원 단위 파라미터가 있으면 그것이 이긴다. 없으면 억/만원 중 온 것만 합산(안 온 쪽은 0). */
		private Bound bound(Long raw, Long eok, Long man, String rawField, String eokField, String manField) {
			if (raw != null) {
				return new Bound(raw, BigInteger.valueOf(raw), List.of(rawField));
			}
			if (eok == null && man == null) {
				return new Bound(null, null, List.of());
			}
			List<String> sources = new ArrayList<>();
			if (eok != null) {
				sources.add(eokField);
			}
			if (man != null) {
				sources.add(manField);
			}
			BigInteger exact = BigInteger.valueOf(eok == null ? 0 : eok).multiply(BigInteger.valueOf(WON_PER_EOK))
					.add(BigInteger.valueOf(man == null ? 0 : man).multiply(BigInteger.valueOf(WON_PER_MAN)));
			// 안전 정수 범위를 넘는 값은 아래 crossBounds가 거절하므로 value는 그때만 의미가 있다.
			return new Bound(exact.compareTo(MAX_SAFE_INTEGER) > 0 ? null : exact.longValueExact(), exact, sources);
		}

		private void crossBounds(Bound min, Bound max) {
			for (Bound b : List.of(min, max)) {
				if (b.exact != null && b.exact.compareTo(MAX_SAFE_INTEGER) > 0) {
					for (String field : b.sourceFields) {
						crossIssues.add(new FieldIssue(field, field + "이(가) 너무 큽니다"));
					}
					return;
				}
			}
			if (min.value == null || max.value == null || min.value <= max.value) {
				return;
			}
			List<String> fields = new ArrayList<>(min.sourceFields);
			fields.addAll(max.sourceFields);
			for (String field : fields) {
				crossIssues.add(new FieldIssue(field, "최소 가격(억/만원 합산 포함)은 최대 가격보다 클 수 없습니다"));
			}
		}

		// ---- 필드 단위 파싱 ----

		private void issue(String field, String message) {
			fieldIssues.add(new FieldIssue(field, message));
		}

		private String scalar(String name) {
			List<String> v = collected.get(name);
			return v == null ? null : v.get(0);
		}

		private List<String> multi(String name, int max, String tooManyMessage) {
			List<String> v = collected.get(name);
			if (v == null) {
				return null;
			}
			if (v.size() > max) {
				issue(name, tooManyMessage);
				return null;
			}
			return List.copyOf(v);
		}

		/** {@code ^\d+$}이고 안전 정수 범위인 값. 아니면 이슈를 남기고 null. */
		private Long longValue(String name) {
			String v = scalar(name);
			if (v == null) {
				return null;
			}
			if (!DIGITS.matcher(v).matches()) {
				issue(name, name + "은(는) 정수여야 합니다");
				return null;
			}
			BigInteger n = new BigInteger(v);
			if (n.compareTo(MAX_SAFE_INTEGER) > 0) {
				issue(name, name + "이(가) 너무 큽니다");
				return null;
			}
			return n.longValueExact();
		}

		private Long longMin(String name, long min, String belowMessage) {
			Long n = longValue(name);
			if (n != null && n < min) {
				issue(name, belowMessage);
				return null;
			}
			return n;
		}

		private Integer integer(String name, long min, Integer max, String belowMessage, String aboveMessage) {
			Long n = longValue(name);
			if (n == null) {
				return null;
			}
			if (n < min) {
				issue(name, belowMessage);
				return null;
			}
			if (max != null && n > max) {
				issue(name, aboveMessage);
				return null;
			}
			return n.intValue();
		}

		private Boolean bool(String name, String message) {
			String v = scalar(name);
			if (v == null) {
				return null;
			}
			if (v.equals("true")) {
				return Boolean.TRUE;
			}
			if (v.equals("false")) {
				return Boolean.FALSE;
			}
			issue(name, message);
			return null;
		}

		private Boolean onlyTrue(String name, String message) {
			String v = scalar(name);
			if (v == null) {
				return null;
			}
			if (v.equals("true")) {
				return Boolean.TRUE;
			}
			issue(name, message);
			return null;
		}

		private SortKey sort() {
			String v = scalar("sort");
			if (v == null) {
				return null;
			}
			return SortKey.fromParam(v).orElseGet(() -> {
				issue("sort", "sort는 " + SortKey.PARAM_LIST + " 중 하나여야 합니다");
				return null;
			});
		}

		private SortDirection dir() {
			String v = scalar("dir");
			if (v == null) {
				return null;
			}
			if (v.equals("asc")) {
				return SortDirection.ASC;
			}
			if (v.equals("desc")) {
				return SortDirection.DESC;
			}
			issue("dir", "dir는 asc 또는 desc여야 합니다");
			return null;
		}

		private LocalDate date(String name) {
			String v = scalar(name);
			if (v == null) {
				return null;
			}
			if (!DATE_SHAPE.matcher(v).matches()) {
				issue(name, name + "은(는) YYYY-MM-DD 형식이어야 합니다");
				return null;
			}
			try {
				return LocalDate.parse(v);
			}
			catch (DateTimeParseException e) {
				// 의도적 차이: 원본은 모양만 보고 2026-02-30 같은 값도 통과시켰다. MySQL DATE 비교는
				// 존재하지 않는 날짜를 오류로 내므로(500) 여기서 400으로 거른다.
				issue(name, name + "은(는) 존재하는 날짜여야 합니다");
				return null;
			}
		}

	}

}
