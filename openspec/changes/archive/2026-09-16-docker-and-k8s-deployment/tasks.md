## 1. 헬스체크 엔드포인트 구현

- [x] 1.1 `src/app/api/health/route.ts` 구현: DB 연결(SELECT 1) 및 상태(status, uptime, timestamp) 반환 핸들러 작성
- [x] 1.2 `src/app/api/health/__tests__/route.test.ts` 작성: 정상 상태(200) 및 DB 오류(503) 시나리오 단위 테스트 검증 (`npm test`)

## 2. Docker 컨테이너화 구성

- [x] 2.1 `.dockerignore` 작성: node_modules, .next, .git, data, *.local 등 제외 설정
- [x] 2.2 멀티스테이지 `Dockerfile` 작성: `node:20-slim`, python3/make/g++ 빌드 도구, better-sqlite3 컴파일, Next.js 웹 서버 및 워커 런타임 지원
- [x] 2.3 `docker-compose.yml` 및 `.env.example` 작성: web(3000), collector, analyzer 서비스 오케스트레이션 및 `/app/data` 볼륨 마운트 정의

## 3. Kubernetes 배포 매니페스트 구성

- [x] 3.1 `k8s/namespace.yaml` 및 `k8s/pvc.yaml` 작성: `auctionboss` 네임스페이스 및 SQLite 데이터 영속화를 위한 ReadWriteOnce PVC(10Gi) 정의
- [x] 3.2 `k8s/configmap.yaml` 및 `k8s/secret.yaml` 작성: 애플리케이션 환경변수 및 보안 시크릿 템플릿 정의
- [x] 3.3 `k8s/deployment.yaml` 작성: Multi-container Pod(web + collector 컨테이너가 단일 PVC 공유), `/api/health` 기반 livenessProbe/readinessProbe, 리소스 요청/제한 정의
- [x] 3.4 `k8s/service.yaml` 및 `k8s/ingress.yaml` 작성: 클러스터 내부 Service(3000) 및 외부 노출을 위한 Ingress 라우팅 정의
- [x] 3.5 `k8s/kustomization.yaml` 및 `deploy/k8s/README.md` 작성: Kustomize 배포 정의 및 k8s 배포/운영 가이드 문서화

## 4. 품질 게이트 및 최종 검증

- [x] 4.1 품질 게이트 4종 (`npx tsc --noEmit`, `npm test`, `npm run build`, `npm run lint`) 통과 및 테스트 개수(730개 이상) 확인
- [x] 4.2 K8s 매니페스트 문법 및 Dockerfile 설정 최종 점검
