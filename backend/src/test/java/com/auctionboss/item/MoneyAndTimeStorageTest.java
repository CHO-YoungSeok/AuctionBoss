package com.auctionboss.item;

import static com.auctionboss.support.TestData.item;
import static org.assertj.core.api.Assertions.assertThat;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.TimeZone;

import com.auctionboss.support.AbstractMySqlTest;
import com.auctionboss.support.MySqlTestContainer;
import com.zaxxer.hikari.HikariDataSource;
import jakarta.persistence.EntityManager;
import jakarta.persistence.EntityManagerFactory;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

/** 스펙 "금액과 시각의 정확한 저장". */
class MoneyAndTimeStorageTest extends AbstractMySqlTest {

	private static final long MAX_APPRAISAL = 51_005_255_120L;

	@Autowired
	ItemRepository items;
	@Autowired
	EntityManagerFactory emf;
	@Autowired
	HikariDataSource dataSource;

	@Test
	void storesAmountAboveIntRangeExactly() {
		Item saved = items.saveAndFlush(item("2025타경10", "1").appraisalPrice(MAX_APPRAISAL)
				.minBidPrice(MAX_APPRAISAL - 1)
				.priceRounds(new PriceRounds(MAX_APPRAISAL, 40_804_204_096L, 32_643_363_277L, 26_114_690_621L, 80, 64))
				.build());

		Item read = readWithFreshEntityManager(saved.getId());

		assertThat(read.getAppraisalPrice()).isEqualTo(51_005_255_120L);
		assertThat(read.getMinBidPrice()).isEqualTo(51_005_255_119L);
		assertThat(read.getPriceRounds().minBidPriceRound1()).isEqualTo(51_005_255_120L);
		assertThat(read.getPriceRounds().minBidPriceRound4()).isEqualTo(26_114_690_621L);
		// 원본 DB 값도 BIGINT 그대로
		assertThat(jdbc.queryForObject("SELECT appraisal_price FROM items WHERE id = ?", Long.class, saved.getId()))
				.isEqualTo(MAX_APPRAISAL);
	}

	@Test
	void storesDateOnlyValuesAsDate() {
		Item saved = items.saveAndFlush(item("2025타경11", "1")
				.schedule(new AuctionSchedule(LocalDate.of(2026, 10, 7), "1000", "법정", LocalDate.of(2026, 10, 14), 1))
				.build());

		assertThat(jdbc.queryForObject("SELECT CAST(auction_date AS CHAR) FROM items WHERE id = ?", String.class,
				saved.getId())).isEqualTo("2026-10-07");
		assertThat(readWithFreshEntityManager(saved.getId()).getSchedule().auctionDate())
				.isEqualTo(LocalDate.of(2026, 10, 7));
	}

	@Test
	void sameInstantRegardlessOfJvmTimeZone() {
		TimeZone original = TimeZone.getDefault();
		Instant instant = Instant.parse("2026-09-08T11:48:38.617Z");
		try {
			for (String zone : List.of("UTC", "Asia/Seoul", "America/New_York", "Pacific/Kiritimati")) {
				// 쓰는 쪽과 읽는 쪽의 시간대를 서로 다르게 둔다.
				TimeZone.setDefault(TimeZone.getTimeZone(zone));
				Item saved = items.saveAndFlush(Item.builder("서울중앙지방법원", "2025타경12-" + zone, "1", instant, instant).build());

				for (String readZone : List.of("Asia/Seoul", "America/New_York", "UTC")) {
					TimeZone.setDefault(TimeZone.getTimeZone(readZone));
					Item read = readWithFreshEntityManager(saved.getId());
					assertThat(read.getFirstSeenAt()).as("write=%s read=%s", zone, readZone).isEqualTo(instant);
					assertThat(read.getLastSeenAt()).isEqualTo(instant);
				}

				// DB에 저장된 원본 문자열은 항상 UTC 값이다.
				assertThat(jdbc.queryForObject(
						"SELECT DATE_FORMAT(first_seen_at, '%Y-%m-%dT%H:%i:%s.%f') FROM items WHERE id = ?",
						String.class, saved.getId())).as("write=%s", zone).isEqualTo("2026-09-08T11:48:38.617000");
			}
		}
		finally {
			TimeZone.setDefault(original);
		}
	}

	/**
	 * 드라이버 설정(forceConnectionTimeZoneToSession)이 모든 연결의 세션 시간대를 UTC로 맞추는지.
	 * 이 설정이 빠지면 세션 시간대는 서버 기본값(SYSTEM)이 되어 이 테스트가 실패한다.
	 */
	@Test
	void everyConnectionUsesUtcSessionTimeZone() {
		assertThat(jdbc.queryForObject("SELECT @@session.time_zone", String.class)).isEqualTo("+00:00");
	}

	/**
	 * 스펙 시나리오 "시간대가 다른 환경": MySQL 서버의 전역 시간대를 서울(+09:00)로 바꾼 뒤
	 * 새로 맺은 연결로 저장해도, 저장된 원본 값과 다시 읽은 Instant가 UTC 기준으로 같아야 한다.
	 */
	@Test
	void storesUtcEvenWhenServerTimeZoneDiffers() throws Exception {
		Instant instant = Instant.parse("2026-09-08T11:48:38.617Z");
		try {
			setServerGlobalTimeZone("+09:00");
			dataSource.getHikariPoolMXBean().softEvictConnections(); // 이후 연결은 새로 맺는다

			assertThat(jdbc.queryForObject("SELECT @@global.time_zone", String.class)).isEqualTo("+09:00");
			Item saved = items.saveAndFlush(Item.builder("서울중앙지방법원", "2025타경13", "1", instant, instant).build());

			assertThat(jdbc.queryForObject(
					"SELECT DATE_FORMAT(first_seen_at, '%Y-%m-%dT%H:%i:%s.%f') FROM items WHERE id = ?",
					String.class, saved.getId())).isEqualTo("2026-09-08T11:48:38.617000");
			assertThat(readWithFreshEntityManager(saved.getId()).getFirstSeenAt()).isEqualTo(instant);
		}
		finally {
			setServerGlobalTimeZone("SYSTEM");
			dataSource.getHikariPoolMXBean().softEvictConnections();
		}
	}

	/** 전역 시간대 변경은 관리자 권한이 필요해 root로 별도 연결을 맺는다(테스트 컨테이너의 root 비밀번호는 사용자 비밀번호와 같다). */
	private static void setServerGlobalTimeZone(String zone) throws Exception {
		try (Connection root = DriverManager.getConnection(MySqlTestContainer.MYSQL.getJdbcUrl(), "root",
				MySqlTestContainer.MYSQL.getPassword()); Statement st = root.createStatement()) {
			st.execute("SET GLOBAL time_zone = '" + zone + "'");
		}
	}

	private Item readWithFreshEntityManager(Long id) {
		try (EntityManager em = emf.createEntityManager()) {
			return em.find(Item.class, id);
		}
	}

}
