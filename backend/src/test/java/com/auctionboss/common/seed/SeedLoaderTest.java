package com.auctionboss.common.seed;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.util.List;
import java.util.regex.Pattern;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

class SeedLoaderTest extends AbstractSeedTest {

	@Autowired
	private SeedLoader loader;

	/** 기동 시 적재 여부와 무관하게, 비운 상태에서 시작한다. */
	@BeforeEach
	void empty() {
		clearAll();
	}

	@Test
	void 빈_DB에서는_적재하고_행_수가_원본과_같다() throws IOException {
		assertThat(loader.load()).isTrue();
		assertThat(count("items")).isEqualTo(809);
		assertThat(count("item_changes")).isEqualTo(4008);
		assertThat(count("analyses")).isEqualTo(12);
		assertThat(jdbc.queryForObject("SELECT case_no FROM items WHERE id = 53", String.class))
				.isEqualTo("2025타경1833");
	}

	@Test
	void 다시_호출해도_중복_적재되지_않는다() throws IOException {
		assertThat(loader.load()).isTrue();
		assertThat(loader.load()).isFalse();
		assertThat(count("items")).isEqualTo(809);
		assertThat(count("item_changes")).isEqualTo(4008);
		assertThat(count("analyses")).isEqualTo(12);
	}

	@Test
	void 이미_데이터가_있으면_건드리지_않는다() throws IOException {
		jdbc.update("INSERT INTO items (court, case_no, item_no, first_seen_at, last_seen_at) "
				+ "VALUES ('c', 'n', '1', NOW(3), NOW(3))");
		assertThat(loader.load()).isFalse();
		assertThat(count("items")).isEqualTo(1);
		assertThat(count("item_changes")).isZero();
	}

	@Test
	void 적재_후_새_행의_AUTO_INCREMENT는_시드_최대_id를_넘는다() throws IOException {
		loader.load();
		long max = jdbc.queryForObject("SELECT MAX(id) FROM items", Long.class);
		jdbc.update("INSERT INTO items (court, case_no, item_no, first_seen_at, last_seen_at) "
				+ "VALUES ('c', 'n', '1', NOW(3), NOW(3))");
		long created = jdbc.queryForObject("SELECT id FROM items WHERE court = 'c'", Long.class);
		assertThat(created).isGreaterThan(max);
	}

	@Test
	void 개인_이름은_가려지고_기관명은_남는다() throws IOException {
		loader.load();
		Pattern tenant = Pattern.compile("임차인 [가-힣]{2,4}[은는이가](?![가-힣])");
		Pattern possessive = Pattern.compile("(?<![가-힣])(?!임차인의|소유자의|채무자의|채권자의)[가-힣]{2,4}의 임차보증금");
		List<String> texts = jdbc.queryForList("SELECT note FROM items WHERE note IS NOT NULL", String.class);
		texts.addAll(jdbc.queryForList("SELECT body FROM analyses", String.class));
		for (String text : texts) {
			assertThat(tenant.matcher(text).find()).as(text).isFalse();
			assertThat(possessive.matcher(text).find()).as(text).isFalse();
		}
		assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM items WHERE note LIKE '%○○○%'", Long.class))
				.isPositive();
		assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM items WHERE note LIKE '%주택도시보증공사%'", Long.class))
				.isPositive();
	}

}
