# Kubernetes Deployment for AuctionBoss

매니페스트는 저장소 루트의 `k8s/`에 있다. 실제 클러스터 운영은 하지 않으므로(ROADMAP) 정적 검증만 한다:
`src/__tests__/deploy-config.test.ts`와 `kubectl kustomize k8s/`.

## Architecture
- **Backend (`deployment-backend.yaml`, `service-backend.yaml`)**:
  Spring Boot 백엔드. 화면용 API와 수집·사진 주기 실행을 맡는 **유일한 수집기**다. `replicas: 1`, `strategy: Recreate`
  (수집기 두 개가 같은 소스에 동시에 요청하지 않게 이전 인스턴스를 먼저 내린다). `prod` 프로필로 뜨며 MySQL에
  이전 완료 표식이 없으면 기동을 거부한다(`docs/REFERENCE.md`의 전환 런북 먼저). 서비스는 ClusterIP이고 Ingress가 없다.
  사진은 `auctionboss-photos-pvc`를 `/app/photos`에 마운트한다. 수집 설정은 `configmap-collector.yaml`(`config/collector.json`의 사본)이다.
- **MySQL (`statefulset-mysql.yaml`)**: `mysql:8.4`, `volumeClaimTemplates`(영속 볼륨), 헤드리스 서비스 `auctionboss-mysql`.
- **Web (`deployment.yaml`, `service.yaml`)**: 컨테이너 하나. 데이터 볼륨과 SQLite가 없고
  `AUCTIONBOSS_DATA_SOURCE=spring`, `AUCTIONBOSS_SPRING_BASE=http://auctionboss-backend:8080`으로 백엔드에서 읽는다.
- **Analyzer (`deployment-analyzer.yaml`)**: DB를 직접 읽지 않고 `AUCTIONBOSS_API_BASE=http://auctionboss-backend:8080`로 백엔드와 HTTP로만 통신한다.
- **Secret (`secret.yaml`)**: 키 이름만 있고 값은 없다. 값은 `kubectl create secret`으로 만든다(파일 주석 참고).
- **Storage**: MySQL 볼륨, 사진 PVC. `auctionboss-data-pvc`(이전 전 SQLite)는 롤백 창 동안 선언만 남기며 아무도 마운트하지 않는다.

## Deployment Guide
1. 클러스터와 `kubectl`이 준비되어 있어야 한다.
2. 이미지 두 개를 만든다(Minikube 등이면 클러스터에 올린다):
   ```bash
   docker build -t auctionboss:latest .
   docker build -t auctionboss-backend:latest backend
   ```
3. Secret을 만든다(`k8s/secret.yaml` 주석의 명령). 값은 저장소에 두지 않는다.
4. Kustomize로 적용한다:
   ```bash
   kubectl apply -k k8s/
   ```
5. 확인:
   ```bash
   kubectl get pods -n auctionboss
   ```

## Probes
- 웹: readinessProbe는 `/api/health`(백엔드 헬스체크로 판정)이고, livenessProbe는 `tcpSocket` 3000이다. 백엔드가 잠시 내려가도 웹을 재시작하지 않는다.
- 백엔드: readiness·liveness 모두 `/api/health`.
