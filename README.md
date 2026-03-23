# K8s Topology Viewer

React + Vite + D3 ile çalışan, Kubernetes kaynaklarını (Pod, Service, Deployment, Ingress, vb.) topoloji grafiği olarak gösteren hafif bir arayüz. Sağlık ipuçları, demo modu ve `kubectl` JSON yapıştırma desteği içerir.

## Özellikler

- **Kümede otomatik bağlantı**: Uygulama Ingress/LB üzerinden `localhost` dışı bir host’tan açıldığında, aynı origin altındaki `/k8s-api` üzerinden pod içi `kubectl proxy` ile API’ye bağlanıp listelemeyi dener.
- **Ön tanımlı kümeler**: `cluster-presets.js` içinde sabit hedefler (ör. `same-origin`, QA için tam URL).
- **kubeconfig**: Dosya seçme veya yapıştırma; token’lı context’lerle (CORS izin verirse) doğrudan API; aksi halde yerelde `kubectl proxy --port=8001`.
- **Demo** ve **kubectl çıktısı yapıştırma** (`kubectl get … -o json`).
- **Çift konteyner pod**: Nginx (statik UI + `/k8s-api` ters vekili) + `kubectl` proxy sidecar (service account ile API).

## Gereksinimler

- Node.js 20+ (yerel geliştirme)
- Docker (imaj üretimi)
- Kubernetes: `kubectl` ve hedef kümede uygulama için uygun imaj çekme (ör. ACR + AKS)

## Yerel geliştirme

```bash
npm install
npm run dev
```

Canlı API için:

```bash
kubectl config use-context <context>
kubectl proxy --port=8001
```

Tarayıcıda API tabanı genelde `http://127.0.0.1:8001` olur. İsterseniz `vite.config.js` içindeki `/k8s-api` proxy’sini kullanıp URL olarak `http://localhost:5173/k8s-api` da verebilirsiniz.

## Üretim derlemesi ve Docker

```bash
npm run build
```

`postbuild` betiği tanımlıysa commit + `git push` çalıştırır. Sadece derleme için:

```bash
DOCKER_BUILD=1 npm run build
```

İmaj (Dockerfile `DOCKER_BUILD=1` ile postbuild’i atlar):

```bash
docker build -t <registry>/k8s-topology:latest .
docker push <registry>/k8s-topology:latest
```

`k8s-manifest.yaml` içindeki `image:` alanını kendi registry’nize göre güncelleyin.

## Kubernetes’e dağıtım

```bash
kubectl apply -f k8s-manifest.yaml
```

Oluşturulan kaynaklar:

| Kaynak | Açıklama |
|--------|----------|
| `Namespace/topology` | İzolasyon |
| `ServiceAccount` + `ClusterRole` + `ClusterRoleBinding` | Salt okunur API (`get/list/watch`) |
| `Deployment` | Nginx + `rancher/kubectl` proxy sidecar |
| `Service` `LoadBalancer` | Azure AKS için **iç** LB (`azure-load-balancer-internal: "true"`) |

**Kong kullanılmaz**; erişim internal LoadBalancer IP’si (veya buna işaret eden private DNS) ile yapılır:

```bash
kubectl get svc k8s-topology -n topology
```

## Yapılandırma

### QA veya ek küme URL’si (Vite build zamanı)

`.env` veya CI ortamında:

```bash
VITE_K8S_API_CORTEX_QA_AKS=https://<qa-host>/k8s-api
```

Örnek: `.env.example`

### Ön tanımlı kümeler

`cluster-presets.js` dosyasını düzenleyin: `same-origin`, boş olmayan tam `https://…/k8s-api` URL’leri veya ek satırlar.

### kubeconfig (tarayıcı)

`~/.kube/config` otomatik okunmaz; dosya seçilir veya içerik yapıştırılır. İsteğe bağlı **Tarayıcıda sakla** `localStorage` kullanır.

## Mimari özeti

```
Tarayıcı → Service (LB) → nginx:80
                              ├ /          → React SPA
                              └ /k8s-api/* → 127.0.0.1:8001 (kubectl proxy) → API sunucusu
```

Proxy, pod’un service account token’ı ile kimlik doğrular; RBAC `k8s-topology-reader` ile sınırlıdır.

## Sorun giderme

- **`Failed to fetch` / boş liste**: UI’yi `kubectl port-forward svc/k8s-topology 8080:80` ile açıyorsanız API tabanı **`http://127.0.0.1:8001` değil**, **`http://localhost:8080/k8s-api`** olmalı (uygulama Vite dışındaki tüm oturumlarda bunu otomatik seçer). Yalnız `npm run dev` (5173) iken laptop’ta `kubectl proxy --port=8001` kullanın.
- **Boş graf / HTTP hataları**: Hata metnindeki kod ve gövde özeti; hard refresh (`cache: no-store` kullanılır).
- **Exec / istemci sertifikası** ile giriş yapan context’ler tarayıcıda doğrudan kullanılamaz; `kubectl proxy` kullanın.
- **ACR**: AKS’in imajı çekebilmesi için `az aks update --attach-acr …` veya eşdeğer `AcrPull` yetkisi gerekir.

## Lisans

Private / proje içi kullanım (`package.json` içinde `"private": true`).
