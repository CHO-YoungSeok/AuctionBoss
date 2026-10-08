package com.auctionboss.collect.source;

import java.util.List;

/** {@code requestsMade}: 이번 호출에서 실제로 보낸 요청 수(세션 부트스트랩 포함). */
public record FetchItemPhotosResult(List<SourcePhoto> photos, int requestsMade) {
}
