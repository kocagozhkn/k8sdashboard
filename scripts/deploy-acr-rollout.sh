#!/usr/bin/env bash
# Full release: Vite build (+ git postbuild push) → Docker → ACR push → apply manifest → rollout.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

REGISTRY="${K8S_TOPOLOGY_REGISTRY:-cortexdevacrincp2.azurecr.io}"
IMAGE_NAME="${K8S_TOPOLOGY_IMAGE:-k8s-topology}"
NS="${K8S_TOPOLOGY_NS:-topology}"
DEPLOY="${K8S_TOPOLOGY_DEPLOY:-k8s-topology}"

echo "==> npm run build (postbuild may git push)"
npm run build

SHA="$(git rev-parse --short HEAD)"
TAG_LATEST="${REGISTRY}/${IMAGE_NAME}:latest"
TAG_SHA="${REGISTRY}/${IMAGE_NAME}:${SHA}"

echo "==> docker build (${TAG_LATEST}, ${TAG_SHA})"
docker build --build-arg BUILD_SHA="$SHA" -t "$TAG_LATEST" -t "$TAG_SHA" .

echo "==> docker push"
docker push "$TAG_LATEST"
docker push "$TAG_SHA"

echo "==> kubectl apply -f k8s-manifest.yaml"
kubectl apply -f k8s-manifest.yaml

echo "==> kubectl rollout restart deployment/${DEPLOY} -n ${NS}"
kubectl rollout restart "deployment/${DEPLOY}" -n "$NS"
kubectl rollout status "deployment/${DEPLOY}" -n "$NS" --timeout=180s

echo "==> Done — ${TAG_LATEST} @ ${SHA}"
