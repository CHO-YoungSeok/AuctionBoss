package com.auctionboss.collect.collector;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

import com.auctionboss.collect.source.CourtRef;
import org.junit.jupiter.api.Test;

/** 4.2: TS {@code rotation.test.ts}의 사례. */
class RotationSelectorTest {

	private static final CourtRef A = new CourtRef("서울중앙지방법원", "B000210");

	private static final CourtRef B = new CourtRef("서울동부지방법원", "B000211");

	private static final CourtRef C = new CourtRef("서울서부지방법원", "B000215");

	private static final List<CourtRef> COURTS3 = List.of(A, B, C);

	private static List<String> codes(RotationSelector.Selection s) {
		return s.selectedCourts().stream().map(CourtRef::courtCode).toList();
	}

	@Test
	void 법원_3곳_상한_1곳이면_회차마다_하나씩_세_회차에_전부_순환한다() {
		String start = null;
		java.util.ArrayList<String> visited = new java.util.ArrayList<>();
		for (int i = 0; i < 3; i++) {
			RotationSelector.Selection s = RotationSelector.select(COURTS3, start, 1);
			assertThat(s.selectedCourts()).hasSize(1);
			visited.add(codes(s).get(0));
			start = s.nextStartCourtCode();
		}
		assertThat(visited).containsExactly("B000210", "B000211", "B000215");
		assertThat(codes(RotationSelector.select(COURTS3, start, 1))).containsExactly("B000210");
	}

	@Test
	void 여섯_회차를_돌리면_각_법원이_정확히_두_번씩이다() {
		String start = null;
		Map<String, Integer> counts = new HashMap<>();
		for (int i = 0; i < 6; i++) {
			RotationSelector.Selection s = RotationSelector.select(COURTS3, start, 1);
			counts.merge(codes(s).get(0), 1, Integer::sum);
			start = s.nextStartCourtCode();
		}
		assertThat(counts).containsEntry("B000210", 2).containsEntry("B000211", 2).containsEntry("B000215", 2);
	}

	@Test
	void 법원_1곳_상한_1곳이면_매_회차_같은_법원을_가리킨다() {
		String start = null;
		for (int i = 0; i < 5; i++) {
			RotationSelector.Selection s = RotationSelector.select(List.of(A), start, 1);
			assertThat(codes(s)).containsExactly("B000210");
			assertThat(s.nextStartCourtCode()).isEqualTo("B000210");
			start = s.nextStartCourtCode();
		}
	}

	@Test
	void 저장된_코드가_목록에_없으면_처음부터_다시_시작한다() {
		assertThat(codes(RotationSelector.select(COURTS3, "B999999", 1))).containsExactly("B000210");
	}

	@Test
	void 저장된_코드가_목록_중간을_가리키면_그_위치부터_이어서_순환한다() {
		RotationSelector.Selection s = RotationSelector.select(COURTS3, "B000211", 1);
		assertThat(codes(s)).containsExactly("B000211");
		assertThat(s.nextStartCourtCode()).isEqualTo("B000215");
	}

	@Test
	void 법원이_재정렬돼도_저장된_코드로_위치를_다시_찾는다() {
		RotationSelector.Selection s = RotationSelector.select(List.of(C, A, B), "B000210", 1);
		assertThat(codes(s)).containsExactly("B000210");
		assertThat(s.nextStartCourtCode()).isEqualTo("B000211");
	}

	@Test
	void 법원이_추가된_뒤에도_저장된_코드를_찾아_이어서_순환한다() {
		List<CourtRef> expanded = List.of(A, B, C, new CourtRef("의정부지방법원", "B000214"));
		RotationSelector.Selection s = RotationSelector.select(expanded, "B000215", 1);
		assertThat(codes(s)).containsExactly("B000215");
		assertThat(s.nextStartCourtCode()).isEqualTo("B000214");
	}

	@Test
	void 상한이_법원_수보다_크면_전부를_한_번씩만_고르고_처음으로_되돌아간다() {
		RotationSelector.Selection s = RotationSelector.select(COURTS3, null, 10);
		assertThat(codes(s)).containsExactly("B000210", "B000211", "B000215");
		assertThat(s.nextStartCourtCode()).isEqualTo("B000210");
	}

	@Test
	void 상한이_2곳이면_한_회차에_2곳을_고르고_원형으로_겹쳐_넘어간다() {
		RotationSelector.Selection first = RotationSelector.select(COURTS3, null, 2);
		assertThat(codes(first)).containsExactly("B000210", "B000211");
		assertThat(first.nextStartCourtCode()).isEqualTo("B000215");

		RotationSelector.Selection second = RotationSelector.select(COURTS3, first.nextStartCourtCode(), 2);
		assertThat(codes(second)).containsExactly("B000215", "B000210");
		assertThat(second.nextStartCourtCode()).isEqualTo("B000211");
	}

	@Test
	void 상한이_0이나_음수여도_최소_1곳이다() {
		assertThat(codes(RotationSelector.select(COURTS3, null, 0))).hasSize(1);
		assertThat(codes(RotationSelector.select(COURTS3, null, -3))).hasSize(1);
	}

	@Test
	void 법원_목록이_비어_있으면_던진다() {
		assertThatThrownBy(() -> RotationSelector.select(List.of(), null, 1))
			.isInstanceOf(IllegalArgumentException.class);
	}

	@Test
	void 한_바퀴_시간은_올림한_회차_수_곱하기_주기이다() {
		assertThat(RotationSelector.lapDurationMs(1, 1, 600_000)).isEqualTo(600_000);
		assertThat(RotationSelector.lapDurationMs(3, 1, 600_000)).isEqualTo(1_800_000);
		assertThat(RotationSelector.lapDurationMs(5, 2, 600_000)).isEqualTo(1_800_000);
		assertThat(RotationSelector.lapDurationMs(2, 5, 600_000)).isEqualTo(600_000);
		assertThat(RotationSelector.lapDurationMs(0, 1, 600_000)).isZero();
	}

}
