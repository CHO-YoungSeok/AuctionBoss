package com.auctionboss.common.seed;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Comparator;

import javax.sql.DataSource;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * 개발·시연용 더미 시드 로더 (add-spring-mysql-backend D6).
 * {@code auctionboss.seed.enabled=true}일 때만 빈이 만들어진다. 운영 설정에는 이 빈 자체가 없다.
 * Flyway가 끝난 뒤(애플리케이션 기동 완료 후) items가 비어 있을 때만 db/seed/*.sql을 파일 이름 순으로,
 * 한 트랜잭션에서 실행한다. 이미 데이터가 있으면 아무것도 하지 않는다.
 * 시드는 Flyway 마이그레이션이 아니므로 스키마 버전 이력에 섞이지 않는다.
 */
@Component
@ConditionalOnProperty(name = "auctionboss.seed.enabled", havingValue = "true")
public class SeedLoader implements ApplicationRunner {

	private static final Logger log = LoggerFactory.getLogger(SeedLoader.class);
	private static final String SEED_PATTERN = "classpath:db/seed/*.sql";

	private final DataSource dataSource;
	private final JdbcTemplate jdbc;
	private final TransactionTemplate transaction;

	public SeedLoader(DataSource dataSource, JdbcTemplate jdbc, TransactionTemplate transaction) {
		this.dataSource = dataSource;
		this.jdbc = jdbc;
		this.transaction = transaction;
	}

	@Override
	public void run(ApplicationArguments args) throws IOException {
		load();
	}

	/**
	 * @return 시드를 적재했으면 true, 이미 데이터가 있어 건너뛰었으면 false
	 */
	public boolean load() throws IOException {
		Long existing = jdbc.queryForObject("SELECT COUNT(*) FROM items", Long.class);
		if (existing != null && existing > 0) {
			log.info("items에 이미 {}건이 있어 시드를 적재하지 않습니다.", existing);
			return false;
		}
		Resource[] files = new PathMatchingResourcePatternResolver().getResources(SEED_PATTERN);
		Arrays.sort(files, Comparator.comparing(Resource::getFilename));
		if (files.length == 0) {
			log.warn("{} 에 시드 파일이 없습니다.", SEED_PATTERN);
			return false;
		}
		ResourceDatabasePopulator populator = new ResourceDatabasePopulator();
		populator.setSqlScriptEncoding(StandardCharsets.UTF_8.name());
		populator.setContinueOnError(false);
		for (Resource file : files) {
			populator.addScript(file);
		}
		transaction.executeWithoutResult(status -> populator.execute(dataSource));
		log.info("시드 {}개 파일을 적재했습니다: items {}건", files.length,
				jdbc.queryForObject("SELECT COUNT(*) FROM items", Long.class));
		return true;
	}

}
