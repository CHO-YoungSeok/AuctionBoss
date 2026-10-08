package com.auctionboss.worker;

import org.springframework.data.jpa.repository.JpaRepository;

interface CollectorStateRepository extends JpaRepository<CollectorState, String> {

}
