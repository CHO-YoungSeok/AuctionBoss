package com.auctionboss.collect.run;

import java.time.Duration;
import java.util.Optional;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Consumer;
import java.util.function.LongSupplier;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * 워커 틱(design D7). 수집·사진이 함께 쓰는 일반 틱이라 워커 이름, 잠금 이름, 회차 함수를 주입받는다(이 패키지는 수집·사진 회차 본체를
 * 참조하지 않는다: 본체가 이 패키지의 설정·백오프를 참조하므로 반대 방향 참조는 패키지 순환이 된다).
 *
 * <p>
 * 틱은 스케줄러 스레드에서 짧게 끝난다.
 * <ol>
 * <li>단일 실행 잠금을 시도한다. 못 얻으면 {@code overlap} 건너뜀을 기록하고 끝낸다.</li>
 * <li>공유 백오프가 남았으면 잠금을 풀고 {@code backoff} 건너뜀을 기록한다. (순서 겹침 -> 백오프는 TS와 같다.)</li>
 * <li>아니면 회차를 이 워커 전용 단일 스레드로 넘기고 틱은 끝난다. 회차가 끝나면(성공·실패·예외) {@code finally}에서 잠금을 푼다.</li>
 * </ol>
 * 회차를 틱 스레드에서 돌리지 않는 이유: {@code scheduleAtFixedRate}는 실행이 주기보다 길면 다음 실행을 미뤘다가 끝나자마자 몰아서
 * 실행한다. 그러면 겹친 주기가 {@code overlap}으로 기록되지 않고 회차가 연달아 돌아 요청 간격이 줄어든다.
 *
 * <p>
 * 틱은 어떤 예외도 밖으로 던지지 않는다(던지면 고정 주기 실행이 멈춘다).
 */
public final class WorkerTicker {

	private static final Logger log = LoggerFactory.getLogger(WorkerTicker.class);

	private final String worker;

	private final String lockName;

	private final RunLock lock;

	private final LongSupplier backoffRemainingMs;

	private final Consumer<String> skipRecorder;

	private final Runnable round;

	private final ExecutorService roundExecutor;

	private volatile boolean closed;

	private volatile Future<?> current;

	/**
	 * @param worker 로그에 쓰는 워커 이름
	 * @param lockName 단일 실행 잠금 이름(워커마다 다르다)
	 * @param backoffRemainingMs 공유 백오프 남은 시간(ms). 0 이하면 없음. 던지면 없음으로 본다(TS와 같음)
	 * @param skipRecorder 건너뜀 기록. 인자는 사유({@code overlap}·{@code backoff})
	 * @param round 회차 본체. 전용 스레드에서 한 번에 하나만 돈다
	 */
	public WorkerTicker(String worker, String lockName, RunLock lock, LongSupplier backoffRemainingMs,
			Consumer<String> skipRecorder, Runnable round) {
		this.worker = worker;
		this.lockName = lockName;
		this.lock = lock;
		this.backoffRemainingMs = backoffRemainingMs;
		this.skipRecorder = skipRecorder;
		this.round = round;
		this.roundExecutor = Executors.newSingleThreadExecutor(runnable -> {
			Thread thread = new Thread(runnable, "auctionboss-" + worker + "-round");
			thread.setDaemon(true);
			return thread;
		});
	}

	public String worker() {
		return worker;
	}

	public void tick() {
		try {
			doTick();
		}
		catch (Throwable t) {
			log.error("[{}] 틱 처리 중 예기치 않은 오류 (다음 주기에 다시 시도합니다)", worker, t);
		}
	}

	private void doTick() {
		if (closed) {
			return;
		}
		Optional<RunLock.Held> held;
		try {
			held = lock.tryAcquire(lockName);
		}
		catch (RuntimeException e) {
			log.error("[{}] 단일 실행 잠금을 시도하지 못해 이번 주기를 건너뜁니다", worker, e);
			return;
		}
		if (held.isEmpty()) {
			log.warn("[{}] 이전 회차가 아직 실행 중이라 이번 주기를 건너뜁니다", worker);
			recordSkipped("overlap");
			return;
		}
		RunLock.Held lease = held.get();
		boolean handedOver = false;
		try {
			long remaining = remainingBackoff();
			if (remaining > 0) {
				log.warn("[{}] 소스 차단 백오프 중이라 건너뜁니다 - 남은 시간 {}ms", worker, remaining);
				lease.close();
				recordSkipped("backoff");
				return;
			}
			current = roundExecutor.submit(() -> {
				try {
					round.run();
				}
				catch (Throwable t) {
					log.error("[{}] 회차가 예외로 끝났습니다 (다음 주기에 다시 시도합니다)", worker, t);
				}
				finally {
					lease.close();
				}
			});
			handedOver = true;
		}
		catch (RejectedExecutionException e) {
			log.warn("[{}] 종료 중이라 이번 주기를 건너뜁니다", worker);
		}
		finally {
			if (!handedOver) {
				lease.close();
			}
		}
	}

	private long remainingBackoff() {
		try {
			return backoffRemainingMs.getAsLong();
		}
		catch (RuntimeException e) {
			log.error("[{}] 백오프 조회 실패 - 없음으로 보고 진행합니다", worker, e);
			return 0;
		}
	}

	private void recordSkipped(String reason) {
		try {
			skipRecorder.accept(reason);
		}
		catch (RuntimeException e) {
			log.error("[{}] 건너뜀 기록 실패 ({})", worker, reason, e);
		}
	}

	/** 진행 중인 회차가 끝나고 잠금이 풀릴 때까지 기다린다(테스트·1회 실행용). 진행 중이 없으면 곧바로 true. */
	public boolean awaitIdle(Duration timeout) {
		Future<?> running = current;
		if (running == null) {
			return true;
		}
		try {
			running.get(timeout.toMillis(), TimeUnit.MILLISECONDS);
			return true;
		}
		catch (TimeoutException e) {
			return false;
		}
		catch (ExecutionException e) {
			return true;
		}
		catch (InterruptedException e) {
			Thread.currentThread().interrupt();
			return false;
		}
	}

	/**
	 * 새 틱을 받지 않고 진행 중인 회차를 {@code wait}까지 기다린다. 넘기면 로그를 남기고 회차 스레드를 중단시킨 뒤 끝낸다(잠금은 회차
	 * 스레드의 {@code finally}가, 그마저 안 되면 연결 종료가 푼다). 제때 끝났으면 true.
	 */
	public boolean shutdown(Duration wait) {
		closed = true;
		roundExecutor.shutdown();
		try {
			if (roundExecutor.awaitTermination(wait.toMillis(), TimeUnit.MILLISECONDS)) {
				return true;
			}
		}
		catch (InterruptedException e) {
			Thread.currentThread().interrupt();
		}
		log.warn("[{}] 종료 대기 상한({}ms)을 넘겨 진행 중인 회차를 중단시킵니다", worker, wait.toMillis());
		roundExecutor.shutdownNow();
		return false;
	}

}
