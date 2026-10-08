package com.auctionboss.collect.source.courtauction;

import com.auctionboss.collect.source.CourtRef;
import com.auctionboss.collect.source.SourceItem;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * 검색 결과 행을 물건 단위로 접고 정규화 모델({@link SourceItem})로 바꾼다. 변환 함수 이름과 규칙은 TS 어댑터와 같다.
 *
 * <p>
 * 일괄매각 물건은 목적물 수만큼 행으로 나오므로 자연 키 (법원, 사건번호, 물건번호) = ({@code jiwonNm}, {@code srnSaNo},
 * {@code maemulSer})로 묶는다. DB의 UNIQUE 키와 같은 기준이라 배치 안 중복이 확실히 없어진다.
 */
final class RowFolder {

	private static final Logger log = LoggerFactory.getLogger(RowFolder.class);

	private static final Pattern YMD = Pattern.compile("\\d{8}");

	private RowFolder() {
	}

	// ----------------------------------------------------------------- 값 변환

	/** 문자열/숫자로 오는 수치를 정수로. 빈 값·비수치·{@code Long} 밖은 null. 소수는 0 방향으로 버린다. */
	static Long toInt(Numericish value) {
		if (value == null) {
			return null;
		}
		if (value.number() != null) {
			return JsValues.truncToLong(value.number());
		}
		String cleaned = JsValues.trim(value.text().replace(",", ""));
		if (cleaned.isEmpty()) {
			return null;
		}
		return JsValues.truncToLong(JsValues.toNumber(cleaned));
	}

	/** 0이 "값 없음"인 확장 필드(가격·면적·최저가율·회차)용. {@link #toInt}와 달리 0을 null로 접는다. */
	static Long toIntNonZero(Numericish value) {
		Long n = toInt(value);
		return n == null || n == 0 ? null : n;
	}

	/** 앞뒤 공백을 지우고 빈 문자열은 null. */
	static String text(String value) {
		if (value == null) {
			return null;
		}
		String trimmed = JsValues.trim(value);
		return trimmed.isEmpty() ? null : trimmed;
	}

	/** {@code YYYYMMDD} → {@code YYYY-MM-DD}. 형식이 아니면 null. */
	static String toIsoDate(String ymd) {
		if (ymd == null || ymd.isEmpty()) {
			return null;
		}
		String trimmed = JsValues.trim(ymd);
		if (!YMD.matcher(trimmed).matches()) {
			return null;
		}
		return trimmed.substring(0, 4) + "-" + trimmed.substring(4, 6) + "-" + trimmed.substring(6, 8);
	}

	/** 진행상태 문자열. 소스 값이 아니라 유찰 횟수에서 만든 파생값이다(화면과 같은 규칙). */
	static String deriveStatus(Long failedBidCount) {
		if (failedBidCount == null) {
			return null;
		}
		return failedBidCount == 0 ? "신건" : "유찰 " + failedBidCount + "회";
	}

	/** 목적물 행들 중 주소 하나: 지번({@code A}) 행의 첫 값, 없으면 첫 값이 있는 행. */
	static String pickAddress(List<SearchRow> rows) {
		for (SearchRow row : rows) {
			if ("A".equals(text(row.addrGbncd())) && text(row.printSt()) != null) {
				return text(row.printSt());
			}
		}
		for (SearchRow row : rows) {
			if (text(row.printSt()) != null) {
				return text(row.printSt());
			}
		}
		return null;
	}

	/** 최저매각가격: 공고 1차 가격이 양수면 그 값, 아니면 내부값이 양수면 그 값, 아니면 {@code notify ?? fallback}. */
	static Long pickMinBidPrice(SearchRow row) {
		Long notify = toInt(row.notifyMinmaePrice1());
		if (notify != null && notify > 0) {
			return notify;
		}
		Long fallback = toInt(row.minmaePrice());
		if (fallback != null && fallback > 0) {
			return fallback;
		}
		return notify != null ? notify : fallback;
	}

	// ----------------------------------------------------------------- 접기

