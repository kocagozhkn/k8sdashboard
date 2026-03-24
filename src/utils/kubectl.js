import { KINDS } from "../constants/theme.js";
import { buildAzureDependencyGraph, augmentAzureEdgesToPods } from "./azure.js";

function getStatus(item) {
  if (item.kind === "Pod") return item.status?.phase || "Unknown";
  if (item.kind === "Node") {
    const conds = item.status?.conditions || [];
    const ready = conds.find(c => c.type === "Ready")?.status === "True";
    const pressure = conds.find(c => ["MemoryPressure", "DiskPressure", "PIDPressure"].includes(c.type) && c.status === "True");
    if (!ready) return "NotReady";
    if (pressure) return pressure.type;
    return "Ready";
  }
  if (["Deployment", "StatefulSet", "DaemonSet"].includes(item.kind)) {
    return `${item.status?.readyReplicas ?? 0}/${item.spec?.replicas ?? 1}`;
  }
  if (item.kind === "PersistentVolumeClaim") return item.status?.phase || "Unknown";
  if (item.kind === "HorizontalPodAutoscaler") {
    const cur = item.status?.currentReplicas ?? 0;
    const des = item.status?.desiredReplicas ?? 0;
    const mx = item.spec?.maxReplicas ?? "?";
    return `${cur}/${des} (max ${mx})`;
  }
  if (item.kind === "PodDisruptionBudget") {
    const d = item.status?.currentHealthy ?? 0;
    const e = item.status?.expectedPods ?? "?";
    return `healthy ${d}/${e}`;
  }
  if (item.kind === "NetworkPolicy") return item.spec?.policyTypes?.join(",") || "Active";
  return "Active";
}

function getRestarts(item) {
  if (item.kind !== "Pod") return 0;
  return item.status?.containerStatuses?.reduce((a, c) => a + (c.restartCount || 0), 0) || 0;
}

function nodeRolesFromItem(item) {
  if (item.kind !== "Node") return undefined;
  const labels = item.metadata?.labels || {};
  const roles = Object.keys(labels)
    .filter(k => k.startsWith("node-role.kubernetes.io/"))
    .map(k => k.split("/")[1] || "worker")
    .filter(Boolean);
  return roles.length ? roles : ["worker"];
}

function nodePressureFromItem(item) {
  if (item.kind !== "Node") return undefined;
  return (item.status?.conditions || [])
    .filter(c => ["MemoryPressure", "DiskPressure", "PIDPressure"].includes(c.type))
    .map(c => ({ type: c.type, status: c.status === "True" }));
}

function podContainerNamesFromSpec(item) {
  if (item.kind !== "Pod") return undefined;
  const names = (item.spec?.containers || []).map(c => c.name).filter(Boolean);
  return names.length ? names : undefined;
}

function podImageInfoFromItem(item) {
  if (item.kind !== "Pod") return undefined;
  const lines = [];
  const add = (c, prefix) => {
    const ref = (c.image || "").trim() || "?";
    const head = prefix ? `${prefix}${c.name}: ` : `${c.name}: `;
    lines.push(`${head}${ref}`);
  };
  for (const c of item.spec?.containers || []) add(c, "");
  for (const c of item.spec?.initContainers || []) add(c, "[init] ");
  return lines.length ? lines.join("\n\n") : undefined;
}

export function parseCpuToMilli(v) {
  if (!v || typeof v !== "string") return 0;
  if (v.endsWith("m")) return Math.round(parseFloat(v) || 0);
  if (v.endsWith("n")) return Math.round((parseFloat(v) || 0) / 1e6);
  if (v.endsWith("u")) return Math.round((parseFloat(v) || 0) / 1e3);
  return Math.round((parseFloat(v) || 0) * 1000);
}

