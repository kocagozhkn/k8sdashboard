/**
 * Ön tanımlı AKS / kubectl context seçenekleri.
 * - apiBase: "same-origin" → /k8s-api (LB, port-forward, Ingress); yalnız Vite dev (5173/4173) → 127.0.0.1:8001
 * - apiBase: tam URL → kubectl-proxy veya başka kümedeki topology /k8s-api kökü (sonunda /k8s-api olmalı)
 */
export const CLUSTER_PRESETS = [
  { id: "cortex-internal-aks", label: "cortex-internal-aks", apiBase: "same-origin" },
  {
    id: "cortex-qa-aks",
    label: "cortex-qa-aks",
    apiBase: import.meta.env.VITE_K8S_API_CORTEX_QA_AKS || "",
  },
]

export function resolvePresetApiBase(preset) {
  if (!preset) return ""
  const raw = preset.apiBase
  if (raw === "same-origin") {
    if (typeof window === "undefined") return ""
    const { hostname, port } = window.location
    const vite = (hostname === "localhost" || hostname === "127.0.0.1") && (port === "5173" || port === "4173")
    if (vite) return "http://127.0.0.1:8001"
    return `${window.location.origin.replace(/\/$/, "")}/k8s-api`
  }
  return String(raw || "").trim().replace(/\/$/, "")
}
