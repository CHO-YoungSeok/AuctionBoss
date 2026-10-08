package com.auctionboss.health;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.auctionboss.support.AbstractMySqlTest;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.web.servlet.MockMvc;

/** 5.6: 정상 헬스체크. DB 중단은 전용 컨테이너를 쓰는 {@link HealthDatabaseDownTest}가 맡는다. */
@AutoConfigureMockMvc
class HealthApiTest extends AbstractMySqlTest {

	@Autowired
	MockMvc mvc;

	@Test
	void healthyDatabaseReturns200() throws Exception {
		String body = mvc.perform(get("/api/health")).andExpect(status().isOk())
				.andExpect(jsonPath("$.status").value("ok")).andExpect(jsonPath("$.database").value("connected"))
				.andExpect(jsonPath("$.timestamp").value(org.hamcrest.Matchers.matchesPattern(
						"\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z")))
				.andExpect(jsonPath("$.uptime").isNumber()).andReturn().getResponse().getContentAsString();
		assertThat(body).doesNotContain("\"error\"");
	}

}
