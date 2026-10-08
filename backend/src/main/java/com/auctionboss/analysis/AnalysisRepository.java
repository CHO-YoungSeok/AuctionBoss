package com.auctionboss.analysis;

import java.util.List;
import java.util.Optional;

import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

public interface AnalysisRepository extends JpaRepository<Analysis, Long> {

	/** 최신 분석: analyzed_at DESC, id DESC의 첫 행 (원본 getLatestAnalysis와 같다). */
	Optional<Analysis> findFirstByItem_IdOrderByAnalyzedAtDescIdDesc(Long itemId);

	/** 분석 이력: analyzed_at DESC, id DESC, 페이지 크기만큼(건수 쿼리 없음). */
	List<Analysis> findByItem_IdOrderByAnalyzedAtDescIdDesc(Long itemId, Pageable limit);

	/** 물건의 전체 분석 건수. */
	long countByItem_Id(Long itemId);

}
