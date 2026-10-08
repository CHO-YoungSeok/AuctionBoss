package com.auctionboss.worker;

import org.springframework.data.jpa.repository.JpaRepository;

interface WorkerRunRepository extends JpaRepository<WorkerRun, Long> {

}
