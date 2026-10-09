package com.auctionboss.migration;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.List;
import java.util.Set;

import com.auctionboss.migration.RowNormalizer.Kind;

/**
 * MySQL 테이블의 행 정규화 해시(D4). 원본(SQLite) 쪽 해시는 TS가, 대상(MySQL) 쪽 해시는 여기서 각자 계산한다. 컬럼 종류는 이름 목록이
 * 아니라 MySQL 컬럼 형식({@code information_schema})에서 정하고, 행 순서는 기본 키(정수는 숫자로, 문자열은 UTF-8 바이트 순으로 — MySQL
 * 콜레이션 정렬은 쓰지 않는다)로 정한다.
 */
final class TableDigest {

	/** 이전 완료 표식 키는 대상 쪽 해시와 행 수에서 뺀다(D7). */
	static final Set<String> EXCLUDED_COLLECTOR_STATE_KEYS = Set.of(MigrationMarker.KEY);

	record Column(String name, Kind kind) {
	}

	/** 행 하나: 기본 키 텍스트와 정규화한 값들. */
	record Row(String key, List<String> values) {
	}

	record Result(long rows, String sha256) {
	}

	private TableDigest() {
	}

	/** {@code order}의 컬럼 순서대로 컬럼 종류를 읽는다. 대상에 없는 컬럼이 있으면 예외다. */
	static List<Column> columns(Connection connection, String table, List<String> order) throws SQLException {
		List<Column> result = new ArrayList<>();
		java.util.Map<String, String> types = new java.util.HashMap<>();
		try (PreparedStatement st = connection.prepareStatement(
				"SELECT column_name AS n, data_type AS t FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?")) {
			st.setString(1, table);
			try (ResultSet rs = st.executeQuery()) {
				while (rs.next()) {
					types.put(rs.getString("n"), rs.getString("t").toLowerCase());
				}
			}
		}
		for (String name : order) {
			String type = types.get(name);
			if (type == null) {
				throw new IllegalStateException("대상에 컬럼이 없습니다: " + table + "." + name);
			}
			result.add(new Column(name, kindOf(type)));
		}
		return result;
	}

	static Kind kindOf(String dataType) {
		return switch (dataType) {
			case "tinyint", "smallint", "mediumint", "int", "bigint" -> Kind.INT;
			case "datetime", "timestamp" -> Kind.DATETIME;
			case "date" -> Kind.DATE;
			case "json" -> Kind.JSON;
			default -> Kind.TEXT;
		};
	}

	/** 테이블의 기본 키(한 컬럼)와 종류. */
	private record Key(String name, boolean numeric) {
	}

	private static Key primaryKey(Connection connection, String table) throws SQLException {
		try (PreparedStatement st = connection.prepareStatement(
				"SELECT k.column_name AS n, c.data_type AS t FROM information_schema.key_column_usage k "
						+ "JOIN information_schema.columns c ON c.table_schema = k.table_schema AND c.table_name = k.table_name AND c.column_name = k.column_name "
						+ "WHERE k.table_schema = DATABASE() AND k.table_name = ? AND k.constraint_name = 'PRIMARY'")) {
			st.setString(1, table);
			try (ResultSet rs = st.executeQuery()) {
				if (!rs.next()) {
					throw new IllegalStateException("기본 키가 없습니다: " + table);
				}
				Key key = new Key(rs.getString("n"), kindOf(rs.getString("t").toLowerCase()) == Kind.INT);
				if (rs.next()) {
					throw new IllegalStateException("복합 기본 키는 지원하지 않습니다: " + table);
				}
				return key;
			}
		}
	}

	/** 표식 키를 뺀 정규화 행들을 기본 키 순서로 읽는다. {@code source}는 읽을 테이블(비교용 임시 테이블이면 다른 이름)이다. */
	static List<Row> rows(Connection connection, String table, String source, List<Column> columns) throws SQLException {
		Key key = primaryKey(connection, table);
		StringBuilder sql = new StringBuilder("SELECT ");
		for (int i = 0; i < columns.size(); i++) {
			sql.append(i > 0 ? ", " : "").append('`').append(columns.get(i).name()).append('`');
		}
		sql.append(" FROM `").append(source).append('`');
		boolean filterMarker = table.equals("collector_state");
		if (filterMarker) {
			sql.append(" WHERE `key` NOT IN (").append("?,".repeat(EXCLUDED_COLLECTOR_STATE_KEYS.size()), 0,
					EXCLUDED_COLLECTOR_STATE_KEYS.size() * 2 - 1).append(')');
		}
		int keyIndex = -1;
		for (int i = 0; i < columns.size(); i++) {
			if (columns.get(i).name().equals(key.name())) {
				keyIndex = i;
			}
		}
		if (keyIndex < 0) {
			throw new IllegalStateException("기본 키 컬럼이 컬럼 목록에 없습니다: " + table);
		}
		List<Row> rows = new ArrayList<>();
		try (PreparedStatement st = connection.prepareStatement(sql.toString())) {
			if (filterMarker) {
				int i = 1;
				for (String excluded : EXCLUDED_COLLECTOR_STATE_KEYS) {
					st.setString(i++, excluded);
				}
			}
			try (ResultSet rs = st.executeQuery()) {
				while (rs.next()) {
					List<String> values = new ArrayList<>(columns.size());
					for (int i = 0; i < columns.size(); i++) {
						values.add(value(rs, i + 1, columns.get(i)));
					}
					rows.add(new Row(values.get(keyIndex), values));
				}
			}
		}
		Comparator<Row> order = key.numeric()
				? Comparator.comparing((Row r) -> new java.math.BigInteger(r.key()))
				: (a, b) -> Arrays.compareUnsigned(a.key().getBytes(StandardCharsets.UTF_8),
						b.key().getBytes(StandardCharsets.UTF_8));
		rows.sort(order);
		return rows;
	}

	private static String value(ResultSet rs, int index, Column column) throws SQLException {
		switch (column.kind()) {
			case INT: {
				long v = rs.getLong(index);
				return rs.wasNull() ? null : RowNormalizer.integer(v);
			}
			case DATETIME: {
				LocalDateTime v = rs.getObject(index, LocalDateTime.class);
				return v == null ? null : RowNormalizer.datetime(v);
			}
			case DATE: {
				LocalDate v = rs.getObject(index, LocalDate.class);
				return v == null ? null : RowNormalizer.date(v);
			}
			case JSON: {
				String v = rs.getString(index);
				return v == null ? null : RowNormalizer.json(v);
			}
			default:
				return rs.getString(index);
		}
	}

	static Result digest(List<Row> rows) {
		try {
			MessageDigest sha = MessageDigest.getInstance("SHA-256");
			for (int i = 0; i < rows.size(); i++) {
				if (i > 0) {
					sha.update((byte) '\n');
				}
				sha.update(RowNormalizer.line(rows.get(i).values()).getBytes(StandardCharsets.UTF_8));
			}
			return new Result(rows.size(), HexFormat.of().formatHex(sha.digest()));
		}
		catch (NoSuchAlgorithmException e) {
			throw new IllegalStateException(e);
		}
	}

	/** 테이블 해시를 계산한다. 값 변환 실패는 값 없는 예외다(호출자가 테이블 이름을 붙인다). */
	static Result compute(Connection connection, String table, List<String> columnOrder) throws SQLException {
		List<Column> columns = columns(connection, table, columnOrder);
		return digest(rows(connection, table, table, columns));
	}

}
