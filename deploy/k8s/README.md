# Kubernetes Deployment for AuctionBoss

## Architecture
- **Web & Collector (Multi-container Pod)**: 
  Both the Web API server and the Data Collector run in the same pod (`deployment.yaml`). This ensures they can safely share the same `auctionboss.sqlite` file via a single ReadWriteOnce PVC without file locking issues.
- **Analyzer (Independent Pod)**:
  The Analyzer worker runs in a separate deployment (`deployment-analyzer.yaml`). It does not directly access the database. Instead, it communicates with the Web API server using HTTP calls (`http://auctionboss-service:3000`).
- **Storage**:
  A single `PersistentVolumeClaim` (PVC) is used to persist SQLite data at `/app/data`.

## Deployment Guide
1. Ensure your Kubernetes cluster is running and `kubectl` is configured.
2. Build the Docker image and load it to your cluster (if using Minikube or similar):
   ```bash
   docker build -t auctionboss:latest .
   ```
3. Apply the manifests using Kustomize:
   ```bash
   kubectl apply -k k8s/
   ```
4. Verify the deployment:
   ```bash
   kubectl get pods -n auctionboss
   ```

## Probes
The Web container is configured with `livenessProbe` and `readinessProbe` checking the `/api/health` endpoint to automatically restart the container in case of failures.
