package com.auctionboss.support;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;

import org.springframework.jdbc.datasource.DriverManagerDataSource;

/** 공용 Testcontainers MySQL에 직접 붙는 데이터 소스(스프링 컨텍스트 없이 잠금·틱을 시험한다). */
public final class LockTestDataSources {

	private LockTestDataSources() {
	}

	/** 열 때마다 물리 연결을 새로 만든다(닫으면 진짜 끊긴다). 만든 연결을 기록한다. */
	public static class Recording extends DriverManagerDataSource {

		private final List<Connection> opened = new ArrayList<>();

		public Recording() {
			super(MySqlTestContainer.MYSQL.getJdbcUrl(), MySqlTestContainer.MYSQL.getUsername(),
					MySqlTestContainer.MYSQL.getPassword());
		}

		@Override
		public synchronized Connection getConnection() throws SQLException {
			Connection connection = super.getConnection();
			opened.add(connection);
			return connection;
		}

		public synchronized List<Connection> opened() {
			return List.copyOf(opened);
		}

	}

}
