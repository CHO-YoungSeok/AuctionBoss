package com.auctionboss.collect.runonce;

import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;

import com.auctionboss.collect.run.BackoffStore;
import com.auctionboss.collect.run.RunLock;
import com.auctionboss.collect.run.WorkerTicker;
import com.auctionboss.common.time.ServerClock;
import com.auctionboss.worker.RunOutcome;
import com.auctionboss.worker.WorkerRunService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.ExitCodeGenerator;

/**
 * 1회 실행 모드(design D11): 스케줄러 없이 틱 하나(단일 실행 잠금, 공유 백오프 확인, 회차 기록 포함)를 실행하고, 결과를 종료 코드로 낸다.
 * 성공 0, 그 밖(건너뜀, 차단, 실패, 시간 초과, 틱이 회차를 시작하지 못함)은 1이다. 외부 요청 허용 설정은 건드리지 않는다: 허용이 꺼져
 * 있으면 어댑터가 루프백이 아닌 주소를 거절하고 그 결과가 {@code failed}(종료 코드 1)로 나온다.
 *
 * <p>
 * 틱은 {@link WorkerTicker}를 그대로 쓰므로 스케줄러로 도는 다른 인스턴스와 같은 잠금 이름으로 서로를 막는다.
 */
public final class RunOnceRunner implements ApplicationRunner, ExitCodeGenerator {

	private static final Logger log = LoggerFactory.getLogger(RunOnceRunner.class);

	/** 1회 실행 대상: 워커 이름, 단일 실행 잠금 이름, 회차 본체(결과를 돌려준다). */
	public record Target(String worker, String lockName, Supplier<RunOutcome> round) {
	}

	private final Target target;

	private final RunLock lock;

	private final BackoffStore backoff;

	private final WorkerRunService runs;

	private final ServerClock clock;

	private final Duration timeout;

	private volatile int exitCode = 1;

	public RunOnceRunner(Target target, RunLock lock, BackoffStore backoff, WorkerRunService runs, ServerClock clock,
			Duration timeout) {
		this.target = target;
		this.lock = lock;
		this.backoff = backoff;
		this.runs = runs;
		this.clock = clock;
		this.timeout = timeout;
	}

	@Override
	public void run(ApplicationArguments args) {
		String worker = target.worker();
		AtomicReference<String> skipped = new AtomicReference<>();
		CompletableFuture<RunOutcome> outcome = new CompletableFuture<>();
		WorkerTicker ticker = new WorkerTicker(worker, target.lockName(), lock, () -> backoff.remainingMs(clock.now()),
				reason -> {
					skipped.set(reason);
					runs.recordSkipped(worker, reason);
				}, () -> {
					try {
						outcome.complete(target.round().get());
					}
					catch (Throwable t) {
						outcome.completeExceptionally(t);
					}
				});
		log.info("[run-once] {} 회차를 한 번만 실행합니다 (스케줄러 없음)", worker);
		try {
			ticker.tick();
			boolean idle = ticker.awaitIdle(timeout);
			if (skipped.get() != null) {
				log.error("[run-once] {} 회차가 건너뛰어졌습니다({}) - 종료 코드 1", worker, skipped.get());
			}
			else if (!idle) {
				log.error("[run-once] {} 회차가 {}ms 안에 끝나지 않았습니다 - 종료 코드 1", worker, timeout.toMillis());
			}
			else if (!outcome.isDone()) {
				log.error("[run-once] {} 틱이 회차를 시작하지 못했습니다(잠금 오류 등) - 종료 코드 1", worker);
			}
			else {
				RunOutcome result = outcome.getNow(null);
				exitCode = result == RunOutcome.SUCCESS ? 0 : 1;
				log.info("[run-once] {} 회차 결과 {} - 종료 코드 {}", worker, result, exitCode);
			}
		}
		catch (RuntimeException e) {
			log.error("[run-once] {} 회차가 예외로 끝났습니다 - 종료 코드 1", worker, e);
		}
		finally {
			ticker.shutdown(Duration.ofSeconds(5));
		}
	}

	@Override
	public int getExitCode() {
		return exitCode;
	}

}
