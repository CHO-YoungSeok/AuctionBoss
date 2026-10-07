package com.auctionboss.item;

import java.time.LocalDate;

import jakarta.persistence.Embeddable;

/** 매각 일정: 기일, 시각(원문 "1000" 형식 보존), 장소, 매각결정기일, 회차. */
@Embeddable
public record AuctionSchedule(LocalDate auctionDate, String auctionTime, String auctionPlace,
		LocalDate auctionDecisionDate, Integer auctionRound) {
}
