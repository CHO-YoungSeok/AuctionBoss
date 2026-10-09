package com.auctionboss.migration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.util.List;
import java.util.Map;

import com.auctionboss.common.seed.SeedLoader;
import com.auctionboss.support.AppLauncher;
import com.auctionboss.support.MySqlTestContainer;
import org.junit.jupiter.api.Test;
import org.springframework.boot.env.YamlPropertySourceLoader;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.core.env.MapPropertySource;
import org.springframework.core.env.MutablePropertySources;
import org.springframework.core.env.PropertiesPropertySource;
import org.springframework.core.env.StandardEnvironment;
import org.springframework.core.io.ClassPathResource;

/**
 * 3.6: 운영 프로필 설정(D9). 접속 정보는 환경 변수에서 기본값 없이 읽고, 시드 로더도 {@code .env} 읽기도 없다. 기동 시험은 시스템 환경 변수를 보지 않는
 * 격리된 환경으로 띄운다(개발 머신의 {@code DB_PASSWORD}가 시험 결과를 바꾸지 못하게).
 */
class ProdProfileIT {

	/** 시스템 환경 변수 없이 시스템 속성과 명령행만 보는 환경. */
	private static StandardEnvironment isolatedEnvironment() {
		return new StandardEnvironment() {
			@Override
			protected void customizePropertySources(MutablePropertySources propertySources) {
				propertySources.addLast(new PropertiesPropertySource("systemProperties", System.getProperties()));
			}
		};
	}

	private static List<String> connectionArgs(boolean withPassword) {
		List<String> args = new java.util.ArrayList<>(List.of("--spring.profiles.active=prod",
				"--spring.main.web-application-type=none", "--DB_HOST=" + MySqlTestContainer.MYSQL.getHost(),
				"--DB_PORT=" + MySqlTestContainer.MYSQL.getFirstMappedPort(),
				"--DB_NAME=" + MySqlTestContainer.MYSQL.getDatabaseName(),
				"--DB_USER=" + MySqlTestContainer.MYSQL.getUsername(), "--spring.datasource.hikari.maximum-pool-size=3"));
		if (withPassword) {
			args.add("--DB_PASSWORD=" + MySqlTestContainer.MYSQL.getPassword());
		}
		return args;
	}

	private static ConfigurableApplicationContext startWith(String extraArg) {
		List<String> args = new java.util.ArrayList<>(connectionArgs(false));
		args.add(extraArg);
		return run(args);
	}

	private static ConfigurableApplicationContext startWithout(String name) {
		List<String> args = new java.util.ArrayList<>(connectionArgs(true));
		args.removeIf(a -> a.startsWith("--" + name + "="));
		return run(args);
	}

	private static ConfigurableApplicationContext start(boolean withPassword) {
		return run(connectionArgs(withPassword));
	}

	private static ConfigurableApplicationContext run(List<String> args) {
		org.springframework.boot.SpringApplication app = new org.springframework.boot.SpringApplication(
				com.auctionboss.BackendApplication.class);
		app.setEnvironment(isolatedEnvironment());
		app.addInitializers(ctx -> ctx.getBeanFactory().registerSingleton("testConfigurationExcluder",
				new com.auctionboss.migration.ProdProfileIT.Excluder()));
		return app.run(args.toArray(String[]::new));
	}

	/** {@code @TestConfiguration}(공용 컨테이너 설정 등)을 스캔에서 뺀다. */
	static final class Excluder extends org.springframework.boot.context.TypeExcludeFilter {

		@Override
		public boolean match(org.springframework.core.type.classreading.MetadataReader reader,
				org.springframework.core.type.classreading.MetadataReaderFactory factory) {
			return reader.getAnnotationMetadata()
				.isAnnotated(org.springframework.boot.test.context.TestConfiguration.class.getName());
		}

		@Override
		public boolean equals(Object o) {
			return o instanceof Excluder;
		}

		@Override
		public int hashCode() {
			return Excluder.class.hashCode();
		}

	}

	@Test
	void 설정_파일의_접속_정보는_환경_변수_자리표시자이고_기본값이_없다() throws IOException {
		var sources = new YamlPropertySourceLoader().load("prod", new ClassPathResource("application-prod.yml"));
		Map<String, Object> props = new java.util.HashMap<>();
		for (var source : sources) {
			for (String name : ((MapPropertySource) source).getPropertyNames()) {
				props.put(name, source.getProperty(name));
			}
		}

		assertThat(props.get("spring.datasource.password")).isEqualTo("${DB_PASSWORD}");
		assertThat(props.get("spring.datasource.username")).isEqualTo("${DB_USER}");
		assertThat((String) props.get("spring.datasource.url")).contains("${DB_HOST}", "${DB_NAME}", "${DB_PORT:3306}");
		assertThat(props.keySet()).as(".env 읽기와 시드와 스케줄러를 켜는 설정이 없다")
			.noneMatch(k -> k.startsWith("spring.config.import") || k.startsWith("auctionboss.seed")
					|| k.startsWith("auctionboss.collector") || k.startsWith("auctionboss.photos")
					|| k.startsWith("auctionboss.source.external-requests-allowed"));
	}

	@Test
	void 비밀번호_환경_변수_없이는_변수_이름을_알리며_기동하지_못한다() {
		// 자리표시자가 글자 그대로 남아 접속을 시도하다 Access denied로 끝나지 않고, 연결 전에 변수 이름과 함께 실패한다.
		assertThatThrownBy(() -> start(false)).hasMessageContaining("DB_PASSWORD").hasMessageContaining("spring.datasource.password");
	}

	@Test
	void 비밀번호가_빈_문자열이어도_기동하지_못한다() {
		assertThatThrownBy(() -> startWith("--DB_PASSWORD=")).hasMessageContaining("spring.datasource.password");
	}

	@Test
	void 다른_접속_변수가_없어도_이름을_알리며_실패한다() {
		for (String name : List.of("DB_HOST", "DB_NAME", "DB_USER")) {
			assertThatThrownBy(() -> startWithout(name)).hasMessageContaining(name);
		}
	}

	@Test
	void prod가_아닌_프로필에는_검증이_없다() {
		var env = new org.springframework.core.env.StandardEnvironment();
		env.setActiveProfiles("local");
		new ProdProfileEnvironmentValidator().postProcessEnvironment(env, null);
	}

	@Test
	void 접속_정보가_모두_있으면_기동하고_시드_로더_빈이_없다() {
		try (ConfigurableApplicationContext context = start(true)) {
			assertThat(context.getBeansOfType(SeedLoader.class)).isEmpty();
			assertThat(context.getEnvironment().getActiveProfiles()).containsExactly("prod");
		}
	}

}
