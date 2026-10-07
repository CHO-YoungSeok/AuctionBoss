package com.auctionboss.item;

import jakarta.persistence.Column;
import jakarta.persistence.Embeddable;

/** 소재지. 조합 문자열(address)과 구조화 값, 좌표(문자열 원문, 좌표계 미확인)를 묶는다. */
@Embeddable
public record Location(String address, String sido, String sigungu, String dong, String lotNumber,
		String buildingName, String buildingUnit, @Column(name = "coordinate_x") String coordinateX, @Column(name = "coordinate_y") String coordinateY, String coordinateLevel) {
}
