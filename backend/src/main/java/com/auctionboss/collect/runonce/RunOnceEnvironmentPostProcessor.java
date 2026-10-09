package com.auctionboss.collect.runonce;

import java.util.Map;

import org.springframework.boot.EnvironmentPostProcessor;
import org.springframework.boot.SpringApplication;
import org.springframework.core.Ordered;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.MapPropertySource;

/**
 * 1회 실행 모드({@code auctionboss.run-once})면 웹 서버를 띄우지 않도록 {@code spring.main.web-application-type=none}을 기본값으로
 * 더한다(design D11). 가장 낮은 우선순위로 더하므로 사용자가 명시한 값은 이긴다. 속성이 없으면(기본) 아무것도 하지 않는다.
 *
 * <p>
 * {@code META-INF/spring.factories}로 등록한다: 웹 애플리케이션 유형은 컨텍스트를 만들기 전에 환경에서 읽히므로 설정 파일 활성화 조건이
 * 아니라 환경 후처리기가 맡는다.
 */
public class RunOnceEnvironmentPostProcessor implements EnvironmentPostProcessor, Ordered {

	static final String RUN_ONCE_PROPERTY = "auctionboss.run-once";

	@Override
	public void postProcessEnvironment(ConfigurableEnvironment environment, SpringApplication application) {
		if (environment.containsProperty(RUN_ONCE_PROPERTY)) {
			environment.getPropertySources()
				.addLast(new MapPropertySource("auctionbossRunOnceDefaults",
						Map.of("spring.main.web-application-type", "none")));
		}
	}

	@Override
	public int getOrder() {
		return Ordered.LOWEST_PRECEDENCE;
	}

}
