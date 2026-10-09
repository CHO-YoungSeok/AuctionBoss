package com.auctionboss.collect.collector;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

import com.auctionboss.collect.source.SourceItem;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.KeyHolder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 한 회차가 모은 물건을 저장하고 감시 필드 변경 이력을 남긴다 (TS {@code upsertItems}, design D8).
 *
 * <ul>
 * <li>한 호출이 한 트랜잭션이다. 이력 INSERT가 실패하면 물건 변경도 하나도 남지 않는다.</li>
 * <li>물건마다 자연 키로 사전 SELECT를 한 뒤 {@code INSERT ... ON DUPLICATE KEY UPDATE}를 항상 실행한다. 기존 행에도 INSERT를
 * 시도하는 것은 의도다: 자동 증가 id가 한 칸씩 소모되는 것이 TS(SQLite {@code ON CONFLICT})와 같아야 저장 골든의 {@code id}가
 * 일치한다. 신규·갱신 판정은 영향 행 수가 아니라 사전 SELECT로 한다.</li>
 * <li>{@code first_seen_at}은 갱신 목록에 없어 보존된다.</li>
 * <li>같은 키가 한 배치에 두 번 나오면 두 번째 행의 이력은 첫 번째 처리 결과와 비교된다. {@code changed}는 배치 시작 전 값 기준이다.</li>
 * </ul>
 */
@Service
public class ItemUpsertService {

	/** (컬럼, 값 꺼내기). TS {@code upsertItem}의 컬럼 순서와 같다. 자연 키 3개는 별도다. */
	private record Column(String name, Function<SourceItem, Object> value) {
	}

	private static final List<Column> COLUMNS = List.of(
			new Column("address", SourceItem::address),
			new Column("usage_type", SourceItem::usageType),
			new Column("appraisal_price", SourceItem::appraisalPrice),
			new Column("min_bid_price", SourceItem::minBidPrice),
			new Column("auction_date", SourceItem::auctionDate),
			new Column("failed_bid_count", SourceItem::failedBidCount),
			new Column("status", SourceItem::status),
			new Column("min_area", SourceItem::minArea),
			new Column("max_area", SourceItem::maxArea),
			new Column("building_description", SourceItem::buildingDescription),
			new Column("min_bid_price_round1", SourceItem::minBidPriceRound1),
			new Column("min_bid_price_round2", SourceItem::minBidPriceRound2),
			new Column("min_bid_price_round3", SourceItem::minBidPriceRound3),
			new Column("min_bid_price_round4", SourceItem::minBidPriceRound4),
			new Column("min_bid_price_rate_round1", SourceItem::minBidPriceRateRound1),
			new Column("min_bid_price_rate_round2", SourceItem::minBidPriceRateRound2),
			new Column("usage_code_large", SourceItem::usageCodeLarge),
			new Column("usage_code_medium", SourceItem::usageCodeMedium),
			new Column("usage_code_small", SourceItem::usageCodeSmall),
			new Column("sido", SourceItem::sido),
			new Column("sigungu", SourceItem::sigungu),
			new Column("dong", SourceItem::dong),
			new Column("lot_number", SourceItem::lotNumber),
			new Column("building_name", SourceItem::buildingName),
			new Column("building_unit", SourceItem::buildingUnit),
			new Column("coordinate_x", SourceItem::coordinateX),
			new Column("coordinate_y", SourceItem::coordinateY),
			new Column("coordinate_level", SourceItem::coordinateLevel),
			new Column("auction_time", SourceItem::auctionTime),
			new Column("auction_place", SourceItem::auctionPlace),
			new Column("auction_decision_date", SourceItem::auctionDecisionDate),
			new Column("auction_round", SourceItem::auctionRound),
			new Column("note", SourceItem::note),
			new Column("duplicate_case_no", SourceItem::duplicateCaseNo),
			new Column("merged_case_no", SourceItem::mergedCaseNo),
			new Column("court_department", SourceItem::courtDepartment),
			new Column("court_phone", SourceItem::courtPhone),
			new Column("status_code", SourceItem::statusCode),
			new Column("item_status_code", SourceItem::itemStatusCode),
			new Column("internal_case_no", SourceItem::internalCaseNo),
			new Column("court_code", SourceItem::courtCode));

	private static final String UPSERT_SQL = buildUpsertSql();

	private static final String SELECT_EXISTING_SQL = """
			SELECT id, min_bid_price, failed_bid_count, DATE_FORMAT(auction_date, '%Y-%m-%d') AS auction_date, status
			FROM items WHERE court = :court AND case_no = :caseNo AND item_no = :itemNo""";

	private static final String INSERT_CHANGE_SQL = """
			INSERT INTO item_changes (item_id, field, old_value, new_value, changed_at, kind)
			VALUES (:itemId, :field, :oldValue, :newValue, :changedAt, :kind)""";

	private final NamedParameterJdbcTemplate jdbc;

