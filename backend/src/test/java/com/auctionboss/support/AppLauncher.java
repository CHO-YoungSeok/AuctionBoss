package com.auctionboss.support;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;

import com.auctionboss.BackendApplication;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.context.TypeExcludeFilter;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.core.type.classreading.MetadataReader;
import org.springframework.core.type.classreading.MetadataReaderFactory;

/**
 * 실제 애플리케이션 기동 경로({@link SpringApplication})로 컨텍스트를 한 번 띄우는 테스트 도구. 공용 MySQL 컨테이너를 데이터소스로 주고
 * 연결 풀을 3으로 줄인다. {@code @DirtiesContext}를 쓰지 않는다: 띄운 컨텍스트는 호출자가 닫는다. 컴포넌트 스캔에 딸려 오는 테스트 전용 설정은
 * 뺀다. 웹 서버를 띄우는 실행은 {@code --server.port=0}을 호출자가 준다.
 */
public final class AppLauncher {

	private AppLauncher() {
	}

	/** 띄운 컨텍스트와 {@link SpringApplication#exit} 종료 코드(1회 실행 모드용). */
	public record Launched(ConfigurableApplicationContext context, int exitCode) {
	}

	/** 컨텍스트만 띄운다(종료 코드를 묻지 않는다). */
	public static ConfigurableApplicationContext start(String... extraArgs) {
		return start(app -> {
		}, extraArgs);
	}

	public static ConfigurableApplicationContext start(Consumer<SpringApplication> customizer, String... extraArgs) {
		SpringApplication app = new SpringApplication(BackendApplication.class);
		app.addInitializers(ctx -> ctx.getBeanFactory().registerSingleton("testConfigurationExcluder",
				new TestConfigurationExcluder()));
		customizer.accept(app);
		List<String> args = new ArrayList<>(List.of(extraArgs));
		args.add("--spring.datasource.url=" + MySqlTestContainer.MYSQL.getJdbcUrl());
		args.add("--spring.datasource.username=" + MySqlTestContainer.MYSQL.getUsername());
		args.add("--spring.datasource.password=" + MySqlTestContainer.MYSQL.getPassword());
		args.add("--spring.datasource.hikari.maximum-pool-size=3");
		return app.run(args.toArray(String[]::new));
	}

	/** 1회 실행 모드: 띄워서 종료 코드를 받는다. 컨텍스트는 호출자가 닫는다. */
	public static Launched launch(String... extraArgs) {
		ConfigurableApplicationContext context = start(extraArgs);
		return new Launched(context, SpringApplication.exit(context));
	}

	/** {@link TestConfiguration}이 붙은 클래스를 스캔에서 뺀다. */
	static final class TestConfigurationExcluder extends TypeExcludeFilter {

		@Override
		public boolean match(MetadataReader reader, MetadataReaderFactory factory) {
			return reader.getAnnotationMetadata().isAnnotated(TestConfiguration.class.getName());
		}

		@Override
		public boolean equals(Object o) {
			return o instanceof TestConfigurationExcluder;
		}

		@Override
		public int hashCode() {
			return TestConfigurationExcluder.class.hashCode();
		}

	}

}
