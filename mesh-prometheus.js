/**
 * Prometheus mesh traffic (Istio / Linkerd / Cilium Hubble) → topology node/edge annotations.
 * Queries use instant vector API; RPS = rate() over [5m] evaluated at query time.
 */

export const MESH_PROFILES = {
  off: { id: "off", label: "Kapalı" },
  istio: {
    id: "istio",
    label: "Istio",
    queryRps: `sum by (source_workload, source_workload_namespace, destination_service_name, destination_service_namespace) (
  rate(istio_requests_total{reporter="source"}[5m])
)`,
    queryErr: `sum by (source_workload, source_workload_namespace, destination_service_name, destination_service_namespace) (
  rate(istio_requests_total{reporter="source", response_code=~"5.."}[5m])
)`,
  },
  linkerd: {
    id: "linkerd",
    label: "Linkerd",
    queryRps: `sum by (namespace, deployment, dst_namespace, dst_service) (
  rate(request_total{direction="outbound"}[5m])
)`,
    queryErr: `sum by (namespace, deployment, dst_namespace, dst_service) (
  rate(request_total{direction="outbound", classification="failure"}[5m])
)`,
  },
  cilium: {
    id: "cilium",
    label: "Cilium Hubble",
    queryRps: `sum by (source_namespace, source_workload, destination_namespace, destination_workload) (
  rate(hubble_http_requests_total[5m])
)`,
    queryErr: `sum by (source_namespace, source_workload, destination_namespace, destination_workload) (
  rate(hubble_http_requests_total{status=~"5.."}[5m])
)`,
  },
};

function svcKey(ns, name) {
  return `${ns || "default"}/${name}`;
}

function parseSampleValue(v) {
  if (Array.isArray(v) && v.length >= 2) return parseFloat(v[1]) || 0;
  return 0;
}

export async function fetchPrometheusInstant(baseUrl, query) {
  const root = (baseUrl || "").replace(/\/$/, "");
  if (!root) throw new Error("Prometheus URL boş");
  const url = `${root}/api/v1/query?query=${encodeURIComponent(query)}`;
  const r = await fetch(url, { credentials: "omit", cache: "no-store" });
  const text = await r.text();
  if (!r.ok) throw new Error(text.slice(0, 280) || `HTTP ${r.status}`);
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error("Prometheus yanıtı JSON değil");
  }
  if (j.status !== "success") throw new Error(j.error || j.data?.error || "Prometheus sorgu hatası");
  return j.data?.result || [];
}

function addMapNum(m, k, v) {
  if (!k || !Number.isFinite(v) || v <= 0) return;
  m.set(k, (m.get(k) || 0) + v);
}

/** Parse Istio vector / matrix instant rows */
export function accumulateIstioRows(rpsRows, errRows) {
  const serviceInbound = new Map();
  const workloadOutbound = new Map();
  const pairErr = new Map();

  for (const row of rpsRows || []) {
    const m = row.metric || {};
    const v = parseSampleValue(row.value);
    const srcW = m.source_workload || "";
    const srcNs = m.source_workload_namespace || "default";
    let dstSvc = m.destination_service_name || "";
    let dstNs = m.destination_service_namespace || m.destination_workload_namespace || "";
    if (m.destination_service) {
      const fq = String(m.destination_service);
      const mm = fq.match(/^([^.]+)\.([^.]+)\.svc(?:\.cluster\.local)?\.?/i);
      if (mm) {
        if (!dstSvc) dstSvc = mm[1];
        if (!dstNs) dstNs = mm[2];
      }
    }
    if (!dstNs) dstNs = "default";
    if (dstSvc) addMapNum(serviceInbound, svcKey(dstNs, dstSvc), v);
    if (srcW) addMapNum(workloadOutbound, svcKey(srcNs, srcW), v);
  }

  for (const row of errRows || []) {
    const m = row.metric || {};
    const v = parseSampleValue(row.value);
    let dstSvc = m.destination_service_name || "";
    let dstNs = m.destination_service_namespace || m.destination_workload_namespace || "";
    if (m.destination_service) {
      const fq = String(m.destination_service);
      const mm = fq.match(/^([^.]+)\.([^.]+)\.svc(?:\.cluster\.local)?\.?/i);
      if (mm) {
        if (!dstSvc) dstSvc = mm[1];
        if (!dstNs) dstNs = mm[2];
      }
    }
    if (!dstNs) dstNs = "default";
    if (dstSvc) addMapNum(pairErr, svcKey(dstNs, dstSvc), v);
  }

  return { serviceInbound, workloadOutbound, serviceErrors: pairErr, mesh: "istio" };
}

