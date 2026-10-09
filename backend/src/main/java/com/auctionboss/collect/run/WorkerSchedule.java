package com.auctionboss.collect.run;

/**
 * 스케줄러에 등록할 워커 하나. 워커별 설정 클래스가 빈으로 내놓고 {@link WorkerScheduler}가 모아 등록한다(수집은 5장, 사진은 6장).
 * {@code intervalMs}는 기동 시 한 번 읽은 값이다.
 */
public record WorkerSchedule(WorkerTicker ticker, long intervalMs, boolean runImmediately) {
}
