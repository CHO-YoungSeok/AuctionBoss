## 1. 저장소 계층

- [ ] 1.1 `bookmarks(item_id PK, created_at)`와 `feed_reads(id PK, last_read_at)` 테이블을 스키마에 추가. `bookmarks.item_id`는 `items(id)` FK CASCADE. `feed_reads`는 행이 하나뿐인 테이블이며 고정 id에 upsert 하는 방식으로 강제할 것
- [ ] 1.2 **기존 DB 파일 마이그레이션 경로 테스트**: 변경 전 스키마로 DB를 만들고 물건·이력·분석을 넣은 뒤 새 코드로 다시 열어 오류가 없고 기존 데이터가 살아 있는 것을 확인
- [ ] 1.3 `addBookmark(itemId)`(중복 시 오류 없이 무시, 없는 물건은 `ItemNotFoundError`), `removeBookmark(itemId)`, `isBookmarked(itemId)`, `listBookmarkedItems({page, pageSize})`를 구현하고 각각 테스트
- [ ] 1.4 `listFeed({page, pageSize, sinceBookmarkedAt?})`: `item_changes`를 `bookmarks`로 조인하고 **`kind = 'change'`만** 최신순으로 반환. 기준점(`kind='baseline'`)이 포함되면 물건을 담는 순간 가짜 변동이 쏟아지므로 이걸 테스트로 고정할 것
- [ ] 1.5 `getUnreadCount()`와 `markFeedRead(at)`를 구현. 미확인 개수는 저장하지 않고 `changed_at > last_read_at`으로 매번 도출. `last_read_at`이 없으면 전체가 미확인인 것을 테스트
- [ ] 1.6 관심 해제한 물건의 변동이 피드에서 사라지는 것을 테스트

## 2. 목록 쿼리 확장

- [ ] 2.1 목록 쿼리에 관심 여부를 **스칼라 서브쿼리 컬럼**으로 추가(3회차의 `lastChangedAt`과 같은 방식). `WHERE`·`ORDER BY`·`total`에 관여하지 않아야 함
- [ ] 2.2 **회귀**: 기존 필터·정렬·페이지네이션 테스트가 전부 그대로 통과하고 `total`이 관심 여부와 무관한 것을 확인. 이 change에서 가장 회귀 위험이 큰 지점이다

## 3. API

- [ ] 3.1 `POST /api/bookmarks`(등록)와 `DELETE /api/bookmarks/[itemId]`(해제)를 구현. 없는 물건은 404, 잘못된 본문은 400. 중복 등록은 성공으로 처리
- [ ] 3.2 `GET /api/bookmarks`(관심 물건 목록, 페이지네이션)와 `GET /api/feed`(변동 피드, 페이지네이션, 미확인 개수 포함)를 구현
- [ ] 3.3 `POST /api/feed/read`(읽음 처리)를 구현. 피드 조회만으로는 읽음이 되지 않는 것을 확인
- [ ] 3.4 라우트 레벨 테스트를 작성(핸들러에 `Request`를 직접 넘기는 방식, 서버 기동 불필요). 이 프로젝트는 과거 리뷰에서 HTTP 경계 테스트 부족을 지적받은 이력이 있다

## 4. 화면

- [ ] 4.1 목록 행에 관심 토글을 추가(`<form method="post">`, 클라이언트 JS 없음). 제출 후 **현재 필터·정렬·페이지가 유지된 URL로 복귀**하는 것을 확인 — 담을 때마다 필터가 초기화되면 목록에서 쓸 수 없다
- [ ] 4.2 상세 페이지에 관심 토글을 추가하고 담긴 상태가 표시되는 것을 확인
- [ ] 4.3 `/bookmarks` 페이지(관심 물건 목록, 비었을 때 안내)를 구현
- [ ] 4.4 `/feed` 페이지: 변동을 최신순으로, 각 항목에 물건·필드·이전값→새값·시각·링크. 미확인 항목을 구별하고 미확인 개수와 읽음 처리 버튼을 제공. 변동이 없을 때 안내
- [ ] 4.5 목록·상세·상태 페이지에서 `/bookmarks`와 `/feed`로 가는 링크와 미확인 개수를 노출 — 접근 경로가 없으면 만들어도 아무도 보지 않는다
- [ ] 4.6 표시 판정(미확인 여부, 변동 요약 문구)을 순수 함수로 추출해 테스트

## 5. 검증

- [ ] 5.1 `npx tsc --noEmit`, `npm test`, `npm run build`, `npm run lint` 전부 통과. 테스트 개수가 줄지 않을 것
- [ ] 5.2 실서버 E2E: 스크래치 DB에 물건을 넣고 → 관심 등록 → 최저가를 낮춰 재수집(실제 변경 발생) → 피드에 뜨는지 → 읽음 처리 후 미확인 0 → 관심 해제 후 피드에서 사라지는지. 각 단계의 실제 출력을 제시
- [ ] 5.3 README에 관심 물건·변동 피드 사용법, 단일 사용자 전제, **인증 없는 쓰기 엔드포인트 목록**(3회차의 회차 기록 API와 함께 한곳에 모아서)을 추가
