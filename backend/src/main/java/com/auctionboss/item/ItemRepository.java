package com.auctionboss.item;

import java.util.List;
import java.util.TreeSet;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

public interface ItemRepository extends JpaRepository<Item, Long> {

	@Query("select distinct i.usageType from Item i where i.usageType is not null")
	List<String> findDistinctUsageTypeValues();

	/**
	 * 용도 목록. 원본 listUsageTypes와 같은 규칙: 복합 문자열을 쉼표로 쪼개 trim하고,
	 * 빈 토큰은 버리며, 중복을 제거해 정렬한다(UTF-16 코드 단위 순, JS 기본 sort와 같다).
	 */
	default List<String> listUsageTypes() {
		TreeSet<String> tokens = new TreeSet<>();
		for (String value : findDistinctUsageTypeValues()) {
			for (String token : value.split(",")) {
				String trimmed = token.trim();
				if (!trimmed.isEmpty()) {
					tokens.add(trimmed);
				}
			}
		}
		return List.copyOf(tokens);
	}

}
