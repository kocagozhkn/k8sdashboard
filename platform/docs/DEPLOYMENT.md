# Step-by-step deployment

## A. Local (Docker Compose)

1. Install Docker Engine + Compose v2.
2. From repo root:
   ```bash
   cd platform
   docker compose up --build
   ```
3. Wait for Postgres `healthy`, then:
   ```bash
   export TENANT=00000000-0000-0000-0000-000000000001
   curl -sS -X POST "http://localhost:8080/api/v1/clusters" \
     -H "Content-Type: application/json" -H "X-Tenant-ID: $TENANT" \
     -d '{"name":"local-test","display_name":"Local","api_server_url":"https://kubernetes.default","region":"local","provider":"kind","k8s_version":"1.29.0"}'
   ```

## B. Kubernetes (Helm)

1. Build and push images (replace registry):
   ```bash
   docker build -t YOUR_REGISTRY/mcm-cluster-service:0.1.0 platform/services/cluster-service
   docker build -t YOUR_REGISTRY/mcm-api-gateway:0.1.0 platform/services/api-gateway
   docker push YOUR_REGISTRY/mcm-cluster-service:0.1.0
   docker push YOUR_REGISTRY/mcm-api-gateway:0.1.0
   ```
2. Create namespace and DB secret:
   ```bash
   kubectl create namespace mcm-system
   kubectl -n mcm-system create secret generic mcm-database \
     --from-literal=database-url='postgres://USER:PASS@HOST:5432/mcm?sslmode=require'
   ```
3. Update `values-prod.yaml` (or overlay) with real image names and replica counts.
4. Install:
   ```bash
   helm upgrade --install mcm-hub platform/deploy/helm/mcm-hub \
     -n mcm-system -f platform/deploy/helm/mcm-hub/values-prod.yaml \
     --set clusterService.image=YOUR_REGISTRY/mcm-cluster-service:0.1.0 \
     --set gateway.image=YOUR_REGISTRY/mcm-api-gateway:0.1.0
   ```
5. Expose gateway via Ingress or `kubectl port-forward`.

## C. Environments

| File | Use |
|------|-----|
| `values-dev.yaml` | Single replica, dev images |
| `values-staging.yaml` | HA rehearsal |
| `values-prod.yaml` | Higher replicas and resources |

## D. CI

- `platform-ci.yml` runs `go test` for `cluster-service` and builds `api-gateway` on changes under `platform/`.

## E. Postman / API tests

Import `platform/collections/mcm-cluster.postman_collection.json` and set `baseUrl`, `tenantId`, and `clusterId` after create.
