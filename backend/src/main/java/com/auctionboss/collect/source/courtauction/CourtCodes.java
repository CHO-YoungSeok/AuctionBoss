package com.auctionboss.collect.source.courtauction;

import static java.util.Map.entry;

import java.util.Map;

/**
 * 법원사무소 코드(부동산 기준 60개, 응답 순서 그대로). 코드 목록 엔드포인트를 매번 두드리면 요청이 늘고 요청 수가 로봇탐지 임계에
 * 직결되므로 표로 박아 둔다(TS {@code courts.ts}와 같은 표).
 */
final class CourtCodes {

	private static final Map<String, String> BY_NAME = Map.ofEntries(
				entry("서울중앙지방법원", "B000210"),
				entry("서울동부지방법원", "B000211"),
				entry("서울서부지방법원", "B000215"),
				entry("서울남부지방법원", "B000212"),
				entry("서울북부지방법원", "B000213"),
				entry("의정부지방법원", "B000214"),
				entry("고양지원", "B214807"),
				entry("남양주지원", "B214804"),
				entry("인천지방법원", "B000240"),
				entry("부천지원", "B000241"),
				entry("수원지방법원", "B000250"),
				entry("성남지원", "B000251"),
				entry("여주지원", "B000252"),
				entry("평택지원", "B000253"),
				entry("안산지원", "B250826"),
				entry("안양지원", "B000254"),
				entry("춘천지방법원", "B000260"),
				entry("강릉지원", "B000261"),
				entry("원주지원", "B000262"),
				entry("속초지원", "B000263"),
				entry("영월지원", "B000264"),
				entry("청주지방법원", "B000270"),
				entry("충주지원", "B000271"),
				entry("제천지원", "B000272"),
				entry("영동지원", "B000273"),
				entry("대전지방법원", "B000280"),
				entry("홍성지원", "B000281"),
				entry("논산지원", "B000282"),
				entry("천안지원", "B000283"),
				entry("공주지원", "B000284"),
				entry("서산지원", "B000285"),
				entry("대구지방법원", "B000310"),
				entry("안동지원", "B000311"),
				entry("경주지원", "B000312"),
				entry("김천지원", "B000313"),
				entry("상주지원", "B000314"),
				entry("의성지원", "B000315"),
				entry("영덕지원", "B000316"),
				entry("포항지원", "B000317"),
				entry("대구서부지원", "B000320"),
				entry("부산지방법원", "B000410"),
				entry("부산동부지원", "B000412"),
				entry("부산서부지원", "B000414"),
				entry("울산지방법원", "B000411"),
				entry("창원지방법원", "B000420"),
				entry("마산지원", "B000431"),
				entry("진주지원", "B000421"),
				entry("통영지원", "B000422"),
				entry("밀양지원", "B000423"),
				entry("거창지원", "B000424"),
				entry("광주지방법원", "B000510"),
				entry("목포지원", "B000511"),
				entry("장흥지원", "B000512"),
				entry("순천지원", "B000513"),
				entry("해남지원", "B000514"),
				entry("전주지방법원", "B000520"),
				entry("군산지원", "B000521"),
				entry("정읍지원", "B000522"),
				entry("남원지원", "B000523"),
				entry("제주지방법원", "B000530"));

	private CourtCodes() {
	}

	/** 법원 이름으로 코드를 찾는다. 없으면 null. */
	static String byName(String name) {
		return BY_NAME.get(JsValues.trim(name));
	}

}
