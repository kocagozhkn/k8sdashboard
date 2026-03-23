/**
 * Ön tanımlı AKS / kubectl context seçenekleri.
 * - apiBase: "same-origin" → Ingress’te barındığınız kümede /k8s-api; localhost’ta http://127.0.0.1:8001
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
    const h = window.location.hostname
    if (h === "localhost" || h === "127.0.0.1") return "http://127.0.0.1:8001"
    return `${window.location.origin.replace(/\/$/, "")}/k8s-api`
  }
  return String(raw || "").trim().replace(/\/$/, "")
}
