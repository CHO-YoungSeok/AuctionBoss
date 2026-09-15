## Why

현재 AuctionBoss는 로컬 개발 환경(`npm run dev`, `npm run collector`, `npm run analyzer`)에서만 실행되고 있어, 실제 서버 환경에서 안정적으로 24/7 서비스를 운영하고 배포하기 위한 표준화된 컨테이너화(Docker) 및 오케스트레이션(Kubernetes) 구성이 부재하다.
이를 해결하기 위해 프로덕션 컨테이너 이미지, 로컬/개발 멀티 컨테이너 환경(`docker-compose`), 쿠버네티스 배포 매니페스트(`k8s/`), 그리고 컨테이너 생명주기 및 헬스 체크를 위한 전용 헬스 엔드포인트(`/api/health`)를 구축한다.

## What Changes

- **헬스체크 API (`GET /api/health`) 추가**: 데이터베이스(SQLite) 연결 상태, 버전, 가동 시간(uptime)을 확인하여 K8s Liveness/Readiness 프로브 및 모니터링 시스템에 제공.
- **프로덕션 멀티스테이지 Dockerfile 작성**:
  - `better-sqlite3` 네이티브 바인딩 빌드 지원
  - Next.js 웹 서버 및 워커 실행 가능한 경량 런타임 이미지
  - `.dockerignore` 정의로 불필요한 파일 제외
- **로컬/테스트 멀티 컨테이너 구성 (`docker-compose.yml`)**:
  - `web`, `collector`, `analyzer` 서비스 분리 구성
  - 영속성 볼륨(`/app/data`) 공유
  - 환경변수 템플릿(`.env.example`) 제공
- **Kubernetes 매니페스트 구성 (`k8s/`)**:
  - 네임스페이스 (`k8s/namespace.yaml`)
  - 영속 볼륨 클레임 (`k8s/pvc.yaml` - SQLite DB 파일 영속화)
  - 환경 설정 및 시크릿 (`k8s/configmap.yaml`, `k8s/secret.yaml`)
  - 웹 & 수집기 파드 배포 (`k8s/deployment.yaml` - multi-container pod 패턴으로 SQLite 단일 볼륨 공유 및 충돌 방지)
  - 서비스 (`k8s/service.yaml`) 및 인그레스 (`k8s/ingress.yaml`)
  - Kustomization 구성 (`k8s/kustomization.yaml`) 및 배포 가이드 문서

## Capabilities

### New Capabilities
- `deployment-and-health`: 컨테이너 런타임, Liveness/Readiness 헬스체크 엔드포인트(`/api/health`), Docker 및 Kubernetes 배포 명세와 설정 관리

### Modified Capabilities
<!-- 기존 기능 요구사항 변경 없음 -->

## Impact

- **신규 API 라우트**: `src/app/api/health/route.ts` 추가
- **신규 배포 설정**: `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `.env.example`, `k8s/*`
- **의존성 및 기존 코드 영향**: 기존 도메인 로직 및 어댑터 격리는 그대로 유지되며, 기존 테스트 730건에 영향을 주지 않음
