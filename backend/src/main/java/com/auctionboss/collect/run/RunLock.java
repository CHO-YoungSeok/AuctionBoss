package com.auctionboss.collect.run;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.sql.DataSource;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * 회차 단일 실행 잠금(design D7): MySQL 이름 잠금({@code GET_LOCK(name, 0)}). 잠금은 얻은 연결에 묶여 있어서 프로세스가 죽거나 연결이
 * 끊기면 MySQL이 즉시 푼다(사람의 개입 없이 풀림). 기다리지 않고(timeout 0) 곧바로 결과를 돌려주므로 "못 얻으면 건너뜀 기록"이 그대로
 * 표현된다. 같은 데이터베이스를 쓰는 인스턴스가 여럿이어도 한 이름의 잠금은 하나만 얻는다.
 *
 * <p>
 * 잠금을 쥐는 동안 연결 풀의 연결 하나를 쓴다(수집·사진이 동시에 돌면 둘). 이름은 서버 전체에서 하나의 이름 공간이라 데이터베이스가 달라도
 * 같은 MySQL 서버라면 같은 이름은 서로 막는다(이름은 {@code auctionboss.<worker>}).
 */
@Component
public class RunLock {

	private static final Logger log = LoggerFactory.getLogger(RunLock.class);

	private final DataSource dataSource;

	public RunLock(DataSource dataSource) {
		this.dataSource = dataSource;
	}

	/** 잠금을 얻으면 그 잠금(닫을 때 푼다)을, 이미 다른 연결이 쥐고 있으면 빈 값을 돌려준다. 연결·질의 오류는 예외다. */
	public Optional<Held> tryAcquire(String name) {
		Connection connection;
		try {
			connection = dataSource.getConnection();
		}
		catch (SQLException e) {
			throw new IllegalStateException("잠금용 연결을 얻지 못했습니다: " + name, e);
		}
		boolean acquired = false;
		try (PreparedStatement statement = connection.prepareStatement("SELECT GET_LOCK(?, 0)")) {
			statement.setString(1, name);
			try (ResultSet rs = statement.executeQuery()) {
				acquired = rs.next() && rs.getInt(1) == 1 && !rs.wasNull();
			}
		}
		catch (SQLException e) {
			discard(connection);
			throw new IllegalStateException("잠금을 시도하지 못했습니다: " + name, e);
		}
		if (!acquired) {
			giveBack(connection);
			return Optional.empty();
		}
		return Optional.of(new Held(name, connection));
	}

	private static void giveBack(Connection connection) {
		try {
			connection.close();
		}
		catch (SQLException e) {
			log.warn("[lock] 연결 반환 실패", e);
		}
	}

	/** 잠금이 남아 있을 수 있는 연결은 풀로 돌려보내지 않고 버린다(남은 잠금이 다음 사용자에게 새지 않게). */
	private static void discard(Connection connection) {
		try {
			connection.abort(Runnable::run);
		}
		catch (SQLException | RuntimeException e) {
			log.warn("[lock] 연결 폐기 실패", e);
		}
		giveBack(connection);
	}

	/** 얻은 잠금. {@link #close()}가 잠금을 풀고 연결을 돌려준다(여러 번 불러도 안전). */
	public static final class Held implements AutoCloseable {

		private final String name;

		private final Connection connection;

		private final AtomicBoolean closed = new AtomicBoolean();

		private Held(String name, Connection connection) {
			this.name = name;
			this.connection = connection;
		}

		public String name() {
			return name;
		}

		@Override
		public void close() {
			if (!closed.compareAndSet(false, true)) {
				return;
			}
			boolean released = false;
			try (PreparedStatement statement = connection.prepareStatement("SELECT RELEASE_LOCK(?)")) {
				statement.setString(1, name);
				try (ResultSet rs = statement.executeQuery()) {
					released = rs.next() && rs.getInt(1) == 1;
				}
			}
			catch (SQLException e) {
				log.warn("[lock] 잠금 해제 실패: {}", name, e);
			}
			if (released) {
				giveBack(connection);
			}
			else {
				// 해제를 확인하지 못했다: 연결을 끊어 MySQL이 잠금을 풀게 한다.
				discard(connection);
			}
		}

	}

}
