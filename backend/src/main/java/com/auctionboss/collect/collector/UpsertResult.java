package com.auctionboss.collect.collector;

/**
 * 저장 결과 (TS {@code UpsertItemsResult}). {@code inserted}·{@code updated}는 입력 행 수 기준이고, {@code changed}는 감시 필드가
 * 실제로 바뀐 물건 수다(배치 시작 전 값과 배치 최종값을 비교, 신규는 세지 않음).
 */
public record UpsertResult(int inserted, int updated, int changed) {
}