	ItemUpsertService(NamedParameterJdbcTemplate jdbc) {
		this.jdbc = jdbc;
	}

	/** 입력 순서대로 저장한다. {@code now}는 {@code last_seen_at}·신규 {@code first_seen_at}·이력 {@code changed_at}이다. */
	@Transactional
	public UpsertResult upsertItems(List<SourceItem> items, Instant now) {
		LocalDateTime at = LocalDateTime.ofInstant(now, ZoneOffset.UTC);
		int inserted = 0;
		int updated = 0;
		Map<String, KeyState> states = new LinkedHashMap<>();
		// 이력은 모아 두었다가 마지막에 JDBC 배치로 넣는다(순서 유지). 같은 트랜잭션이라 실패하면 물건 변경도 함께 취소된다.
		List<MapSqlParameterSource> pendingChanges = new ArrayList<>();

		for (SourceItem item : items) {
			WatchedFields.Existing existing = selectExisting(item);

			KeyHolder keys = new GeneratedKeyHolder();
			jdbc.update(UPSERT_SQL, upsertParams(item, at), keys);

			long itemId;
			List<WatchedFields.Change> history;
			String kind;
			if (existing != null) {
				updated++;
				itemId = existing.id();
				history = WatchedFields.detectChanges(existing, item);
				kind = "change";
			}
			else {
				inserted++;
				itemId = keys.getKey().longValue();
				history = WatchedFields.baselines(item);
				kind = "baseline";
			}
			for (WatchedFields.Change change : history) {
				pendingChanges.add(new MapSqlParameterSource().addValue("itemId", itemId)
					.addValue("field", change.field())
					.addValue("oldValue", change.oldValue())
					.addValue("newValue", change.newValue())
					.addValue("changedAt", at)
					.addValue("kind", kind));
			}

			// 구분자가 NUL 문자라 필드 값이 우연히 구분자를 포함해도 키가 충돌하지 않는다.
			String key = item.court() + '\0' + item.caseNo() + '\0' + item.itemNo();
			KeyState state = states.get(key);
			if (state == null) {
				states.put(key, new KeyState(existing, item));
			}
			else {
				state.finalItem = item;
			}
		}

		if (!pendingChanges.isEmpty()) {
			jdbc.batchUpdate(INSERT_CHANGE_SQL, pendingChanges.toArray(new MapSqlParameterSource[0]));
		}

		int changed = 0;
		for (KeyState state : states.values()) {
			if (state.baseline != null && !WatchedFields.detectChanges(state.baseline, state.finalItem).isEmpty()) {
				changed++;
			}
		}
		return new UpsertResult(inserted, updated, changed);
	}

	private WatchedFields.Existing selectExisting(SourceItem item) {
		List<WatchedFields.Existing> rows = jdbc.query(SELECT_EXISTING_SQL,
				new MapSqlParameterSource().addValue("court", item.court())
					.addValue("caseNo", item.caseNo())
					.addValue("itemNo", item.itemNo()),
				(rs, n) -> new WatchedFields.Existing(rs.getLong("id"), rs.getObject("min_bid_price", Long.class),
						rs.getObject("failed_bid_count", Long.class), rs.getString("auction_date"),
						rs.getString("status")));
		return rows.isEmpty() ? null : rows.get(0);
	}

	private static MapSqlParameterSource upsertParams(SourceItem item, LocalDateTime at) {
		MapSqlParameterSource p = new MapSqlParameterSource().addValue("court", item.court())
			.addValue("caseNo", item.caseNo())
			.addValue("itemNo", item.itemNo())
			.addValue("now", at);
		for (int i = 0; i < COLUMNS.size(); i++) {
			p.addValue("c" + i, COLUMNS.get(i).value().apply(item));
		}
		return p;
	}

	private static String buildUpsertSql() {
		List<String> names = new ArrayList<>();
		List<String> params = new ArrayList<>();
		List<String> updates = new ArrayList<>();
		for (int i = 0; i < COLUMNS.size(); i++) {
			String name = COLUMNS.get(i).name();
			names.add(name);
			params.add(":c" + i);
			updates.add(name + " = new." + name);
		}
		updates.add("last_seen_at = new.last_seen_at");
		return "INSERT INTO items (court, case_no, item_no, " + String.join(", ", names)
				+ ", first_seen_at, last_seen_at) VALUES (:court, :caseNo, :itemNo, " + String.join(", ", params)
				+ ", :now, :now) AS new ON DUPLICATE KEY UPDATE " + String.join(", ", updates);
	}

	/** 한 자연 키가 배치 안에서 어떤 상태로 시작했는지. {@code baseline}이 null이면 배치 전에는 없던 물건이다. */
	private static final class KeyState {

		final WatchedFields.Existing baseline;

		SourceItem finalItem;

		KeyState(WatchedFields.Existing baseline, SourceItem finalItem) {
			this.baseline = baseline;
			this.finalItem = finalItem;
		}

	}

}
