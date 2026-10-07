package com.auctionboss.analysis;

import java.util.Optional;

import org.springframework.data.jpa.repository.JpaRepository;

public interface AnalysisRepository extends JpaRepository<Analysis, Long> {

	/** 최신 분석: analyzed_at DESC, id DESC의 첫 행 (원본 getLatestAnalysis와 같다). */
	Optional<Analysis> findFirstByItem_IdOrderByAnalyzedAtDescIdDesc(Long itemId);

}
