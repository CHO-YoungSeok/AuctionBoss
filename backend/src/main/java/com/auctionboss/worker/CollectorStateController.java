package com.auctionboss.worker;

import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 수집기 상태 API. 로테이션 위치({@code collector.rotation.nextCourtCode}) 하나만 읽는다. 차단 백오프 같은 다른 키는 노출하지
 * 않는다(일반 키 조회 API를 만들지 않는다).
 */
@RestController
@RequestMapping("/api/collector-state")
public class CollectorStateController {

	static final String ROTATION_KEY = "collector.rotation.nextCourtCode";

	private final CollectorStateRepository states;

	CollectorStateController(CollectorStateRepository states) {
		this.states = states;
	}

	/** 쿼리 1개. */
	@GetMapping("/rotation")
	@Transactional(readOnly = true)
	RotationResponse rotation() {
		return new RotationResponse(states.findById(ROTATION_KEY).map(CollectorState::getValue).orElse(null));
	}

}
