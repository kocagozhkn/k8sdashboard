# Web UI (React + TypeScript) — planned

Screens to implement:

1. **Clusters** — table + map of regions; detail: health, version, labels, link to spoke metrics.
2. **GitOps** — applications per cluster, sync status, commit SHA, drift badge.
3. **Policies** — violations by cluster/namespace with severity filters.
4. **Observability** — embedded Grafana panels or deep links per cluster.
5. **Admin** — tenants, OIDC settings (calls `auth-service`).

Use **TanStack Query** + **WebSocket** (or SSE) subscribed to NATS-backed hub for live status.

Bootstrap with Vite + React + TS in this directory when ready:

```bash
npm create vite@latest . -- --template react-ts
```
