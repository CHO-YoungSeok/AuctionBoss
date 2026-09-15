## Context

AuctionBoss의 분석 워커는 `claude -p` headless CLI 실행 방식에 묶여 있어 배포 컨테이너 환경에서 실행하기 어렵다. 또한 물건 상세 페이지에 지번과 좌표는 있지만 지도 서비스 바로가기가 없어 사용자가 수동으로 검색해야 하는 번거로움이 있다.

## Goals / Non-Goals

**Goals:**
- `buildKakaoMapUrl` 및 `buildNaverMapUrl` 유틸리티 함수 구현 및 상세 화면 연동.
- `workers/lib/claude.ts`에 `runClaudeViaApi` 함수 추가 및 `runClaude`의 fallback/direct 모드 지원 (`ANTHROPIC_API_KEY` 환경변수 또는 CLI 부재 시).
- `config/collector.json`에 서울 5개 지방법원 기본 등록.

**Non-Goals:**
- 유료 지도 API SDK(카카오 맵 JS SDK 등)를 웹 클라이언트에 직접 임베드하는 무거운 작업 (외부 링크로 바로 연결하는 것이 가볍고 안전함).

## Decisions

### D1. 외부 지도 링크 전략
웹 브라우저에서 별도의 API 키나 클라이언트 라이브러리 없이도 바로 열 수 있도록 공식 웹 검색 URL 스키마를 사용한다:
- 카카오맵: `https://map.kakao.com/link/search/${encodeURIComponent(query)}`
- 네이버 지도: `https://map.naver.com/p/search/${encodeURIComponent(query)}`
- 주소 정제: `lotNumber`나 `dong`이 있는 경우 불필요한 괄호 등을 제거한 깔끔한 검색어 구성.

### D2. Anthropic Messages API 직접 호출
`process.env.ANTHROPIC_API_KEY`가 설정되어 있으면 `https://api.anthropic.com/v1/messages`로 JSON 요청을 전송(`model: "claude-3-5-sonnet-latest"`, `max_tokens: 4096`).
CLI가 없어도 Docker/K8s 환경에서 시크릿으로 주입된 API 키를 통해 즉시 분석을 수행할 수 있다.

## Risks / Trade-offs

- **[네트워크 타임아웃]**
  → Anthropic API 호출에 대해 기존 CLI와 동일하게 120초 타임아웃과 `AbortController`를 적용하여 행(hang) 현상을 방지한다.
