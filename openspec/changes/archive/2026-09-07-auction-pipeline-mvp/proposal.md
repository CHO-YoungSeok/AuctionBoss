# Proposal: auction-pipeline-mvp

## Why

법원경매 물건을 한곳에서 열람하고 AI 분석 결과까지 함께 확인할 수 있는 서비스(AuctionBoss)를 만들려 한다. 법원경매정보 사이트는 공식 Open API가 없으므로 수집 계층을 어댑터로 격리해 소스 교체(스크래핑 → 상용 데이터)가 가능해야 하고, Claude Code 기반 분석은 앞으로 계속 발전시킬 영역이므로 서비스 본체와 분리된 파이프라인으로 시작해야 한다. 이 change는 그 전체 구조를 세우는 1단계다.

## What Changes

- 프로젝트 스캐폴드: TypeScript + Next.js(App Router) + SQLite 모노 구조를 새로 만든다.
- 수집기(Collector): 10분 주기로 법원경매정보 사이트의 내부 JSON 엔드포인트에서 설정된 지역 1곳의 진행 중 물건을 가져와 DB에 upsert 한다. 소스 접근은 `AuctionSource` 어댑터 인터페이스 뒤로 격리한다.
- 웹 열람: 물건 목록/상세 페이지를 제공한다. 상세에서 AI 분석 결과를 함께 보여준다.
- 분석 파이프라인(Analyzer): 별도 워커 프로세스가 미분석 물건을 서버 API로 조회하고, 서버 로컬에서 Claude Code headless(`claude -p`)로 분석을 실행한 뒤 결과를 `POST /api/analyses`로 서버에 저장한다. 1단계 분석 프롬프트는 기본 수준(감정가 대비 최저가, 유찰 이력, 소재지 요약 평가)으로 하고, 프롬프트 고도화는 후속 change로 미룬다.

1단계 제외(후속): 상용 API 어댑터 구현, 회원/알림, 가격 변동 이력 UI, 분석 재실행·프롬프트 고도화, 전국 확대.

## Capabilities

### New Capabilities

- `auction-collection`: 법원경매 물건 데이터의 주기 수집 — `AuctionSource` 어댑터 계약, 수집 범위 설정, 정규화 모델, upsert 저장, 수집 실패 처리.
- `auction-viewing`: 수집된 물건의 웹 열람 — 목록(페이지네이션·기본 정렬)과 상세 페이지, 물건 조회 API.
- `auction-analysis`: Claude Code 기반 AI 분석 파이프라인 — 분석 대상 선정, headless 실행, 결과 수신 API(`POST /api/analyses`), 상세 화면에서의 분석 결과 표시.

### Modified Capabilities

(없음 — 기존 스펙이 없는 신규 프로젝트)

## Impact

- 신규 코드베이스 전체: Next.js 앱(웹 UI + API), 수집 워커, 분석 워커, SQLite 스키마.
- 외부 의존: 법원경매정보 사이트 내부 엔드포인트(비공식 — 예고 없는 변경 위험, 어댑터로 격리), 서버 로컬의 Claude Code CLI 설치 및 인증.
- 운영: 10분 주기 스케줄러 프로세스가 상주해야 함. 수집 범위는 지역 1곳으로 제한해 요청량과 분석 비용(Claude 호출 수)을 통제.