export function accumulateLinkerdRows(rpsRows, errRows) {
  const serviceInbound = new Map();
  const workloadOutbound = new Map();
  const serviceErrors = new Map();

  const parseDst = (raw) => {
    const s = String(raw || "");
    const mm = s.match(/^([^.]+)\.([^.]+)\.svc(?:\.cluster\.local)?$/i);
    if (mm) return { name: mm[1], ns: mm[2] };
    return { name: s.split(".")[0] || s, ns: "default" };
  };

  for (const row of rpsRows || []) {
    const m = row.metric || {};
    const v = parseSampleValue(row.value);
    const srcW = m.deployment || "";
    const srcNs = m.namespace || "default";
    const { name: dstSvc, ns: dstNs } = parseDst(m.dst_service);
    if (dstSvc) addMapNum(serviceInbound, svcKey(dstNs, dstSvc), v);
    if (srcW) addMapNum(workloadOutbound, svcKey(srcNs, srcW), v);
  }
  for (const row of errRows || []) {
    const m = row.metric || {};
    const v = parseSampleValue(row.value);
    const { name: dstSvc, ns: dstNs } = parseDst(m.dst_service);
    if (dstSvc) addMapNum(serviceErrors, svcKey(dstNs, dstSvc), v);
  }
  return { serviceInbound, workloadOutbound, serviceErrors, mesh: "linkerd" };
}

export function accumulateCiliumRows(rpsRows, errRows) {
  const serviceInbound = new Map();
  const workloadOutbound = new Map();
  const serviceErrors = new Map();

  for (const row of rpsRows || []) {
    const m = row.metric || {};
    const v = parseSampleValue(row.value);
    const srcW = m.source_workload || "";
    const srcNs = m.source_namespace || "default";
    const dstW = m.destination_workload || "";
    const dstNs = m.destination_namespace || "default";
    if (dstW) addMapNum(serviceInbound, svcKey(dstNs, dstW), v);
    if (srcW) addMapNum(workloadOutbound, svcKey(srcNs, srcW), v);
  }
  for (const row of errRows || []) {
    const m = row.metric || {};
    const v = parseSampleValue(row.value);
    const dstW = m.destination_workload || "";
    const dstNs = m.destination_namespace || "default";
    if (dstW) addMapNum(serviceErrors, svcKey(dstNs, dstW), v);
  }
  return { serviceInbound, workloadOutbound, serviceErrors, mesh: "cilium" };
}

export async function fetchMeshTrafficStats(baseUrl, profileId) {
  const p = MESH_PROFILES[profileId];
  if (!p || profileId === "off" || !p.queryRps) return null;
  const rpsRows = await fetchPrometheusInstant(baseUrl, p.queryRps);
  let errRows = [];
  try {
    errRows = await fetchPrometheusInstant(baseUrl, p.queryErr);
  } catch {
    errRows = [];
  }
  if (profileId === "istio") return accumulateIstioRows(rpsRows, errRows);
  if (profileId === "linkerd") return accumulateLinkerdRows(rpsRows, errRows);
  if (profileId === "cilium") return accumulateCiliumRows(rpsRows, errRows);
  return null;
}