	static List<SourceItem> fold(List<SearchRow> rows, CourtRef court) {
		Map<String, List<SearchRow>> groups = new LinkedHashMap<>();
		List<String> dropped = new ArrayList<>();

		for (SearchRow row : rows) {
			String courtName = text(row.jiwonNm());
			String caseNo = text(row.srnSaNo());
			String itemNo = text(row.maemulSer());
			if (courtName == null || caseNo == null || itemNo == null) {
				List<String> missing = new ArrayList<>();
				if (courtName == null) {
					missing.add("jiwonNm(법원)");
				}
				if (caseNo == null) {
					missing.add("srnSaNo(사건번호)");
				}
				if (itemNo == null) {
					missing.add("maemulSer(물건번호)");
				}
				String docid = text(row.docid());
				dropped.add((docid != null ? docid : "(docid 없음)") + ": " + String.join(", ", missing) + " 누락");
				continue;
			}
			groups.computeIfAbsent(courtName + "\u0000" + caseNo + "\u0000" + itemNo, k -> new ArrayList<>()).add(row);
		}

		if (!dropped.isEmpty()) {
			log.warn("[courtauction] {}: 필수 필드가 없어 {}행을 제외했습니다\n{}", court.name(), dropped.size(),
					String.join("\n", dropped.stream().map(d -> "  - " + d).toList()));
		}
		if (!rows.isEmpty() && groups.isEmpty()) {
			log.warn("[courtauction] {}: 수신한 {}행이 전부 제외됐습니다 — 응답 필드명 변경을 의심할 것", court.name(), rows.size());
		}

		List<SourceItem> items = groups.values().stream().map(RowFolder::toItem).toList();
		if (!items.isEmpty() && items.stream().noneMatch(RowFolder::hasAnyExtendedField)) {
			log.warn("[courtauction] {}: 수신한 {}건에 확장 필드가 전부 비어 있습니다 — 응답 필드명 변경을 의심할 것", court.name(),
					items.size());
		}
		return items;
	}

	/** 주소 외 필드는 첫 행에서 읽는다(목적물 행끼리 사건·기일·금액은 같다). */
	static SourceItem toItem(List<SearchRow> rows) {
		SearchRow head = rows.get(0);
		Long failedBidCount = toInt(head.yuchalCnt());
		return new SourceItem(text(head.jiwonNm()), text(head.srnSaNo()), text(head.maemulSer()), pickAddress(rows),
				text(head.dspslUsgNm()), toInt(head.gamevalAmt()), pickMinBidPrice(head), toIsoDate(head.maeGiil()),
				failedBidCount, deriveStatus(failedBidCount),
				// 확장 필드
				toIntNonZero(head.minArea()), toIntNonZero(head.maxArea()), text(head.pjbBuldList()),
				toIntNonZero(head.notifyMinmaePrice1()), toIntNonZero(head.notifyMinmaePrice2()),
				toIntNonZero(head.notifyMinmaePrice3()), toIntNonZero(head.notifyMinmaePrice4()),
				toIntNonZero(head.notifyMinmaePriceRate1()), toIntNonZero(head.notifyMinmaePriceRate2()),
				text(head.lclsUtilCd()), text(head.mclsUtilCd()), text(head.sclsUtilCd()), text(head.hjguSido()),
				text(head.hjguSigu()), text(head.hjguDong()), text(head.daepyoLotno()), text(head.buldNm()),
				text(head.buldList()), text(head.xCordi()), text(head.yCordi()), text(head.cordiLvl()),
				text(head.maeHh1()), text(head.maePlace()), toIsoDate(head.maegyuljGiil()),
				toIntNonZero(head.maeGiilCnt()), text(head.mulBigo()), text(head.dupSaNo()), text(head.byungSaNo()),
				text(head.jpDeptNm()), text(head.tel()), text(head.jinstatCd()), text(head.mulStatcd()),
				// 상세 조회 식별자
				text(head.saNo()), text(head.boCd()));
	}

	/**
	 * 확장 필드가 하나라도 값을 가졌는지. 상세 조회 식별자({@code internalCaseNo}, {@code courtCode})는 확장 묶음이 아니므로 세지 않는다.
	 */
	static boolean hasAnyExtendedField(SourceItem i) {
		return Stream.of(i.minArea(), i.maxArea(), i.buildingDescription(), i.minBidPriceRound1(), i.minBidPriceRound2(),
				i.minBidPriceRound3(), i.minBidPriceRound4(), i.minBidPriceRateRound1(), i.minBidPriceRateRound2(),
				i.usageCodeLarge(), i.usageCodeMedium(), i.usageCodeSmall(), i.sido(), i.sigungu(), i.dong(),
				i.lotNumber(), i.buildingName(), i.buildingUnit(), i.coordinateX(), i.coordinateY(),
				i.coordinateLevel(), i.auctionTime(), i.auctionPlace(), i.auctionDecisionDate(), i.auctionRound(),
				i.note(), i.duplicateCaseNo(), i.mergedCaseNo(), i.courtDepartment(), i.courtPhone(), i.statusCode(),
				i.itemStatusCode())
			.anyMatch(v -> v != null);
	}

	/** 설정의 {@code courtCode}가 비어 있으면 법원 이름으로 표에서 찾는다. 못 찾으면 요청 오류. */
	static String resolveCourtCode(CourtRef court, String searchUrl) {
		String explicit = JsValues.trim(court.courtCode());
		if (!explicit.isEmpty()) {
			return explicit;
		}
		String found = CourtCodes.byName(court.name());
		if (found != null) {
			return found;
		}
		throw new com.auctionboss.collect.source.SourceRequestException(
				"법원 코드를 알 수 없습니다: \"" + court.name() + "\" — config/collector.json의 courtCode를 채우세요", searchUrl);
	}

}
