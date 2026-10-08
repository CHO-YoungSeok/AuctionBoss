package com.auctionboss.common.json;

import java.time.LocalDate;

import tools.jackson.core.JsonGenerator;
import tools.jackson.databind.SerializationContext;
import tools.jackson.databind.ValueSerializer;

/** LocalDate를 항상 {@code YYYY-MM-DD} 문자열로 쓴다(타임스탬프 배열 방지). */
public class LocalDateIsoSerializer extends ValueSerializer<LocalDate> {

	@Override
	public void serialize(LocalDate value, JsonGenerator gen, SerializationContext ctxt) {
		gen.writeString(value.toString());
	}

}
