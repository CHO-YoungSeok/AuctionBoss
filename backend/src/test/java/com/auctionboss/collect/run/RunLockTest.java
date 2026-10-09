package com.auctionboss.collect.run;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Duration;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;

import com.auctionboss.support.Eventually;
import com.auctionboss.support.LockTestDataSources;
import org.junit.jupiter.api.Test;

/** 5.1: 단일 실행 잠금({@code GET_LOCK}). 컨텍스트 없이 공용 MySQL 컨테이너에 직접 붙는다. */
class RunLockTest {

	private static String name() {
		return "auctionboss.test." + UUID.randomUUID().toString().substring(0, 8);
	}

	@Test
	void 두_연결_중_하나만_잠금을_얻는다() {
		RunLock lock = new RunLock(new LockTestDataSources.Recording());
		String name = name();

		Optional<RunLock.Held> first = lock.tryAcquire(name);
		Optional<RunLock.Held> second = lock.tryAcquire(name);

		assertThat(first).isPresent();
		assertThat(second).isEmpty();
		first.get().close();
	}

	@Test
	void 해제한_뒤에는_다시_얻는다() {
		RunLock lock = new RunLock(new LockTestDataSources.Recording());
		String name = name();

		lock.tryAcquire(name).orElseThrow().close();
		Optional<RunLock.Held> again = lock.tryAcquire(name);

		assertThat(again).isPresent();
		again.get().close();
	}

	@Test
	void 이름이_다르면_서로_막지_않는다() {
		RunLock lock = new RunLock(new LockTestDataSources.Recording());

		RunLock.Held collector = lock.tryAcquire(name()).orElseThrow();
		Optional<RunLock.Held> photos = lock.tryAcquire(name());

		assertThat(photos).isPresent();
		collector.close();
		photos.get().close();
	}

	@Test
	void 해제는_여러_번_불러도_안전하고_남의_잠금을_풀지_않는다() {
		RunLock lock = new RunLock(new LockTestDataSources.Recording());
		String name = name();

		RunLock.Held held = lock.tryAcquire(name).orElseThrow();
		held.close();
		RunLock.Held next = lock.tryAcquire(name).orElseThrow();
		held.close(); // 이미 닫은 잠금을 다시 닫아도 다음 쥔 쪽의 잠금은 그대로다

		assertThat(lock.tryAcquire(name)).isEmpty();
		next.close();
	}

	@Test
	void 잠금을_쥔_연결을_강제로_닫으면_다른_연결이_얻는다() throws Exception {
		LockTestDataSources.Recording dataSource = new LockTestDataSources.Recording();
		RunLock lock = new RunLock(dataSource);
		String name = name();

		RunLock.Held held = lock.tryAcquire(name).orElseThrow();
		assertThat(lock.tryAcquire(name)).isEmpty();
		// 프로세스가 죽은 것과 같다: 잠금을 쥔 물리 연결이 끊긴다(RELEASE_LOCK 없이).
		dataSource.opened().get(0).close();

		AtomicReference<Optional<RunLock.Held>> acquired = new AtomicReference<>(Optional.empty());
		boolean freed = Eventually.until(Duration.ofSeconds(10), () -> {
			acquired.set(lock.tryAcquire(name));
			return acquired.get().isPresent();
		});
		assertThat(freed).as("끊긴 연결의 잠금은 MySQL이 풀어 준다").isTrue();
		assertThatCode(held::close).as("이미 끊긴 잠금을 닫아도 예외가 없다").doesNotThrowAnyException();
		acquired.get().orElseThrow().close();
	}

	/**
	 * 해제를 확인하지 못하면 연결을 풀로 돌려보내지 않고 폐기해야 한다(남은 잠금이 풀의 다음 사용자에게 새지 않게). 풀이 연결을 되돌려받는
	 * 것처럼 {@code close()}가 물리 연결을 끊지 않는 데이터 소스에서, RELEASE_LOCK이 실패한 뒤 잠금이 남지 않는지 본다.
	 */
	@Test
	void 해제_실패한_연결은_폐기해서_잠금이_풀의_다음_사용자에게_새지_않는다() throws Exception {
		LockTestDataSources.Recording real = new LockTestDataSources.Recording();
		javax.sql.DataSource pooledLike = new org.springframework.jdbc.datasource.AbstractDataSource() {
			@Override
			public Connection getConnection() throws SQLException {
				Connection physical = real.getConnection();
				return (Connection) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[] { Connection.class },
						(proxy, method, args) -> {
							if (method.getName().equals("close")) {
								return null; // 풀 반환: 물리 연결은 살아 있다
							}
							if (method.getName().equals("prepareStatement") && String.valueOf(args[0]).contains("RELEASE_LOCK")) {
								throw new SQLException("해제 실패(시험)");
							}
							try {
								return method.invoke(physical, args);
							}
							catch (InvocationTargetException e) {
								throw e.getCause();
							}
						});
			}

			@Override
			public Connection getConnection(String username, String password) throws SQLException {
				return getConnection();
			}
		};
		String name = name();
		RunLock.Held held = new RunLock(pooledLike).tryAcquire(name).orElseThrow();
		held.close();

		RunLock other = new RunLock(new LockTestDataSources.Recording());
		Optional<RunLock.Held> next = other.tryAcquire(name);
		assertThat(next).as("해제를 못 한 연결을 폐기했으므로 잠금이 남지 않는다").isPresent();
		next.get().close();
	}

}
