package com.auctionboss.item;

import java.util.List;

import jakarta.persistence.EntityManager;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

/**
 * 시도·시군구·법원 선택지. 문자를 그대로 비교한다: 기본 정렬 규칙({@code utf8mb4_0900_ai_ci})은 대소문자와 악센트를
 * 같게 보아 {@code DISTINCT}에서 값이 합쳐지고, {@code utf8mb4_bin}은 PAD SPACE라 뒤쪽 공백만 다른 값이 합쳐진다. SQLite의
 * 바이트 비교와 같게 {@code utf8mb4_0900_bin}(NO PAD, 코드 포인트 순)으로 {@code DISTINCT}와 {@code ORDER BY}를 한다.
 */
@Repository
@Transactional(readOnly = true)
class ItemFilterOptionsRepository {

	private final EntityManager em;

	ItemFilterOptionsRepository(EntityManager em) {
		this.em = em;
	}

	List<String> courtValues() {
		return distinct("court");
	}

	List<String> sidoValues() {
		return distinct("sido");
	}

	List<String> sigunguValues() {
		return distinct("sigungu");
	}

	/** 컬럼 이름은 이 클래스 안의 상수만 받는다(사용자 입력이 아니다). */
	@SuppressWarnings("unchecked")
	private List<String> distinct(String column) {
		return em.createNativeQuery("SELECT DISTINCT " + column + " COLLATE utf8mb4_0900_bin AS v FROM items WHERE "
				+ column + " IS NOT NULL ORDER BY v").getResultList();
	}

}
