package com.auctionboss.migration;

import static org.assertj.core.api.Assertions.assertThat;

import java.sql.Connection;
import java.time.LocalDateTime;
import javax.sql.DataSource;

import com.auctionboss.support.AbstractMySqlTest;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

/**
 * 3.1: 교차 언어 골든(D4). TS가 합성 SQLite에서 계산한 {@code manifest.json}의 테이블 해시와, 같은 SQL을 MySQL에 적재해 Java가 계산한 해시가
 * 8개 테이블 모두 같아야 한다. 골든에는 빈 번호 id, 1천억 이상 금액, 밀리초 없는·{@code +09:00} 시각, 키 순서가 다른 JSON, 이모지·비 BMP·NFD·제어
 * 문자·뒤쪽 공백·백슬래시 문자열, 빈 문자열과 NULL, UTF-16 순과 UTF-8 바이트 순이 다른 {@code collector_state} 키가 들어 있다.
 */
class MigrationGoldenDigestTest extends AbstractMySqlTest {

	@Autowired
	DataSource dataSource;

	@Test
	void 골든_SQL을_적재한_테이블_해시가_매니페스트와_8개_모두_같다() throws Exception {
		MigrationManifest manifest = GoldenFixture.manifest();
		try (Connection connection = dataSource.getConnection()) {
			GoldenFixture.loadSql(connection, manifest);
			for (String table : ImportService.TABLES) {
				MigrationManifest.Table expected = manifest.tables().get(table);
				TableDigest.Result actual = TableDigest.compute(connection, table, expected.columns());
				assertThat(actual.rows()).as("%s 행 수", table).isEqualTo(expected.rows());
				assertThat(actual.sha256()).as("%s 해시", table).isEqualTo(expected.sha256());
			}
		}
	}

	@Test
	void 이전_완료_표식_행은_collector_state_해시와_행_수에서_빠진다() throws Exception {
		MigrationManifest manifest = GoldenFixture.manifest();
		try (Connection connection = dataSource.getConnection()) {
			GoldenFixture.loadSql(connection, manifest);
			MigrationMarker.write(connection, "{}", LocalDateTime.of(2026, 10, 9, 1, 2, 3));
			MigrationManifest.Table expected = manifest.tables().get("collector_state");
			TableDigest.Result actual = TableDigest.compute(connection, "collector_state", expected.columns());
			assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM collector_state", Integer.class)).isEqualTo(6);
			assertThat(actual.rows()).isEqualTo(5);
			assertThat(actual.sha256()).isEqualTo(expected.sha256());
		}
	}

}
