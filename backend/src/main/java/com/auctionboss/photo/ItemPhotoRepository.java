package com.auctionboss.photo;

import java.util.List;
import java.util.Optional;

import org.springframework.data.jpa.repository.JpaRepository;

public interface ItemPhotoRepository extends JpaRepository<ItemPhoto, Long> {

	Optional<ItemPhoto> findByItem_IdAndSeq(Long itemId, Integer seq);

	/** 사진 목록(순번 오름차순). */
	List<ItemPhoto> findByItem_IdOrderBySeqAsc(Long itemId);

}
