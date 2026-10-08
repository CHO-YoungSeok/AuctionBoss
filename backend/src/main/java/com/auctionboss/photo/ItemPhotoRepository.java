package com.auctionboss.photo;

import java.util.Optional;

import org.springframework.data.jpa.repository.JpaRepository;

public interface ItemPhotoRepository extends JpaRepository<ItemPhoto, Long> {

	Optional<ItemPhoto> findByItem_IdAndSeq(Long itemId, Integer seq);

}
