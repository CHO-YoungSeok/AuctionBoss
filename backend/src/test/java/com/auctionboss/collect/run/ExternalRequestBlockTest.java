package com.auctionboss.collect.run;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;

import com.auctionboss.collect.collector.CollectorRun;
import com.auctionboss.collect.source.CourtRef;
import com.auctionboss.support.AbstractMySqlTest;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.TestPropertySource;

/**
 * 5.5: 외부 요청 허용 없이 소스 주소를 루프백이 아닌 주소로 두고 실제 어댑터로 회차를 돌린다. 문서화용 대역(TEST-NET-3)의 숫자 주소라 이름
 * 조회도 없고, 어댑터가 소켓을 열기 전에 거절하므로 네트워크로 나가는 요청은 없다. 가짜 소스를 끼우지 않는 것이 핵심이다.
 */
@TestPropertySource(properties = { "auctionboss.source.base-url=http://203.0.113.10",
		"auctionboss.source.external-requests-allowed=false" })
class ExternalRequestBlockTest extends AbstractMySqlTest {

	@Autowired
	CollectorRun collectorRun;

	@Test
	void 허용_없이_루프백이_아닌_주소면_요청_실패로_기록되고_백오프는_걸리지_않는다() throws Exception {
		CollectorRun.Result result = collectorRun
			.run(new CollectorSettings.Scope(List.of(new CourtRef("테스트법원", "B000210")), 1, 13));

		assertThat(result.outcome().dbValue()).isEqualTo("failed");
		assertThat(result.errorKind()).isEqualTo("SourceRequestError");
		assertThat(result.errorMessage()).contains("외부 요청이 허용되지 않았습니다");
		Map<String, Object> row = jdbc.queryForMap("SELECT outcome, error_kind FROM worker_runs WHERE worker = 'collector'");
		assertThat(row).containsEntry("outcome", "failed").containsEntry("error_kind", "SourceRequestError");
		assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM collector_state WHERE `key` = 'backoff_until'", Integer.class))
			.as("차단이 아니므로 백오프가 없다")
			.isZero();
	}

}