export function formatShortRps(n) {
  if (n == null || !Number.isFinite(n)) return "0";
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 1e4 ? 0 : 1)}k`;
  if (n >= 100) return `${Math.round(n)}`;
  if (n >= 10) return `${n.toFixed(1)}`;
  return n >= 1 ? `${n.toFixed(1)}` : `${n.toFixed(2)}`;
}

/**
 * Attach trafficInRps / trafficOutRps / trafficErrRatio to nodes; trafficRps on edges (selects, routes).
 */
export function mergeTrafficIntoGraph(graph, stats) {
  if (!stats || !graph?.nodes?.length) return graph;
  const { serviceInbound, workloadOutbound, serviceErrors } = stats;
  const nById = new Map(graph.nodes.map((n) => [n.id, n]));
  const nodes = graph.nodes.map((n) => {
    const copy = { ...n };
    delete copy.trafficInRps;
    delete copy.trafficOutRps;
    delete copy.trafficErrRatio;
    if (n.kind === "Service") {
      const k = svcKey(n.namespace, n.name);
      const inR = serviceInbound.get(k);
      if (inR != null) {
        copy.trafficInRps = inR;
        const er = serviceErrors?.get(k) || 0;
        copy.trafficErrRatio = inR > 0 ? Math.min(1, er / inR) : 0;
      }
    }
    if (["Deployment", "StatefulSet", "DaemonSet"].includes(n.kind)) {
      const k = svcKey(n.namespace, n.name);
      const out = workloadOutbound.get(k);
      if (out != null) copy.trafficOutRps = out;
    }
    if (n.kind === "Pod") {
      const k = svcKey(n.namespace, n.name);
      const out = workloadOutbound.get(k);
      if (out != null) copy.trafficOutRps = out;
    }
    return copy;
  });
  const idToNode = new Map(nodes.map((n) => [n.id, n]));
  const edges = graph.edges.map((e) => {
    const ex = { ...e };
    delete ex.trafficRps;
    delete ex.trafficErrRps;
    delete ex.trafficLabel;
    return ex;
  });

  const svcToSelectEdges = new Map();
  for (const e of edges) {
    if (e.type !== "selects") continue;
    const src = idToNode.get(e.source);
    if (!src || src.kind !== "Service") continue;
    if (!svcToSelectEdges.has(e.source)) svcToSelectEdges.set(e.source, []);
    svcToSelectEdges.get(e.source).push(e);
  }
  for (const [, elist] of svcToSelectEdges) {
    const svc = idToNode.get(elist[0].source);
    if (!svc) continue;
    const k = svcKey(svc.namespace, svc.name);
    const total = serviceInbound.get(k);
    const errT = serviceErrors?.get(k) || 0;
    const n = Math.max(1, elist.length);
    if (total != null) {
      const per = total / n;
      const perErr = errT / n;
      for (const e of elist) {
        e.trafficRps = per;
        e.trafficErrRps = perErr;
        e.trafficLabel = edgeTrafficLabel(per, perErr);
      }
    }
  }

  for (const e of edges) {
    if (e.type !== "routes" || e.trafficLabel) continue;
    const tgt = idToNode.get(e.target);
    if (!tgt || tgt.kind !== "Service") continue;
    const k = svcKey(tgt.namespace, tgt.name);
    const total = serviceInbound.get(k);
    const errT = serviceErrors?.get(k) || 0;
    if (total != null) {
      e.trafficRps = total;
      e.trafficErrRps = errT;
      e.trafficLabel = edgeTrafficLabel(total, errT);
    }
  }

  return { nodes, edges };
}

function edgeTrafficLabel(rps, errRps) {
  const base = `${formatShortRps(rps)} rps`;
  if (errRps > 0 && rps > 0) {
    const pct = (errRps / rps) * 100;
    if (pct >= 0.1) return `${base} · ${pct.toFixed(1)}%5xx`;
  }
  return base;
}

/** Top N services by inbound for bottleneck hint */
export function topInboundServices(stats, limit = 8) {
  if (!stats?.serviceInbound?.size) return [];
  return [...stats.serviceInbound.entries()]
    .map(([k, v]) => {
      const [ns, name] = k.split("/");
      const er = stats.serviceErrors?.get(k) || 0;
      return { ns, name, rps: v, errRps: er, errPct: v > 0 ? (er / v) * 100 : 0 };
    })
    .sort((a, b) => b.rps - a.rps)
    .slice(0, limit);
}
