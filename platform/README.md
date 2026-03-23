# Multi-Cluster Management Platform (Hub)

Centralized multi-cluster control plane scaffold: **cluster-service** is fully implemented; other microservices are minimal health servers until expanded.

## Repository layout

```
platform/
  api/openapi/           OpenAPI 3 specs
  deploy/helm/mcm-hub/   Umbrella Helm chart
  docs/ARCHITECTURE.md
  services/
    cluster-service/     Go — cluster registry & health metadata
    api-gateway/         Go — reverse proxy (expand to auth, rate limit)
    auth-service/        Go — /health only (OIDC next)
    gitops-service/      Go — /health only
    policy-service/      Go — /health only
    observability-service/ Go — /health only
  docker-compose.yml     Local Postgres + NATS + all services
```

## Quick start (local)

```bash
cd platform
docker compose up --build
```

- **cluster-service:** http://localhost:8081  
- **api-gateway:** http://localhost:8080/api/v1/clusters (proxies to cluster-service)  
- **Postgres:** localhost:5432 (`mcm` / `mcm` / db `mcm`)  
- **NATS:** localhost:4222  

### Create a cluster record (via gateway)

```bash
export TENANT=00000000-0000-0000-0000-000000000001

curl -sS -X POST "http://localhost:8080/api/v1/clusters" \
  -H "Content-Type: application/json" \
  -H "X-Tenant-ID: $TENANT" \
  -d '{
    "name": "prod-eks-1",
    "display_name": "Production EKS",
    "api_server_url": "https://k8s.example.com",
    "region": "eu-west-1",
    "provider": "aws",
    "k8s_version": "1.29.0",
    "labels": {"env":"prod","cost-center":"eng"}
  }' | jq .

curl -sS "http://localhost:8080/api/v1/clusters?limit=50&offset=0" \
  -H "X-Tenant-ID: $TENANT" | jq .
```

## Run cluster-service tests (no Docker DB required for unit tests)

```bash
cd platform/services/cluster-service
go test ./...
```

Integration with real Postgres:

```bash
docker compose -f ../../docker-compose.yml up -d postgres
export DATABASE_URL="postgres://mcm:mcm@localhost:5432/mcm?sslmode=disable"
go test ./... -tags=integration
```
*(Integration tag tests can be added later; default `go test` uses mocks.)*

## Deploy to Kubernetes (Helm)

```bash
cd platform/deploy/helm/mcm-hub
helm dependency update  # if subcharts added later
helm upgrade --install mcm-hub . -n mcm-system --create-namespace \
  -f values-dev.yaml
```

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the full system design and [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md) for install steps.

## CI

GitHub Actions workflow: `.github/workflows/platform-ci.yml` builds and tests Go services.
