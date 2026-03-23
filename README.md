# K8s Topology Viewer

A lightweight UI built with React, Vite, and D3 that shows Kubernetes resources (Pod, Service, Deployment, Ingress, etc.) as a topology graph. Includes health hints, demo mode, and `kubectl` JSON paste support.

## Features

- **In-cluster auto-connect**: When the app is opened from a non-`localhost` host (Ingress/LB), it tries to list resources via `/k8s-api` on the same origin (in-pod `kubectl proxy`).
- **Cluster presets**: Fixed targets in `cluster-presets.js` (e.g. `same-origin`, full QA URL).
- **kubeconfig**: File upload or paste; token-based contexts can call the API directly when CORS allows; otherwise use local `kubectl proxy --port=8001`.
- **Demo** and **kubectl output paste** (`kubectl get … -o json`).
- **Two-container pod**: Nginx (static UI + `/k8s-api` reverse proxy) + `kubectl` proxy sidecar (ServiceAccount API access).

## Requirements

- Node.js 20+ (local development)
- Docker (image builds)
- Kubernetes: `kubectl` and image pull rights on the target cluster (e.g. ACR + AKS)

## Local development

```bash
npm install
npm run dev
```

For the live API:

```bash
kubectl config use-context <context>
kubectl proxy --port=8001
```

The API base in the browser is usually `http://127.0.0.1:8001`. You can also use the `/k8s-api` proxy from `vite.config.js` and set the URL to `http://localhost:5173/k8s-api`.

## Production build and Docker

```bash
npm run build
```

If `postbuild` is defined, it may run commit + `git push`. Build only:

```bash
DOCKER_BUILD=1 npm run build
```

Image (Dockerfile sets `DOCKER_BUILD=1` so postbuild is skipped):

```bash
docker build -t <registry>/k8s-topology:latest .
docker push <registry>/k8s-topology:latest
```

Update the `image:` field in `k8s-manifest.yaml` for your registry.

**One-shot release** (local git push + Docker + ACR + `kubectl apply` + rollout), with defaults for this project’s registry and `topology` namespace:

```bash
npm run release
```

Override if needed: `K8S_TOPOLOGY_REGISTRY`, `K8S_TOPOLOGY_IMAGE`, `K8S_TOPOLOGY_NS`, `K8S_TOPOLOGY_DEPLOY`.

## Deploy to Kubernetes

```bash
kubectl apply -f k8s-manifest.yaml
```

Resources created:

| Resource | Description |
|----------|-------------|
| `Namespace/topology` | Isolation |
| `ServiceAccount` + `ClusterRole` + `ClusterRoleBinding` | Read-only API (`get/list/watch`) |
| `Deployment` | Nginx + `rancher/kubectl` proxy sidecar |
| `Service` `LoadBalancer` | **Internal** Azure LB (`azure-load-balancer-internal: "true"`) |

**Kong is not used**; access is via the internal LoadBalancer IP (or private DNS):

```bash
kubectl get svc k8s-topology -n topology
```

## Configuration

### QA or extra cluster URL (Vite build time)

In `.env` or CI:

```bash
VITE_K8S_API_CORTEX_QA_AKS=https://<qa-host>/k8s-api
```

See `.env.example`.

### Preset clusters

Edit `cluster-presets.js`: `same-origin`, non-empty full `https://…/k8s-api` URLs, or add rows.

### kubeconfig (browser)

`~/.kube/config` is not read automatically; use file upload or paste. Optional **Save in browser** uses `localStorage`.

## Architecture summary

```
Browser → Service (LB) → nginx:80
                            ├ /          → React SPA
                            └ /k8s-api/* → 127.0.0.1:8001 (kubectl proxy) → API server
```

The proxy authenticates with the pod’s service account; RBAC is limited by `k8s-topology-reader`.

## Troubleshooting

- **`Failed to fetch` / empty list**: If you open the UI with `kubectl port-forward svc/k8s-topology 8080:80`, the API base must be **`http://localhost:8080/k8s-api`**, not `http://127.0.0.1:8001` (outside Vite, the app picks this automatically). Use `kubectl proxy --port=8001` only with `npm run dev` (5173).
- **Empty graph / HTTP errors**: Check the error text and body snippet; the app uses `cache: no-store`; try a hard refresh.
- Contexts using **exec** or **client certs** cannot be used directly in the browser; use `kubectl proxy`.
- **ACR**: AKS needs `az aks update --attach-acr …` or equivalent `AcrPull` to pull images.

## Multi-cluster platform (experimental)

A separate hub-style scaffold (Go services, Helm, OpenAPI) lives under **`platform/`**. See [platform/README.md](platform/README.md).

## License

Private / internal use (`package.json` has `"private": true`).
