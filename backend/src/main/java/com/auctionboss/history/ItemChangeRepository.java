package com.auctionboss.history;

import java.util.List;

import org.springframework.data.jpa.repository.JpaRepository;

public interface ItemChangeRepository extends JpaRepository<ItemChange, Long> {

	/** 변경 이력: changed_at ASC, id ASC (원본 listItemChanges와 같다). */
	List<ItemChange> findByItem_IdOrderByChangedAtAscIdAsc(Long itemId);

}
