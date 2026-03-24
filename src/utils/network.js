export function isLocalViteDev() {
  if (typeof window === "undefined") return false;
  const { hostname, port } = window.location;
  if (hostname !== "localhost" && hostname !== "127.0.0.1") return false;
  return port === "5173" || port === "4173";
}

export function isUiServedViaTopologyPod() {
  if (typeof window === "undefined") return false;
  return !isLocalViteDev();
}

export function normalizeKubernetesListBase(baseRaw, requestHeaders = {}) {
  const hasAuth = Boolean(requestHeaders.Authorization || requestHeaders.authorization);
  const base = (baseRaw || "").trim().replace(/\/$/, "");
  if (typeof window === "undefined") return base;
  if (hasAuth) return base;
  try {
    if (base.startsWith("http://") || base.startsWith("https://")) {
      const u = new URL(base);
      if (u.origin !== window.location.origin) {
        const laptopKubectlProxy = (u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.port === "8001";
        if (!laptopKubectlProxy) return base;
      }
    }
  } catch { /* */ }
  if (isLocalViteDev()) return base || "http://127.0.0.1:8001";
  return `${window.location.origin.replace(/\/$/, "")}/k8s-api`;
}

export function kubernetesListFetchUrl(baseRaw, pathSuffix) {
  const base = (baseRaw || "").replace(/\/$/, "");
  const suf = pathSuffix.startsWith("/") ? pathSuffix.slice(1) : pathSuffix;
  if (typeof window === "undefined") return `${base}/${suf}`;
  const root = base.startsWith("http://") || base.startsWith("https://") ? `${base}/` : `${window.location.origin}${base.startsWith("/") ? base : `/${base}`}/`;
  try {
    return new URL(suf, root).href;
  } catch {
    return `${base}/${suf}`;
  }
}

export async function fetchClusterEvents(base, hdr) {
  try {
    const url = kubernetesListFetchUrl(base, "/api/v1/events?limit=250");
    const r = await fetch(url, { headers: hdr, cache: "no-store", credentials: "omit" });
    if (!r.ok) return [];
    const d = await r.json();
    return (d.items || []).map((it, i) => ({
      id: it.metadata?.uid || `ev-${i}-${it.metadata?.name || ""}`,
      ns: it.metadata?.namespace || "",
      last: String(it.lastTimestamp || it.eventTime || ""),
      type: it.type || "",
      reason: it.reason || "",
      msg: (it.message || "").slice(0, 240),
      obj: `${it.involvedObject?.kind || ""}/${it.involvedObject?.name || ""}`,
    }));
  } catch {
    return [];
  }
}

export async function fetchPodLogTail(apiBaseRaw, hdr, namespace, podName, container, tailLines = 400) {
  const base = normalizeKubernetesListBase((apiBaseRaw || "").replace(/\/$/, ""), hdr || {});
  let path = `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(podName)}/log?tailLines=${tailLines}&timestamps=true`;
  if (container) path += `&container=${encodeURIComponent(container)}`;
  const url = kubernetesListFetchUrl(base, path);
  const r = await fetch(url, { headers: { ...hdr }, credentials: "omit", cache: "no-store" });
  if (!r.ok) {
    let t = "";
    try { t = await r.text(); } catch { /* */ }
    throw new Error(t?.slice(0, 280) || `HTTP ${r.status}`);
  }
  return r.text();
}
