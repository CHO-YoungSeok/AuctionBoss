package com.auctionboss.collect.collector;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;

import com.auctionboss.collect.source.SourceItem;

/**
 * 변경 이력을 남기는 감시 필드와 비교 규칙 (TS {@code WATCHED_FIELD_DEFS}, {@code detectWatchedChanges},
 * {@code baselineWatchedChanges}와 같다). 가격·유찰 횟수는 숫자로, 매각기일·상태는 문자열로 비교하고, null과 값 사이는 변경이다.
 * 이력의 {@code field}에는 DB 컬럼명이 아니라 이 이름을 쓴다.
 */
final class WatchedFields {

	enum Kind {
		NUMERIC, STRING
	}

	private record Def(String field, Kind kind, Function<Existing, Object> stored, Function<SourceItem, Object> incoming) {
	}

	/** 저장 전 행에서 읽은 감시 필드 값. 날짜는 {@code YYYY-MM-DD} 문자열이다. */
	record Existing(long id, Object minBidPrice, Object failedBidCount, String auctionDate, String status) {
	}

	record Change(String field, String oldValue, String newValue) {
	}

	private static final List<Def> DEFS = List.of(
			new Def("minBidPrice", Kind.NUMERIC, Existing::minBidPrice, SourceItem::minBidPrice),
			new Def("failedBidCount", Kind.NUMERIC, Existing::failedBidCount, SourceItem::failedBidCount),
			new Def("auctionDate", Kind.STRING, Existing::auctionDate, SourceItem::auctionDate),
			new Def("status", Kind.STRING, Existing::status, SourceItem::status));

	private WatchedFields() {
	}

	/** 기존 값과 새 값 사이에 실제로 다른 감시 필드만, 정의 순서대로 돌려준다. */
	static List<Change> detectChanges(Existing existing, SourceItem incoming) {
		List<Change> changes = new ArrayList<>();
		for (Def def : DEFS) {
			Object oldRaw = def.stored().apply(existing);
			Object newRaw = def.incoming().apply(incoming);
			if (!valuesEqual(oldRaw, newRaw, def.kind())) {
				changes.add(new Change(def.field(), toHistoryValue(oldRaw), toHistoryValue(newRaw)));
			}
		}
		return changes;
	}

	/** 최초 저장의 기준점. 값이 없는 필드는 기준점을 만들지 않는다. {@code oldValue}는 항상 null이다. */
	static List<Change> baselines(SourceItem incoming) {
		List<Change> changes = new ArrayList<>();
		for (Def def : DEFS) {
			Object value = def.incoming().apply(incoming);
			if (value != null) {
				changes.add(new Change(def.field(), null, toHistoryValue(value)));
			}
		}
		return changes;
	}

	/** null끼리는 같고 null과 값은 다르다. 숫자 필드는 숫자 값으로(1000과 1000.0은 같음), 그 밖은 문자열로 비교한다. */
	static boolean valuesEqual(Object a, Object b, Kind kind) {
		if (a == null && b == null) {
			return true;
		}
		if (a == null || b == null) {
			return false;
		}
		if (kind == Kind.NUMERIC) {
			BigDecimal x = toNumber(a);
			BigDecimal y = toNumber(b);
			// JS에서 Number("abc")는 NaN이고 NaN은 자기 자신과도 같지 않다: 읽을 수 없는 값은 변경으로 본다.
			return x != null && y != null && x.compareTo(y) == 0;
		}
		return String.valueOf(a).equals(String.valueOf(b));
	}

	/** 이력 TEXT 컬럼에 쓸 형태. JS {@code String(value)}처럼 정수값은 소수점 없이 쓴다. */
	static String toHistoryValue(Object value) {
		if (value == null) {
			return null;
		}
		if (value instanceof Double || value instanceof Float || value instanceof BigDecimal) {
			BigDecimal n = toNumber(value);
			if (n != null) {
				return n.stripTrailingZeros().toPlainString();
			}
		}
		return String.valueOf(value);
	}

	private static BigDecimal toNumber(Object value) {
		try {
			return new BigDecimal(String.valueOf(value).trim());
		}
		catch (NumberFormatException e) {
			return null;
		}
	}

}
