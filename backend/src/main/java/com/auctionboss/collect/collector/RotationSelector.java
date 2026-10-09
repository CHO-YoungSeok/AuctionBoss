package com.auctionboss.collect.collector;

import java.util.ArrayList;
import java.util.List;

import com.auctionboss.collect.source.CourtRef;

/**
 * 법원 로테이션 순수 함수 (TS {@code selectRotationCourts}, {@code computeLapDurationMs}). DB·워커 상태를 모른다: "법원 목록 + 저장된
 * 위치 + 회차당 상한"으로 "이번 회차 대상 + 이번 선택이 전부 끝났을 때의 다음 시작 위치"를 계산한다.
 */
public final class RotationSelector {

	/** {@code nextStartCourtCode}는 배치 전체가 문제없이 끝났을 때의 값이다. 도중에 멈추면 호출자가 멈춘 법원으로 덮어쓴다. */
	public record Selection(List<CourtRef> selectedCourts, String nextStartCourtCode) {
	}

	private RotationSelector() {
	}

	/**
	 * 원형 선택. {@code startCourtCode}가 null이거나 목록에 없으면 처음부터 시작한다(코드로 위치를 저장하므로 법원이 추가·삭제·재정렬돼도
	 * 복구된다). 상한은 1 이상 목록 길이 이하로 자른다(같은 법원을 중복으로 고르지 않는다). 0은 TS {@code Math.trunc(limit) || 1}처럼 1이다.
	 */
	public static Selection select(List<CourtRef> courts, String startCourtCode, long limit) {
		if (courts.isEmpty()) {
			throw new IllegalArgumentException("법원 목록이 비어 있으면 로테이션을 계산할 수 없습니다");
		}
		int size = courts.size();
		int bounded = (int) Math.max(1, Math.min(limit == 0 ? 1 : limit, size));
		int startIndex = 0;
		if (startCourtCode != null) {
			for (int i = 0; i < size; i++) {
				if (courts.get(i).courtCode().equals(startCourtCode)) {
					startIndex = i;
					break;
				}
			}
		}
		List<CourtRef> selected = new ArrayList<>();
		for (int i = 0; i < bounded; i++) {
			selected.add(courts.get((startIndex + i) % size));
		}
		return new Selection(selected, courts.get((startIndex + bounded) % size).courtCode());
	}

	/** 전체 법원을 한 번씩 수집하는 데 걸리는 예상 시간: {@code ceil(법원 수 / 회차당 법원 수) × 주기}. 법원이 0곳이면 0. */
	public static long lapDurationMs(int courtCount, long maxCourtsPerRun, long intervalMs) {
		if (courtCount <= 0) {
			return 0;
		}
		long perRun = Math.max(1, maxCourtsPerRun);
		return Math.ceilDiv(courtCount, perRun) * intervalMs;
	}

}
