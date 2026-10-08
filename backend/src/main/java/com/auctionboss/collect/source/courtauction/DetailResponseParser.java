package com.auctionboss.collect.source.courtauction;

import com.auctionboss.collect.source.ResponseSchemaException;
import java.util.ArrayList;
import java.util.List;

import tools.jackson.databind.JsonNode;

/**
 * 상세 응답 3단 검사와 파싱. {@code dma_result.csBaseInfo}(객체)와 {@code csPicLst}(배열)의 존재와 모양이 필수이고, 그 안의 필드는 전부 선택이다.
 */
final class DetailResponseParser {

	private static final List<String> BASE_INFO_TEXT = List.of("cortOfcCd", "cortOfcNm", "cortSptNm", "csNo", "csNm",
			"csRcptYmd", "csCmdcYmd", "rletApalYn", "auctnSuspStatCd", "ultmtDvsCd", "csUltmtYmd", "csProgStatCd",
			"jdgeAojAsstnNm", "auctnDpcnMrgDvsCd", "csProgSuspRsn", "mvprpCsNo", "mvprpRletDvsCd", "jdbnCd",
			"cortAuctnJdbnNm", "jdbnTelno", "execrCsTelno", "cortTypCd", "expCsNo", "lwstDvsCd", "userCsNo");

	private DetailResponseParser() {
	}

	/** 사진 항목(순서 그대로). */
	static List<DetailPic> parse(String raw) {
		JsonNode data = ResponseEnvelope.openData(raw, "상세 응답 본문을 JSON으로 파싱하지 못했습니다");

		List<String> issues = new ArrayList<>();
		List<DetailPic> pics = new ArrayList<>();
		JsonNode result = data.get("dma_result");
		if (result == null || !result.isObject()) {
			issues.add("dma_result: Invalid input: expected object, received " + FieldReader.typeName(result));
		}
		else {
			JsonNode base = result.get("csBaseInfo");
			if (base == null || !base.isObject()) {
				issues.add("dma_result.csBaseInfo: Invalid input: expected object, received " + FieldReader.typeName(base));
			}
			else {
				FieldReader r = new FieldReader(base, "dma_result.csBaseInfo.", issues);
				BASE_INFO_TEXT.forEach(r::text);
				r.numeric("clmAmt");
			}

			JsonNode list = result.get("csPicLst");
			if (list == null || !list.isArray()) {
				issues.add("dma_result.csPicLst: Invalid input: expected array, received " + FieldReader.typeName(list));
			}
			else {
				int index = 0;
				for (JsonNode pic : list) {
					String path = "dma_result.csPicLst." + index + ".";
					if (!pic.isObject()) {
						issues.add(path.substring(0, path.length() - 1) + ": Invalid input: expected object, received "
								+ FieldReader.typeName(pic));
					}
					else {
						FieldReader p = new FieldReader(pic, path, issues);
						p.text("picFileUrl");
						p.text("picTitlNm");
						p.text("cortAuctnPicDvsCd");
						Numericish seq = p.numeric("cortAuctnPicSeq");
						p.numeric("pageSeq");
						p.text("cortOfcCd");
						p.text("csNo");
						pics.add(new DetailPic(seq, p.text("picFile")));
					}
					index++;
				}
			}
		}

		if (!issues.isEmpty()) {
			throw new ResponseSchemaException("상세 응답 형식이 기대와 다릅니다 (사이트가 응답 구조를 바꿨을 수 있습니다)", issues);
		}
		return pics;
	}

}
