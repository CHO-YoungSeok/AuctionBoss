## Why

1. **상세 페이지 지도 연동 부재**: 현재 물건 상세 페이지에는 소재지와 좌표(`coordinate_x`, `coordinate_y`)가 텍스트로만 표시되며, 실제 위치나 주변 환경을 즉시 확인할 수 있는 지도 바로가기(카카오맵/네이버 지도) 수단이 없다.
2. **컨테이너/서버 환경의 분석 워커 의존성**: 현재 분석 워커(`workers/analyzer.ts`)는 로컬 `claude` CLI headless 호출에만 의존하고 있어, Docker 컨테이너나 Kubernetes 환경에서 실행하기 어렵다. 환경변수 `ANTHROPIC_API_KEY`가 주입되었을 때 직접 Anthropic API를 호출하는 다이렉트 모드가 필요하다.
3. **수집 법원 기본값 확대**: 현재 `config/collector.json`에 `서울중앙지방법원` 단 1곳만 등록되어 있어 데이터 다양성이 부족하다. 서울 5대 법원을 등록하여 순차 로테이션 수집을 가능하게 한다.

## What Changes

- **외부 지도 연동 링크 헬퍼 (`src/app/_lib/map-links.ts`) 및 UI 연동**:
  - 카카오맵 검색 링크 (`https://map.kakao.com/link/search/...`) 및 네이버 지도 링크 (`https://map.naver.com/p/search/...`) 생성.
  - 물건 상세 화면(`src/app/items/[id]/page.tsx`)에 "카카오맵에서 위치 보기", "네이버 지도에서 보기" 외부 링크 버튼 추가.
- **분석 워커 Direct API 호출 모드 (`workers/lib/claude.ts`)**:
  - `ANTHROPIC_API_KEY` 환경변수가 존재하거나 `claude` CLI 바이너리가 없는 경우, `https://api.anthropic.com/v1/messages`로 직접 HTTP 호출을 수행하여 분석 결과를 도출하는 폴백/다이렉트 실행 함수 추가.
- **수집 법원 기본 설정 확장 (`config/collector.json`)**:
  - 서울중앙지방법원 외에 서울동부지방법원, 서울남부지방법원, 서울서부지방법원, 서울북부지방법원을 기본 대상에 추가.

## Capabilities

### Modified Capabilities
- `auction-viewing`: 상세 페이지에 외부 지도(카카오맵, 네이버 지도) 바로가기 링크 제공 요구사항 추가
- `auction-analysis`: Claude CLI 외에 환경변수 기반 Anthropic API 직접 호출 모드 지원 요구사항 추가

## Impact

- `src/app/_lib/map-links.ts` (신규) 및 `src/app/items/[id]/page.tsx`
- `workers/lib/claude.ts`
- `config/collector.json`
- 기존 테스트 및 API 계약 100% 호환 유지
