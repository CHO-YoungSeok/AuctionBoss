package com.auctionboss.migration;

import java.util.List;

import org.springframework.boot.EnvironmentPostProcessor;
import org.springframework.boot.SpringApplication;
import org.springframework.core.Ordered;
import org.springframework.core.env.ConfigurableEnvironment;

/**
 * {@code prod} 프로필의 접속 정보({@code application-prod.yml}의 {@code ${DB_*}} 자리표시자)가 풀리지 않았으면 변수 이름을 알리고 기동을
 * 거부한다(design D9). 설정 바인딩은 풀리지 않은 자리표시자를 글자 그대로 남겨 비밀번호가 {@code "${DB_PASSWORD}"} 문자열인 채 접속을 시도하다
 * {@code Access denied}로 끝나기 때문이다. 메시지에는 값이 아니라 자리표시자 이름만 나온다. 빈 사용자·비밀번호도 거부한다. 다른 프로필에는 아무것도
 * 하지 않는다.
 */
public class ProdProfileEnvironmentValidator implements EnvironmentPostProcessor, Ordered {

	private static final List<String> REQUIRED = List.of("spring.datasource.url", "spring.datasource.username",
			"spring.datasource.password");

	@Override
	public void postProcessEnvironment(ConfigurableEnvironment environment, SpringApplication application) {
		if (!List.of(environment.getActiveProfiles()).contains("prod")) {
			return;
		}
		for (String key : REQUIRED) {
			String value;
			try {
				value = environment.getProperty(key) == null ? null : environment.getRequiredProperty(key);
			}
			catch (IllegalArgumentException e) {
				throw new IllegalStateException("prod 프로필 설정을 풀 수 없습니다(" + key + "): " + e.getMessage()
						+ " - 해당 환경 변수를 설정하세요(DB_HOST, DB_NAME, DB_USER, DB_PASSWORD)");
			}
			if (value == null || (!key.endsWith(".url") && value.isBlank())) {
				throw new IllegalStateException("prod 프로필에 " + key + " 값이 없습니다 - 환경 변수 DB_HOST, DB_NAME, DB_USER, DB_PASSWORD를 설정하세요");
			}
		}
	}

	@Override
	public int getOrder() {
		return Ordered.LOWEST_PRECEDENCE;
	}

}
