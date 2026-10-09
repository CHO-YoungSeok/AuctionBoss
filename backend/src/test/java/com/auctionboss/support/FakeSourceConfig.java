package com.auctionboss.support;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;

import com.auctionboss.collect.source.AuctionSource;
import com.auctionboss.collect.source.CollectScope;
import com.auctionboss.collect.source.FetchActiveItemsResult;
import com.auctionboss.collect.source.FetchItemPhotosResult;
import com.auctionboss.collect.source.PhotoLookupRef;
import com.auctionboss.collect.source.Sleeper;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;

/**
 * 외부 요청이 없는 가짜 {@link AuctionSource}를 운영 어댑터 빈보다 우선하는 빈으로 둔다. 테스트가 호출마다 돌려줄 결과(또는 던질 오류)를 정하고,
 * 받은 호출을 기록한다.
 */
@TestConfiguration(proxyBeanMethods = false)
public class FakeSourceConfig {

	/** 수집 호출 하나에 대한 응답을 정하는 함수. 던지면 그 예외가 소스 오류가 된다. */
	public static class FakeAuctionSource implements AuctionSource {

		private final List<CollectScope> searches = new ArrayList<>();

		private final List<PhotoLookupRef> photoCalls = new ArrayList<>();

		private volatile Function<PhotoLookupRef, FetchItemPhotosResult> photos = ref -> {
			throw new UnsupportedOperationException("사진 조회 응답이 정해지지 않았습니다");
		};

		private volatile Function<CollectScope, FetchActiveItemsResult> search = scope -> {
			throw new IllegalStateException("가짜 소스에 응답이 정해지지 않았습니다");
		};

		public void onSearch(Function<CollectScope, FetchActiveItemsResult> search) {
			this.search = search;
		}

		/** 사진 조회 한 번에 대한 응답을 정하는 함수. 던지면 그 예외가 소스 오류가 된다. */
		public void onPhotos(Function<PhotoLookupRef, FetchItemPhotosResult> photos) {
			this.photos = photos;
		}

		/** 받은 사진 조회(순서대로). */
		public synchronized List<PhotoLookupRef> photoCalls() {
			return List.copyOf(photoCalls);
		}

		/** 받은 수집 호출(순서대로). */
		public synchronized List<CollectScope> searches() {
			return List.copyOf(searches);
		}

		public synchronized void reset() {
			searches.clear();
			photoCalls.clear();
			photos = ref -> {
				throw new UnsupportedOperationException("사진 조회 응답이 정해지지 않았습니다");
			};
			search = scope -> {
				throw new IllegalStateException("가짜 소스에 응답이 정해지지 않았습니다");
			};
		}

		@Override
		public FetchActiveItemsResult fetchActiveItems(CollectScope scope) {
			synchronized (this) {
				searches.add(scope);
			}
			return search.apply(scope);
		}

		@Override
		public FetchItemPhotosResult fetchItemPhotos(PhotoLookupRef ref) {
			synchronized (this) {
				photoCalls.add(ref);
			}
			return photos.apply(ref);
		}

	}

	/** 실제로 자지 않고 요청한 대기를 기록하는 {@link Sleeper}. 운영 {@code ThreadSleeper}보다 우선한다. */
	public static class FakeSleeper implements Sleeper {

		private final List<Long> sleeps = new ArrayList<>();

		@Override
		public synchronized void sleep(long millis) {
			sleeps.add(millis);
		}

		public synchronized List<Long> sleeps() {
			return List.copyOf(sleeps);
		}

		public synchronized void reset() {
			sleeps.clear();
		}

	}

	@Bean
	@Primary
	FakeSleeper fakeSleeper() {
		return new FakeSleeper();
	}

	@Bean
	@Primary
	FakeAuctionSource fakeAuctionSource() {
		return new FakeAuctionSource();
	}

}
