package com.auctionboss.common.json;

import java.time.Instant;
import java.time.LocalDate;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import tools.jackson.databind.ext.javatime.ser.LocalDateSerializer;
import tools.jackson.databind.module.SimpleModule;

/**
 * 응답 JSON 형식을 원본 Next.js API와 맞춘다. Spring Boot 4의 Jackson 3 자동 구성이
 * {@code JacksonModule} 빈을 전역 매퍼에 등록한다.
 * <ul>
 * <li>Instant: 항상 밀리초 3자리 UTC ({@link InstantMillisSerializer})</li>
 * <li>LocalDate: {@code YYYY-MM-DD}</li>
 * <li>Double: 정수 값이면 정수로({@code 1.0} -> {@code 1}, JS {@code JSON.stringify}와 같다)</li>
 * </ul>
 */
@Configuration(proxyBeanMethods = false)
public class JsonConfig {

	@Bean
	SimpleModule auctionBossJsonModule() {
		SimpleModule module = new SimpleModule("auctionboss-json");
		module.addSerializer(Instant.class, new InstantMillisSerializer());
		module.addSerializer(LocalDate.class, new LocalDateIsoSerializer());
		IntegralDoubleSerializer integralDouble = new IntegralDoubleSerializer();
		module.addSerializer(Double.class, integralDouble);
		module.addSerializer(Double.TYPE, integralDouble);
		return module;
	}

}
