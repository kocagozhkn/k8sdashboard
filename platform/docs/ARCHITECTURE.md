# Multi-Cluster Management Platform — Architecture

Production-oriented hub–spoke design inspired by ACM patterns: a **control plane hub** (this repo) manages **spoke clusters** via agents or read-only API credentials, GitOps controllers, and policy agents.

## 1. Logical architecture (textual)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           TENANT USERS (OIDC)                                │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │ HTTPS
┌───────────────────────────────────▼─────────────────────────────────────────┐
│  api-gateway (REST/gRPC edge, rate limit, routing, mTLS to internal svcs)   │
└───────┬──────────┬──────────┬──────────┬──────────┬────────────────────────┘
        │          │          │          │          │
        ▼          ▼          ▼          ▼          ▼
   auth-svc   cluster-svc  gitops-svc policy-svc  obs-svc
        │          │          │          │          │
        └──────────┴────┬─────┴──────────┴──────────┘
                        │
            ┌───────────▼───────────┐
            │   PostgreSQL (SSOT)   │  tenants, clusters, apps, policies, audit
            └───────────────────────┘
                        │
            ┌───────────▼───────────┐
            │  NATS JetStream       │  cluster events, sync status, policy violations
            └───────────────────────┘

Spoke clusters (100+):
  ┌─────────────────┐     ┌─────────────────┐
  │ cluster-agent   │     │ Argo CD /       │
  │ (optional)      │     │ ApplicationSet  │──► Git repos
  └────────┬────────┘     └────────┬────────┘
           │                       │
           ▼                       ▼
    Kube API + metrics      GitOps desired state
```

### Hub–spoke data flow

1. **Registration:** Operator posts cluster metadata + **reference** to credentials (Vault/K8s secret name), not long-lived kubeconfig in the app DB in production.
2. **Health:** `cluster-service` schedules checks (or ingests agent heartbeats); results written to Postgres and published on NATS for WebSocket fan-out.
3. **GitOps:** `gitops-service` owns Application CR projections, sync status from Argo CD API, drift flags; emits events on NATS.
4. **Policy:** `policy-service` aggregates Gatekeeper/OPA violation CRs (via agents or pull) into Postgres for the UI.
5. **Observability:** `observability-service` stores links to Prometheus/Grafana/Loki per cluster and proxies read-only queries where safe.

## 2. Scalability (100+ clusters)

| Concern | Approach |
|--------|----------|
| API read load | Pagination, read replicas for Postgres, Redis cache for hot lists |
| Health checks | Worker pool + jitter; avoid thundering herd; store last result only |
| Events | NATS JetStream with consumer groups; WebSocket service subscribes per tenant |
| Multi-tenant isolation | `tenant_id` on all rows; RLS in Postgres; gateway enforces JWT `tenant` claim |
| Blast radius | mTLS between services; no shared kubeconfig blobs in logs |

## 3. Security

- **OIDC:** `auth-service` validates tokens, issues internal session/JWT with tenant + RBAC scopes.
- **Secrets:** Prefer **HashiCorp Vault** or **External Secrets**; DB holds `credential_ref` only.
- **Network:** Gateway is only public ingress; internal services ClusterIP + NetworkPolicy.

## 4. Technology mapping

| Component | Choice |
|-----------|--------|
| Backend | Go 1.22+ |
| Sync API | REST (OpenAPI) + gRPC (protobufs can extend `api/proto/`) |
| Frontend | React + TypeScript (separate package `web/` in future iteration) |
| DB | PostgreSQL 15+ |
| Events | NATS 2.x (JetStream enabled for replay) |
| Packaging | Helm umbrella chart + Kustomize overlays per env |

## 5. Environment separation

- **dev:** single namespace, small Postgres, NATS single replica.
- **staging:** HA Postgres, NATS cluster, realistic limits.
- **prod:** multi-AZ, PDBs, Pod anti-affinity, external managed Postgres, secrets from Vault.

## 6. Bonus (AI anomaly / remediation)

- **Offline batch:** export metrics snapshots to object storage; train isolation forest / Prophet on node/pod metrics; write `anomaly_scores` table.
- **Online:** optional sidecar calling an LLM API with **redacted** metric deltas to suggest runbooks (never auto-execute without human approval).

---

This repository implements **cluster-service** end-to-end; other services expose health endpoints and Helm wiring so the platform can grow without rework.
