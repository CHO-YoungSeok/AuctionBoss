package com.auctionboss.analysis;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * 분석 결과 저장 API. 원본 {@code POST /api/analyses}와 같은 계약이다. 본문은 원시 바이트로 받아 직접 검증한다(Content-Type과
 * 무관하게 JSON으로 해석하고, 타입 강제 변환 없이 zod와 같은 규칙으로 검사하려는 것이다).
 */
@RestController
public class AnalysisController {

	private final AnalysisCommandService service;

	public AnalysisController(AnalysisCommandService service) {
		this.service = service;
	}

	@PostMapping("/api/analyses")
	ResponseEntity<AnalysisResponse> create(@RequestBody(required = false) byte[] body) {
		AnalysisResponse saved = service.create(AnalysisBodyParser.parse(body));
		return ResponseEntity.status(HttpStatus.CREATED).body(saved);
	}

}
