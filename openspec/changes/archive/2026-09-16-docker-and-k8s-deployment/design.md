## Context

AuctionBoss는 Next.js (App Router), SQLite (`better-sqlite3`), zod 및 TypeScript 기반의 법원 경매 정보 수집·열람·분석 서비스이다.
상주 프로세스로 구동되는 `collector` 워커와 분석을 담당하는 `analyzer` 워커가 존재하며, 데이터베이스는 파일 기반의 `auctionboss.db`를 WAL 모드로 사용한다.
프로덕션 서버 및 쿠버네티스 환경으로 올리기 위해 컨테이너 이미지화 및 스토리지/배포 아키텍처 설계가 필요하다.

## Goals / Non-Goals

**Goals:**
- Next.js 웹 서버 및 워커 프로세스를 단일/공통 Docker 이미지로 빌드 가능하도록 멀티스테이지 Dockerfile 구성 (`better-sqlite3` 네이티브 C++ 바인딩 컴파일 보장).
- 쿠버네티스 Liveness/Readiness 프로브를 위한 경량 `/api/health` 엔드포인트 구현 (SQLite `SELECT 1` 검증).
- 로컬 개발 및 통합 검증을 위한 `docker-compose.yml` 및 `.env.example` 작성.
- 프로덕션 쿠버네티스 매니페스트 (`k8s/`) 완성 (Namespace, PVC, ConfigMap, Secret, Deployment, Service, Ingress, Kustomize).

**Non-Goals:**
- SQLite를 PostgreSQL이나 MySQL 등 외부 RDBMS로 교체하는 작업 (프로젝트 기본 설계인 SQLite 유지).
- 다중 노드 동시 쓰기 분산 파일시스템(NFS/EFS) 구축 (단일 Pod 내 Multi-container 또는 단일 Replica RWO PVC 사용으로 충분).

## Decisions

### D1. 멀티스테이지 Dockerfile & Native 빌드 환경
`better-sqlite3`는 Node.js C++ 네이티브 애드온이므로 Alpine/Debian 환경에서 `python3`, `make`, `g++` 등의 빌드 도구가 필요하다.
- **결정**: `node:20-slim` 기반 멀티스테이지 빌드를 사용한다.
  - `deps` 단계: 빌드 도구 설치 후 `npm ci` 수행
  - `builder` 단계: Next.js 빌드 (`npm run build`)
  - `runner` 단계: 최소 런타임 환경(`node:20-slim`)에 불필요한 개발 의존성을 제거하고 프로덕션 실행 바이너리 및 정적 자산만 복사
- **대안 검토**: Alpine Linux는 musl libc 이슈로 인해 일부 네이티브 빌드 시 예기치 않은 오류가 발생할 수 있어, 호환성이 검증된 Debian slim(`node:20-slim`)을 채택.

### D2. Kubernetes 내 SQLite 영속화와 Multi-Container Pod 패턴
SQLite는 단일 호스트 파일 잠금 기반으로 동작하므로 서로 다른 노드의 여러 파드가 동시에 같은 DB 파일에 쓰기를 시도하면 DB 손상 위험이 있다.
- **결정**: K8s Deployment에서 `replicas: 1`과 `ReadWriteOnce` (RWO) PVC를 사용한다.
- **Web & Collector 배치**: Web 컨테이너와 Collector 컨테이너를 **동일한 Pod 내의 Multi-container**로 배치하여 `/app/data` PVC를 로컬 볼륨으로 안전하게 공유한다. Collector는 DB에 직접 쓰고, Web도 DB를 직접 조회한다.
- **Analyzer 워커 배치**: Analyzer 워커는 설계 원칙상 DB를 직접 읽지 않고 오직 HTTP API로만 통신하므로, Pod 내부 또는 별도 파드로 분리되어 `http://auctionboss-service:3000` API를 호출한다.

### D3. 전용 헬스체크 API (`GET /api/health`)
기존 `/status`는 HTML을 반환하는 사용자 화면 라우트이므로, K8s kubelet 및 로드밸런서가 가볍고 확실하게 헬스 상태를 감지할 수 있는 기계 가독형 JSON 엔드포인트가 필요하다.
- **결정**: `src/app/api/health/route.ts`에 `GET` 핸들러를 추가하고, SQLite `SELECT 1` 실행 성공 여부에 따라 200 또는 503을 반환한다.

### D4. Docker Compose 서비스 오케스트레이션
로컬이나 단일 VM에서 `docker-compose up`만으로 전체 서비스 스택을 가동할 수 있도록 `web`, `collector`, `analyzer` 3개 서비스를 정의하고 명명된 볼륨(`auctionboss-data`)으로 `/app/data`를 공유한다.

## Risks / Trade-offs

- **[SQLite 단일 복제본(Replicas: 1) 가용성 제한]**
  → 수집/분석 성격상 트래픽이 집중되는 대규모 읽기 확장이 필요한 시점 전까지는 단일 파드로도 수백 RPS 처리가 충분하며, 무중단 배포 시 `Recreate` 전략 또는 빠른 롤링 업데이트로 다운타임을 수 초 내로 최소화한다.
- **[K8s 컨테이너 재시작 시 DB 락 잔존]**
  → SQLite WAL 모드는 비정상 종료 시에도 자동 복구(crash recovery)를 지원하므로 컨테이너 재기동 시 데이터 무결성을 보장한다.

## Migration Plan

1. `/api/health` 라우트 구현 및 단위 테스트 통과
2. Dockerfile 및 .dockerignore 작성
3. docker-compose.yml 및 .env.example 작성
4. `k8s/` 매니페스트 디렉터리 구축
5. 전체 품질 게이트 통과 검증 후 머지
