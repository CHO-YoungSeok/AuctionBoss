package com.auctionboss.item;

import jakarta.persistence.Embeddable;

/** 담당계 이름과 연락처. */
@Embeddable
public record CourtContact(String courtDepartment, String courtPhone) {
}
