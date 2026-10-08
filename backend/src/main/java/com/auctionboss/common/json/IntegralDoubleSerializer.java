package com.auctionboss.common.json;

import java.math.BigDecimal;

import tools.jackson.core.JsonGenerator;
import tools.jackson.databind.SerializationContext;
import tools.jackson.databind.ValueSerializer;

/**
 * 정수 값인 실수를 정수로 쓴다({@code 1.0} -> {@code 1}). 원본은 JS {@code JSON.stringify}라 {@code successRate}가 1이면
 * {@code 1}로 나간다. 소수는 그대로, 유한하지 않은 값은 JS처럼 {@code null}이다.
 */
public class IntegralDoubleSerializer extends ValueSerializer<Double> {

	@Override
	public void serialize(Double value, JsonGenerator gen, SerializationContext ctxt) {
		double d = value;
		if (Double.isNaN(d) || Double.isInfinite(d)) {
			gen.writeNull();
		}
		else if (JsNumbers.isIntegral(d) && Math.abs(d) < 9.2e18) {
			gen.writeNumber((long) d);
		}
		else if (JsNumbers.isIntegral(d)) {
			gen.writeNumber(new BigDecimal(d).toBigInteger());
		}
		else {
			gen.writeNumber(d);
		}
	}

}