export function parseMemoryToMi(v) {
  if (!v || typeof v !== "string") return 0;
  const units = [
    ["Ki", 1 / 1024],
    ["Mi", 1],
    ["Gi", 1024],
    ["Ti", 1024 * 1024],
    ["K", 1 / (1000 * 1024 / 1024)],
    ["M", 1000 * 1000 / (1024 * 1024)],
    ["G", 1000 * 1000 * 1000 / (1024 * 1024)],
  ];
  for (const [suffix, factor] of units) {
    if (v.endsWith(suffix)) return Math.round((parseFloat(v) || 0) * factor);
  }
  return Math.round((parseFloat(v) || 0) / (1024 * 1024));
}

export function formatCpuRequestMilli(value) {
  if (value == null) return "";
  return `${value}m`;
}

export function formatMemoryMi(value) {
  if (value == null) return "";
  return `${value} Mi`;
}

function resourceSummaryFromPodSpec(spec) {
  if (!spec?.containers?.length) return undefined;
  let reqCpuMilli = 0, limCpuMilli = 0, reqMemMi = 0, limMemMi = 0;
  let hasReqCpu = false, hasLimCpu = false, hasReqMem = false, hasLimMem = false;
  for (const c of spec.containers || []) {
    const req = c.resources?.requests || {};
    const lim = c.resources?.limits || {};
    if (req.cpu) { reqCpuMilli += parseCpuToMilli(req.cpu); hasReqCpu = true; }
    if (lim.cpu) { limCpuMilli += parseCpuToMilli(lim.cpu); hasLimCpu = true; }
    if (req.memory) { reqMemMi += parseMemoryToMi(req.memory); hasReqMem = true; }
    if (lim.memory) { limMemMi += parseMemoryToMi(lim.memory); hasLimMem = true; }
  }
  return {
    reqCpuMilli: hasReqCpu ? reqCpuMilli : null,
    limCpuMilli: hasLimCpu ? limCpuMilli : null,
    reqMemMi: hasReqMem ? reqMemMi : null,
    limMemMi: hasLimMem ? limMemMi : null,
  };
}

function rolloutSummaryFromItem(item) {
  if (!["Deployment", "ReplicaSet"].includes(item.kind)) return undefined;
  const ann = item.metadata?.annotations || {};
  const owners = (item.metadata?.ownerReferences || []).map(o => `${o.kind}/${o.name}`);
  return { revision: ann["deployment.kubernetes.io/revision"] || "", changeCause: ann["kubernetes.io/change-cause"] || "", owners };
}

function itemKindFromListKind(listKind) {
  if (!listKind || typeof listKind !== "string" || !listKind.endsWith("List")) return "";
  const base = listKind.slice(0, -4);
  return KINDS[base] ? base : "";
}

