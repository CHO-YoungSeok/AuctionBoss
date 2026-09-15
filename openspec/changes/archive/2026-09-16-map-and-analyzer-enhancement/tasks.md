## 1. 외부 지도 연동 구현

- [x] 1.1 `src/app/_lib/map-links.ts` 작성: `buildKakaoMapUrl` 및 `buildNaverMapUrl` 링크 생성 함수 구현
- [x] 1.2 `src/app/_lib/__tests__/map-links.test.ts` 작성: 주소 및 좌표 기반 URL 생성 단위 테스트 검증
- [x] 1.3 `src/app/items/[id]/page.tsx`: 물건 상세 페이지에 카카오맵 및 네이버 지도 링크 버튼 추가

## 2. 분석 워커 Direct API 모드 구현

- [x] 2.1 `workers/lib/claude.ts`: `runClaudeViaApi` 함수 구현 및 `runClaude`에서 `ANTHROPIC_API_KEY` 존재 시 API 모드 지원
- [x] 2.2 `workers/__tests__/claude.test.ts`: Direct API 호출 모드 모의 단위 테스트 추가 및 검증

## 3. 수집 법원 기본 설정 확장

- [x] 3.1 `config/collector.json`: 서울 5대 법원(서울중앙, 서울동부, 서울남부, 서울서부, 서울북부) 등록

## 4. 품질 게이트 검증

- [x] 4.1 품질 게이트 4종 (`npx tsc --noEmit`, `npm test`, `npm run build`, `npm run lint`) 전체 통과 검증
