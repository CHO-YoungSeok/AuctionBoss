package com.auctionboss.worker;

import java.util.Collection;
import java.util.Optional;

import org.springframework.data.jpa.repository.JpaRepository;

interface WorkerRunRepository extends JpaRepository<WorkerRun, Long> {

	/** 워커의 마지막 회차(시작 시각, id 내림차순). */
	Optional<WorkerRun> findFirstByWorkerOrderByStartedAtDescIdDesc(String worker);

	/** 워커의 마지막 성공 회차. */
	Optional<WorkerRun> findFirstByWorkerAndOutcomeOrderByStartedAtDescIdDesc(String worker, RunOutcome outcome);

	/** 워커의 마지막 완료 회차: 성공·실패·차단만 본다(진행 중과 건너뜀은 제외). */
	Optional<WorkerRun> findFirstByWorkerAndOutcomeInOrderByStartedAtDescIdDesc(String worker,
			Collection<RunOutcome> outcomes);

}