export function buildEdges(nodes, rawItems) {
  const edges = [];
  let eid = 0;
  const ids = new Set(nodes.map(n => n.id));
  const mkId = (kind, ns, name) => `${kind.toLowerCase()}-${ns || "default"}-${name}`;

  for (const item of rawItems) {
    const kind = item.kind;
    const ns = item.metadata?.namespace || "default";
    const src = item._id;

    if (kind === "Ingress") {
      for (const rule of item.spec?.rules || []) {
        for (const path of rule.http?.paths || []) {
          const svc = path.backend?.service?.name || path.backend?.serviceName;
          if (svc) {
            const t = mkId("service", ns, svc);
            if (ids.has(t)) edges.push({ id: `e${eid++}`, source: src, target: t, type: "routes", label: path.path || "/" });
          }
        }
      }
    }

    if (kind === "Service") {
      const sel = item.spec?.selector || {};
      const keys = Object.keys(sel);
      if (keys.length) {
        nodes.filter(n => n.kind === "Pod" && n.namespace === ns).forEach(pod => {
          if (keys.every(k => pod.labels?.[k] === sel[k])) edges.push({ id: `e${eid++}`, source: src, target: pod.id, type: "selects" });
        });
      }
    }

    if (kind === "Pod") {
      for (const o of item.metadata?.ownerReferences || []) {
        const oid = mkId(o.kind, ns, o.name);
        if (ids.has(oid)) edges.push({ id: `e${eid++}`, source: oid, target: src, type: "owns" });
      }
    }

    if (kind === "Pod" && item.spec?.nodeName) {
      const t = mkId("node", "cluster", item.spec.nodeName);
      if (ids.has(t)) edges.push({ id: `e${eid++}`, source: t, target: src, type: "hosts" });
    }

    if (["Deployment", "StatefulSet", "DaemonSet"].includes(kind)) {
      const spec = item.spec?.template?.spec || {};
      for (const v of spec.volumes || []) {
        if (v.configMap) { const t = mkId("configmap", ns, v.configMap.name); if (ids.has(t)) edges.push({ id: `e${eid++}`, source: src, target: t, type: "uses" }); }
        if (v.secret) { const t = mkId("secret", ns, v.secret.secretName); if (ids.has(t)) edges.push({ id: `e${eid++}`, source: src, target: t, type: "uses" }); }
        if (v.persistentVolumeClaim) { const t = mkId("persistentvolumeclaim", ns, v.persistentVolumeClaim.claimName); if (ids.has(t)) edges.push({ id: `e${eid++}`, source: src, target: t, type: "uses" }); }
      }
      for (const c of [...(spec.containers || []), ...(spec.initContainers || [])]) {
        for (const ef of c.envFrom || []) {
          if (ef.configMapRef) { const t = mkId("configmap", ns, ef.configMapRef.name); if (ids.has(t)) edges.push({ id: `e${eid++}`, source: src, target: t, type: "uses" }); }
          if (ef.secretRef) { const t = mkId("secret", ns, ef.secretRef.name); if (ids.has(t)) edges.push({ id: `e${eid++}`, source: src, target: t, type: "uses" }); }
        }
      }
    }

    if (kind === "HorizontalPodAutoscaler") {
      const ref = item.spec?.scaleTargetRef;
      if (ref?.kind && ref?.name) {
        const t = mkId(ref.kind, ns, ref.name);
        if (ids.has(t)) edges.push({ id: `e${eid++}`, source: src, target: t, type: "scales" });
      }
    }

    if (kind === "PodDisruptionBudget") {
      const ml = item.spec?.selector?.matchLabels;
      if (ml && Object.keys(ml).length) {
        for (const n of nodes) {
          if (!["Deployment", "StatefulSet", "ReplicaSet"].includes(n.kind) || n.namespace !== ns) continue;
          const tl = Object.keys(n.templateLabels || {}).length ? n.templateLabels : n.labels;
          if (Object.keys(ml).every(k => tl?.[k] === ml[k])) edges.push({ id: `e${eid++}`, source: src, target: n.id, type: "disrupts" });
        }
      }
    }

    if (kind === "NetworkPolicy") {
      const sel = item.spec?.podSelector?.matchLabels || {};
      const keys = Object.keys(sel);
      if (keys.length) {
        nodes.filter(n => n.kind === "Pod" && n.namespace === ns).forEach(pod => {
          if (keys.every(k => pod.labels?.[k] === sel[k])) edges.push({ id: `e${eid++}`, source: src, target: pod.id, type: "policies" });
        });
      }
    }
  }

  const seen = new Set();
  return edges.filter(e => {
    const k = `${e.source}→${e.target}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function dedupeEdges(edges) {
  const seen = new Set();
  return edges.filter(e => {
    const k = `${e.source}|${e.target}|${e.type}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function parseKubectl(jsonStr) {
  const data = JSON.parse(jsonStr);
  const items = data.items || (data.kind !== "List" ? [data] : []);
  const fallbackKind = itemKindFromListKind(data.kind);
  const nodes = [];
  const rawItems = [];

  for (const item of items) {
    const k = item.kind || fallbackKind;
    if (!k || !KINDS[k]) continue;
    const full = { ...item, kind: k };
    const ns = k === "Node" ? "cluster" : (item.metadata?.namespace || "default");
    const id = `${k.toLowerCase()}-${ns}-${item.metadata.name}`;
    const tplLabels = ["Deployment", "StatefulSet", "ReplicaSet", "DaemonSet"].includes(k)
      ? (item.spec?.template?.metadata?.labels || {})
      : {};

    nodes.push({
      id, kind: k, name: item.metadata.name, namespace: ns,
      labels: item.metadata.labels || {},
      templateLabels: tplLabels,
      status: getStatus(full),
      restarts: getRestarts(full),
      cpuPercent: item._cpuPercent,
      metricsCpuMilli: item._metricsCpuMilli,
      nodeName: k === "Pod" ? item.spec?.nodeName : undefined,
      nodeReady: k === "Node" ? ((item.status?.conditions || []).find(c => c.type === "Ready")?.status === "True") : undefined,
      nodeRoles: k === "Node" ? nodeRolesFromItem(full) : undefined,
      nodePressure: k === "Node" ? nodePressureFromItem(full) : undefined,
      nodeVersion: k === "Node" ? item.status?.nodeInfo?.kubeletVersion : undefined,
      resources: ["Pod", "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet"].includes(k) ? resourceSummaryFromPodSpec(k === "Pod" ? item.spec : item.spec?.template?.spec) : undefined,
      rollout: ["Deployment", "ReplicaSet"].includes(k) ? rolloutSummaryFromItem(full) : undefined,
      podContainers: k === "Pod" ? podContainerNamesFromSpec(full) : undefined,
      podImageInfo: k === "Pod" ? podImageInfoFromItem(full) : undefined,
    });
    rawItems.push({ ...full, _id: id });
  }

  const baseEdges = buildEdges(nodes, rawItems);
  const azureGraph = buildAzureDependencyGraph(rawItems);
  let merged = [...baseEdges, ...azureGraph.edges];
  merged = augmentAzureEdgesToPods(rawItems, merged);
  merged = dedupeEdges(merged);

  return {
    nodes: [...nodes, ...azureGraph.nodes],
    edges: merged,
  };
}

export function mergePodMetricsFromApi(items, metricsDoc) {
  if (!metricsDoc?.items?.length) return;
  const usageNano = new Map();
  for (const it of metricsDoc.items) {
    const ns = it.metadata?.namespace;
    const nm = it.metadata?.name;
    if (!ns || !nm) continue;
    let nano = 0;
    for (const c of it.containers || []) {
      const cpu = c.usage?.cpu || "0";
      if (typeof cpu === "string") {
        if (cpu.endsWith("n")) nano += parseInt(cpu, 10) || 0;
        else if (cpu.endsWith("u")) nano += (parseFloat(cpu) || 0) * 1e3;
        else if (cpu.endsWith("m")) nano += (parseFloat(cpu) || 0) * 1e6;
        else nano += (parseFloat(cpu) || 0) * 1e9;
      }
    }
    usageNano.set(`${ns}/${nm}`, nano);
  }
  for (const item of items) {
    if (item.kind !== "Pod") continue;
    const ns = item.metadata?.namespace;
    const nm = item.metadata?.name;
    const nano = usageNano.get(`${ns}/${nm}`);
    if (nano == null) continue;
    let limNano = 0;
    let hasLim = true;
    for (const c of item.spec?.containers || []) {
      const lim = c.resources?.limits?.cpu;
      if (!lim) { hasLim = false; break; }
      if (typeof lim === "string") {
        if (lim.endsWith("m")) limNano += (parseFloat(lim) || 0) * 1e6;
        else limNano += (parseFloat(lim) || 0) * 1e9;
      }
    }
    if (hasLim && limNano > 0) item._cpuPercent = Math.min(100, Math.round((nano / limNano) * 100));
    else item._metricsCpuMilli = Math.round(nano / 1e6);
  }
}
