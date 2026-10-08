package com.auctionboss.common.json;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;

import tools.jackson.core.JsonGenerator;
import tools.jackson.databind.SerializationContext;
import tools.jackson.databind.ValueSerializer;

/**
 * Instant를 항상 {@code yyyy-MM-dd'T'HH:mm:ss.SSS'Z'}(밀리초 3자리, UTC)로 쓴다.
 * {@code Instant.toString()}은 밀리초가 0이면 자릿수를 생략하므로 원본 응답(JS의
 * {@code Date.toISOString()})과 달라진다. 밀리초 미만은 버린다(DB 저장 정밀도가 DATETIME(3)이다).
 */
public class InstantMillisSerializer extends ValueSerializer<Instant> {

	private static final DateTimeFormatter FORMAT = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'")
			.withZone(ZoneOffset.UTC);

	public static String format(Instant value) {
		return FORMAT.format(value);
	}

	@Override
	public void serialize(Instant value, JsonGenerator gen, SerializationContext ctxt) {
		gen.writeString(format(value));
	}

}
