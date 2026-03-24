import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { CLUSTER_PRESETS, resolvePresetApiBase } from "./utils/cluster-presets.js";
import {
  parseKubeconfigYaml, listKubeconfigContexts, resolveKubeconfigContext,
  loadKubeconfigFromStorage, saveKubeconfigToStorage, clearKubeconfigStorage,
} from "./utils/kubeconfig-utils.js";
import {
  fetchMeshTrafficStats, mergeTrafficIntoGraph, formatShortRps,
  MESH_PROFILES, topInboundServices, detectMeshProfileId,
} from "./utils/mesh-prometheus.js";
import { KINDS, EDGE_COLORS, HEALTH_COLORS } from "./constants/theme.js";
import { DEMO } from "./constants/demo.js";
import { analyzeHealth, nodeHealthLevel } from "./utils/health.js";
import { parseKubectl, mergePodMetricsFromApi } from "./utils/kubectl.js";
import { enrichGraphData, dependencyImpactForNode, eventsForSelectedNode, rolloutRelatedNodes, pickInitialNamespace } from "./utils/graph.js";
import { exportTopologySvg, exportTableCsv } from "./utils/export.js";
import { loadSnapshotHistory, saveSnapshotHistory, makeSnapshot, compareGraphToSnapshot } from "./utils/snapshot.js";
import { isLocalViteDev, isUiServedViaTopologyPod, normalizeKubernetesListBase, kubernetesListFetchUrl, fetchClusterEvents, fetchPodLogTail } from "./utils/network.js";
import { useGraph } from "./hooks/useGraph.js";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts.js";
import { Sidebar } from "./components/Sidebar.jsx";
import { DetailPanel } from "./components/DetailPanel.jsx";

function prometheusUrlInitial() {
  if (typeof window === "undefined") return "";
  const o = window.location.origin.replace(/\/$/, "");
  const autoProm = `${o}/prometheus`;
  if (isUiServedViaTopologyPod()) return autoProm;
  try {
    const saved = localStorage.getItem("k8s-topology-prometheus-url");
    if (saved != null && saved.trim()) return saved.trim();
  } catch { /* */ }
  return autoProm;
}

function meshProfileInitial() {
  if (typeof window === "undefined") return "auto";
  if (isUiServedViaTopologyPod()) return "auto";
  try {
    const s = localStorage.getItem("k8s-topology-mesh-profile");
    if (s && MESH_PROFILES[s]) return s;
  } catch { /* */ }
  return "auto";
}

const ghostBtn = (label, action) => (
  <button onClick={action} style={{ background: "#0F172A", border: "1px solid #1E293B", color: "#94A3B8", borderRadius: 8, padding: "9px 18px", cursor: "pointer", fontSize: 13 }}>{label}</button>
);

export default function App() {
  const [screen, setScreen] = useState("home");
  const [graphData, setGraphData] = useState(null);
  const [selected, setSelected] = useState(null);
  const [nsFilter, setNsFilter] = useState("default");
  const [typeFilters, setTypeFilters] = useState(() => new Set(["Pod", "Node", "AzureService"]));
  const [nameFilter, setNameFilter] = useState("");
  const [healthFilter, setHealthFilter] = useState("all");
  const [rawInput, setRawInput] = useState("");
  const [apiUrl, setApiUrl] = useState(() => {
    if (typeof window === "undefined") return "http://127.0.0.1:8001";
    if (isLocalViteDev()) return "http://127.0.0.1:8001";
    return `${window.location.origin.replace(/\/$/, "")}/k8s-api`;
  });
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState(true);
  const [clusterPresetId, setClusterPresetId] = useState(() => CLUSTER_PRESETS[0]?.id || "");
  const [kubeconfigYaml, setKubeconfigYaml] = useState("");
  const [kubeContexts, setKubeContexts] = useState([]);
  const [apiFetchHeaders, setApiFetchHeaders] = useState({});
  const [inClusterBootstrap, setInClusterBootstrap] = useState(isUiServedViaTopologyPod);
  const [fetchWarnings, setFetchWarnings] = useState([]);
  const [clusterEvents, setClusterEvents] = useState([]);
  const [eventsOpen, setEventsOpen] = useState(false);
  const [lastRefreshAt, setLastRefreshAt] = useState(null);
  const [refreshIntervalSec, setRefreshIntervalSec] = useState(0);
  const [graphView, setGraphView] = useState("graph");
  const [namespaceLanes, setNamespaceLanes] = useState(false);
  const [maskSecrets, setMaskSecrets] = useState(false);
  const [snapshotBaseline, setSnapshotBaseline] = useState(null);
  const [diffSummary, setDiffSummary] = useState(null);
  const [snapshotHistory, setSnapshotHistory] = useState(loadSnapshotHistory);
  const [compareSnapshotId, setCompareSnapshotId] = useState("");
  const [podLogText, setPodLogText] = useState("");
  const [podLogLoading, setPodLogLoading] = useState(false);
  const [podLogErr, setPodLogErr] = useState("");
  const [podLogContainer, setPodLogContainer] = useState("");
  const [podLogTick, setPodLogTick] = useState(0);
  const [prometheusUrl, setPrometheusUrl] = useState(prometheusUrlInitial);
  const [meshProfile, setMeshProfile] = useState(meshProfileInitial);
  const [meshAutoResolved, setMeshAutoResolved] = useState(null);
  const [meshStats, setMeshStats] = useState(null);
  const [meshErr, setMeshErr] = useState("");
  const [meshLoading, setMeshLoading] = useState(false);
  const [meshFetchedAt, setMeshFetchedAt] = useState(null);
  const [rightPanelWidth, setRightPanelWidth] = useState(() => {
    if (typeof window === "undefined") return 278;
    try {
      const raw = sessionStorage.getItem("k8s-topology-right-panel-px");
      const n = raw ? parseInt(raw, 10) : NaN;
      if (Number.isFinite(n) && n >= 200 && n <= 900) return n;
    } catch { /* */ }
    return 278;
  });
  const rightPanelDragWRef = useRef(278);
  const autoConnectDoneRef = useRef(false);
  const fetchAPIRef = useRef(async () => {});
  const fileInputRef = useRef(null);
  const svgRef = useRef(null);
  const searchInputRef = useRef(null);

  // ── Kubeconfig persistence ──
  useEffect(() => {
    const s = loadKubeconfigFromStorage();
    if (!s.trim()) return;
    setKubeconfigYaml(s);
    try {
      const doc = parseKubeconfigYaml(s);
      setKubeContexts(listKubeconfigContexts(doc));
    } catch { setKubeContexts([]); }
  }, []);

  useEffect(() => { setNameFilter(""); setHealthFilter("all"); }, [graphData]);
  useEffect(() => { if (isUiServedViaTopologyPod()) return; try { localStorage.setItem("k8s-topology-prometheus-url", prometheusUrl); } catch { /* */ } }, [prometheusUrl]);
  useEffect(() => { if (isUiServedViaTopologyPod()) return; try { localStorage.setItem("k8s-topology-mesh-profile", meshProfile); } catch { /* */ } }, [meshProfile]);
  useEffect(() => { saveSnapshotHistory(snapshotHistory); }, [snapshotHistory]);

  // ── Mesh traffic ──
  const loadMeshTraffic = useCallback(async () => {
    if (meshProfile === "off" || !prometheusUrl.trim()) {
      setMeshStats(null); setMeshErr(""); setMeshAutoResolved(null); setMeshLoading(false);
      return;
    }
    setMeshLoading(true); setMeshErr("");
    let effective = meshProfile;
    if (meshProfile === "auto") {
      try { effective = await detectMeshProfileId(prometheusUrl.trim()); setMeshAutoResolved(effective); }
      catch { effective = "off"; setMeshAutoResolved("off"); }
    } else { setMeshAutoResolved(null); }
    if (effective === "off") { setMeshStats(null); setMeshFetchedAt(new Date()); setMeshLoading(false); return; }
    try {
      const s = await fetchMeshTrafficStats(prometheusUrl.trim(), effective);
      setMeshStats(s); setMeshFetchedAt(new Date());
    } catch (e) { setMeshErr(e.message || String(e)); setMeshStats(null); }
    finally { setMeshLoading(false); }
  }, [prometheusUrl, meshProfile]);

  // ── Panel resize ──
  useEffect(() => { rightPanelDragWRef.current = rightPanelWidth; }, [rightPanelWidth]);
  const onRightPanelResizeStart = useCallback((e) => {
    e.preventDefault();
    const startX = e.clientX, startW = rightPanelDragWRef.current;
    const maxW = typeof window !== "undefined" ? Math.min(900, Math.floor(window.innerWidth * 0.72)) : 900;
    const onMove = (ev) => { const nw = Math.min(maxW, Math.max(200, startW + (startX - ev.clientX))); rightPanelDragWRef.current = nw; setRightPanelWidth(nw); };
    const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); document.body.style.cursor = ""; document.body.style.userSelect = ""; try { sessionStorage.setItem("k8s-topology-right-panel-px", String(rightPanelDragWRef.current)); } catch { /* */ } };
    document.body.style.cursor = "ew-resize"; document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove); document.addEventListener("mouseup", onUp);
  }, []);

  // ── Filtering ──
  const shapeFiltered = useMemo(() => {
    if (!graphData) return { nodes: [], edges: [] };
    const q = nameFilter.trim().toLowerCase();
    const nameMatch = (n) => { if (!q) return true; const nm = n.name.toLowerCase(), ns = n.namespace.toLowerCase(), id = n.id.toLowerCase(); return nm.includes(q) || ns.includes(q) || id.includes(q); };
    const nonAzure = graphData.nodes.filter(n => {
      if (n.kind === "AzureService") return false;
      if (nsFilter !== "all" && n.namespace !== nsFilter) return false;
      if (!typeFilters.has(n.kind)) return false;
      return nameMatch(n);
    });
    const idSet = new Set(nonAzure.map(n => n.id));
    const azureExtra = [];
    if (typeFilters.has("AzureService")) {
      for (const n of graphData.nodes) {
        if (n.kind !== "AzureService" || !nameMatch(n)) continue;
        if (graphData.edges.some(e => e.type === "azure" && e.target === n.id && idSet.has(e.source))) azureExtra.push(n);
      }
    }
    const nodes = [...nonAzure, ...azureExtra];
    const ids = new Set(nodes.map(n => n.id));
    return { nodes, edges: graphData.edges.filter(e => ids.has(e.source) && ids.has(e.target)) };
  }, [graphData, nsFilter, typeFilters, nameFilter]);

  const issues = useMemo(() => analyzeHealth(shapeFiltered.nodes, shapeFiltered.edges), [shapeFiltered]);

  const filtered = useMemo(() => {
    if (healthFilter === "all") return shapeFiltered;
    const nodes = shapeFiltered.nodes.filter(n => nodeHealthLevel(n.id, issues) === healthFilter);
    const ids = new Set(nodes.map(n => n.id));
    return { nodes, edges: shapeFiltered.edges.filter(e => ids.has(e.source) && ids.has(e.target)) };
  }, [shapeFiltered, healthFilter, issues]);

  const graphWithTraffic = useMemo(() => {
    if (!meshStats || meshProfile === "off") return filtered;
    return mergeTrafficIntoGraph(filtered, meshStats);
  }, [filtered, meshStats, meshProfile]);

  const detailNode = useMemo(() => { if (!selected) return null; return graphWithTraffic.nodes.find(n => n.id === selected.id) || selected; }, [selected, graphWithTraffic]);
  const hotServices = useMemo(() => topInboundServices(meshStats, 8), [meshStats]);
  const dependencyImpact = useMemo(() => dependencyImpactForNode(selected?.id, graphWithTraffic.nodes, graphWithTraffic.edges), [selected?.id, graphWithTraffic]);
  const historyDiff = useMemo(() => compareGraphToSnapshot(graphData, snapshotHistory.find(s => s.id === compareSnapshotId) || null), [graphData, snapshotHistory, compareSnapshotId]);
  const selectedEvents = useMemo(() => eventsForSelectedNode(detailNode || selected, clusterEvents), [detailNode, selected, clusterEvents]);
  const rolloutNodes = useMemo(() => rolloutRelatedNodes(detailNode || selected, graphWithTraffic.nodes), [detailNode, selected, graphWithTraffic]);
  const selectedAzureDeps = useMemo(() => {
    const current = detailNode || selected;
    if (!current) return [];
    return graphWithTraffic.edges.filter(e => e.source === current.id && e.type === "azure").map(e => graphWithTraffic.nodes.find(n => n.id === e.target)).filter(Boolean);
  }, [detailNode, selected, graphWithTraffic]);

  useEffect(() => { if (!selected) return; if (filtered.nodes.some(n => n.id === selected.id)) return; setSelected(null); }, [filtered, selected]);
  useEffect(() => { if (meshProfile === "off") { setMeshStats(null); setMeshErr(""); setMeshAutoResolved(null); } }, [meshProfile]);

  const critCount = issues.filter(i => i.level === "critical").length;
  const warnCount = issues.filter(i => i.level === "warning").length;
  const infoCount = issues.filter(i => i.level === "info").length;

  useGraph(svgRef, graphView === "graph" ? graphWithTraffic.nodes : [], graphView === "graph" ? graphWithTraffic.edges : [], issues, selected?.id, n => setSelected(n), { namespaceLanes, maskSecrets });

  const namespaces = useMemo(() => [...new Set((graphData?.nodes || []).map(n => n.namespace))].sort(), [graphData]);
  const nsSelectValue = useMemo(() => { if (nsFilter === "all") return "all"; if (namespaces.includes(nsFilter)) return nsFilter; return "all"; }, [nsFilter, namespaces]);
  useEffect(() => { if (!graphData?.nodes?.length) return; if (nsFilter !== "all" && !namespaces.includes(nsFilter)) setNsFilter(pickInitialNamespace(graphData.nodes)); }, [graphData, namespaces, nsFilter]);

  // ── Pod logs ──
  useEffect(() => { if (!selected || selected.kind !== "Pod") { setPodLogContainer(""); return; } setPodLogContainer(selected.podContainers?.[0] || ""); }, [selected?.id, selected?.kind]);
  useEffect(() => {
    if (screen !== "graph" || !selected || selected.kind !== "Pod") { setPodLogText(""); setPodLogErr(""); setPodLogLoading(false); return; }
    if (selected.sampleLog) { setPodLogText(selected.sampleLog); setPodLogErr(""); setPodLogLoading(false); return; }
    let cancelled = false;
    (async () => {
      setPodLogLoading(true); setPodLogErr("");
      try {
        const cont = podLogContainer || selected.podContainers?.[0] || "";
        const txt = await fetchPodLogTail(apiUrl, apiFetchHeaders, selected.namespace, selected.name, cont);
        if (!cancelled) setPodLogText(txt);
      } catch (e) { if (!cancelled) setPodLogErr(e.message || String(e)); }
      finally { if (!cancelled) setPodLogLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [screen, selected?.id, selected?.kind, podLogContainer, apiUrl, apiFetchHeaders, podLogTick]);

  const kindCounts = useMemo(() => {
    const c = {};
    if (!graphData) return c;
    const q = nameFilter.trim().toLowerCase();
    const nameMatch = (n) => { if (!q) return true; return n.name.toLowerCase().includes(q) || n.namespace.toLowerCase().includes(q) || n.id.toLowerCase().includes(q); };
    const idInNs = new Set(graphData.nodes.filter(n => { if (n.kind === "AzureService") return false; if (nsFilter !== "all" && n.namespace !== nsFilter) return false; return nameMatch(n); }).map(n => n.id));
    for (const n of graphData.nodes) {
      if (n.kind === "AzureService") { if (!nameMatch(n)) continue; if (nsFilter !== "all") { if (!graphData.edges.some(e => e.type === "azure" && e.target === n.id && idInNs.has(e.source))) continue; } c[n.kind] = (c[n.kind] || 0) + 1; continue; }
      if (nsFilter !== "all" && n.namespace !== nsFilter) continue;
      if (!nameMatch(n)) continue;
      c[n.kind] = (c[n.kind] || 0) + 1;
    }
    return c;
  }, [graphData, nsFilter, nameFilter]);

  // ── Actions ──
  const loadDemo = () => { setErr(""); const g = enrichGraphData(DEMO); setGraphData(g); setSelected(null); setNsFilter(pickInitialNamespace(g.nodes)); setScreen("graph"); void loadMeshTraffic(); };
  const applyInput = () => { setErr(""); try { const p = enrichGraphData(parseKubectl(rawInput)); setGraphData(p); setSelected(null); setNsFilter(pickInitialNamespace(p.nodes)); setScreen("graph"); void loadMeshTraffic(); } catch (e) { setErr("JSON hatası: " + e.message); } };

  const fetchAPI = useCallback(async (apiBaseOverride, opts = {}) => {
    setLoading(true); setErr("");
    const results = []; const hdr = { ...apiFetchHeaders, ...(opts.headers || {}) }; const failures = [];
    const baseRaw = (apiBaseOverride ?? apiUrl).replace(/\/$/, "");
    const base = normalizeKubernetesListBase(baseRaw, hdr);
    const collect = async (pathSuffix, kindName) => {
      const url = kubernetesListFetchUrl(base, pathSuffix);
      try {
        const r = await fetch(url, { headers: hdr, cache: "no-store", credentials: "omit" });
        if (!r.ok) { let detail = ""; try { const t = await r.text(); if (t) detail = t.slice(0, 180); } catch { /* */ } failures.push(`${pathSuffix} → HTTP ${r.status}${detail ? `: ${detail}` : ""}`); return; }
        const text = await r.text();
        if (!text) return;
        const d = JSON.parse(text);
        if (!Array.isArray(d.items)) return;
        for (const it of d.items) results.push({ ...it, kind: it.kind || kindName });
      } catch (e) { failures.push(`${pathSuffix}: ${e.message || String(e)}`); }
    };
    await Promise.all([collect("/api/v1/pods", "Pod"), collect("/api/v1/nodes", "Node"), collect("/api/v1/services", "Service"), collect("/api/v1/configmaps", "ConfigMap"), collect("/api/v1/secrets", "Secret"), collect("/api/v1/persistentvolumeclaims", "PersistentVolumeClaim")]);
    await Promise.all([collect("/apis/apps/v1/deployments", "Deployment"), collect("/apis/apps/v1/statefulsets", "StatefulSet"), collect("/apis/apps/v1/daemonsets", "DaemonSet"), collect("/apis/apps/v1/replicasets", "ReplicaSet")]);
    await collect("/apis/networking.k8s.io/v1/ingresses", "Ingress");
    await Promise.all([collect("/apis/batch/v1/jobs", "Job"), collect("/apis/batch/v1/cronjobs", "CronJob")]);
    await Promise.all([collect("/apis/autoscaling/v2/horizontalpodautoscalers", "HorizontalPodAutoscaler"), collect("/apis/policy/v1/poddisruptionbudgets", "PodDisruptionBudget"), collect("/apis/networking.k8s.io/v1/networkpolicies", "NetworkPolicy")]);
    try { const mUrl = kubernetesListFetchUrl(base, "/apis/metrics.k8s.io/v1/pods"); const mr = await fetch(mUrl, { headers: hdr, cache: "no-store", credentials: "omit" }); if (mr.ok) { const md = await mr.json(); mergePodMetricsFromApi(results, md); } } catch { /* */ }
    let ev = []; try { ev = await fetchClusterEvents(base, hdr); } catch { ev = []; }
    setClusterEvents(ev);
    if (!results.length) {
      setFetchWarnings([]);
      const corsHint = hdr.Authorization ? " Doğrudan token ile çağrıda CORS engeli olabilir; kubectl proxy --port=8001 deneyin." : "";
      setErr("API'den kayıt alınamadı (liste boş veya tüm istekler başarısız)." + corsHint + (failures.length ? ` Detay: ${failures.slice(0, 3).join(" · ")}` : ""));
      setMeshStats(null); setLoading(false); return;
    }
    setFetchWarnings(failures.length ? failures : []);
    try {
      const parsed = enrichGraphData(parseKubectl(JSON.stringify({ kind: "List", items: results })));
      setGraphData(parsed); setSelected(null); setNsFilter(pickInitialNamespace(parsed.nodes));
      setScreen("graph"); setLastRefreshAt(new Date()); void loadMeshTraffic();
    } catch (e) { setErr(e.message); }
    setLoading(false);
  }, [apiUrl, apiFetchHeaders, loadMeshTraffic]);

  fetchAPIRef.current = fetchAPI;

  useEffect(() => { if (screen !== "graph" || refreshIntervalSec <= 0) return; const id = setInterval(() => fetchAPIRef.current(), refreshIntervalSec * 1000); return () => clearInterval(id); }, [screen, refreshIntervalSec]);

  // ── Auto-connect in-cluster ──
  useEffect(() => {
    if (!isUiServedViaTopologyPod()) { setInClusterBootstrap(false); return; }
    if (autoConnectDoneRef.current) return;
    autoConnectDoneRef.current = true;
    const base = normalizeKubernetesListBase(`${window.location.origin.replace(/\/$/, "")}/k8s-api`, {});
    setApiUrl(base); setApiFetchHeaders({});
    const internalId = CLUSTER_PRESETS.find(p => p.id === "cortex-internal-aks")?.id;
    if (internalId) setClusterPresetId(internalId);
    (async () => { try { await fetchAPI(base, { headers: {} }); } finally { setInClusterBootstrap(false); } })();
  }, [fetchAPI]);

  const toggleKind = k => setTypeFilters(prev => { const s = new Set(prev); s.has(k) ? s.delete(k) : s.add(k); return s; });
  const selectAllKinds = () => setTypeFilters(new Set(Object.keys(KINDS)));
  const clearAllKinds = () => setTypeFilters(new Set());

  // ── Keyboard shortcuts ──
  useKeyboardShortcuts({
    onEscape: () => setSelected(null),
    onSearch: () => searchInputRef.current?.focus(),
    onRefresh: () => { if (screen === "graph") fetchAPI(); },
  });

  // ── Screens ──
  if (inClusterBootstrap) return (
    <div style={{ background: "#020817", minHeight: "100vh", color: "#E2E8F0", fontFamily: "system-ui,sans-serif", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: 24 }}>
      <div style={{ width: 40, height: 40, border: "3px solid #1E293B", borderTopColor: "#6366F1", borderRadius: "50%", animation: "k8s-spin .8s linear infinite" }} />
      <style>{`@keyframes k8s-spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{ fontSize: 15, fontWeight: 600, color: "#CBD5E1" }}>Bulunduğunuz kümenin API'sine bağlanılıyor…</div>
    </div>
  );

  if (screen === "home") return (
    <div style={{ background: "#020817", minHeight: "100vh", color: "#E2E8F0", fontFamily: "system-ui,sans-serif", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 28, padding: 24 }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 11, color: "#475569", letterSpacing: 3, textTransform: "uppercase", marginBottom: 8 }}>Open Source &middot; Self-Hosted</div>
        <h1 style={{ fontSize: 38, fontWeight: 800, margin: 0, background: "linear-gradient(135deg,#3B82F6,#A855F7,#EF4444)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>K8s Topology Viewer</h1>
        <p style={{ color: "#64748B", marginTop: 8, fontSize: 14 }}>Tüm kaynakları, bağlantıları, hataları ve bottleneck'leri otomatik keşfeder</p>
      </div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", justifyContent: "center" }}>
        {[
          { icon: "🎮", title: "Demo Modu", sub: "Hata & bottleneck örnekleriyle", color: "#3B82F6", action: loadDemo },
          { icon: "📋", title: "kubectl Yapıştır", sub: "kubectl get all -A -o json", color: "#A855F7", action: () => { setErr(""); setScreen("input"); } },
          { icon: "🔌", title: "Canlı API", sub: "Kümede pod proxy · yerelde kubectl proxy", color: "#22C55E", action: () => { setErr(""); setScreen("api"); } },
        ].map(({ icon, title, sub, color, action }) => (
          <div key={title} onClick={action} style={{ background: "#0F172A", border: `1px solid ${color}33`, borderRadius: 14, padding: "24px 32px", cursor: "pointer", minWidth: 185, textAlign: "center", transition: "border-color .2s" }}
            onMouseEnter={e => e.currentTarget.style.borderColor = color} onMouseLeave={e => e.currentTarget.style.borderColor = color + "33"}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>{icon}</div>
            <div style={{ fontWeight: 700, fontSize: 14, color: "#E2E8F0" }}>{title}</div>
            <div style={{ fontSize: 11, color: "#64748B", marginTop: 4 }}>{sub}</div>
          </div>
        ))}
      </div>

      {/* Cluster presets + kubeconfig */}
      <div style={{ width: "100%", maxWidth: 620, background: "#0F172A", border: "1px solid #6366F133", borderRadius: 14, padding: "18px 20px", boxSizing: "border-box", display: "flex", flexDirection: "column", gap: 16 }}>
        <div>
          <div style={{ fontSize: 11, color: "#6366F1", letterSpacing: 2, textTransform: "uppercase", marginBottom: 6 }}>Ön tanımlı küme</div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "stretch" }}>
            <select value={clusterPresetId} onChange={e => setClusterPresetId(e.target.value)} style={{ flex: "1 1 220px", minWidth: 0, background: "#020817", border: "1px solid #1E293B", borderRadius: 8, color: "#E2E8F0", fontSize: 14, padding: "10px 12px", cursor: "pointer" }}>
              <optgroup label="Ön tanımlı">{CLUSTER_PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</optgroup>
              {kubeContexts.length > 0 && <optgroup label="kubeconfig">{kubeContexts.map(c => <option key={c.name} value={`kc:${c.name}`}>{c.name}{c.hasToken ? "" : " · token yok"}</option>)}</optgroup>}
            </select>
            <button type="button" disabled={loading} onClick={async () => {
              if (clusterPresetId.startsWith("kc:")) {
                const ctxName = clusterPresetId.slice(3);
                let doc; try { doc = parseKubeconfigYaml(kubeconfigYaml); } catch { setErr("Önce geçerli kubeconfig yapıştırın."); return; }
                const r = resolveKubeconfigContext(doc, ctxName);
                if (!r) { setErr("Context çözülemedi."); return; }
                if (r.exec) { setErr("Bu context exec kullanıyor. kubectl proxy --port=8001 deneyin."); return; }
                if (r.clientCertificateData && r.clientKeyData && !r.token) { setErr("Bu context istemci sertifikası kullanıyor; kubectl proxy deneyin."); return; }
                if (!r.token) { setErr("kubeconfig içinde token yok."); return; }
                const base = r.server.replace(/\/$/, ""); setApiUrl(base);
                const auth = { Authorization: `Bearer ${r.token}` }; setApiFetchHeaders(auth); setErr("");
                await fetchAPI(base, { headers: auth }); return;
              }
              const preset = CLUSTER_PRESETS.find(p => p.id === clusterPresetId);
              const resolved = resolvePresetApiBase(preset);
              if (!resolved) { setErr("Bu küme için API adresi yok."); return; }
              setApiUrl(resolved); setApiFetchHeaders({}); setErr(""); await fetchAPI(resolved);
            }} style={{ background: "#6366F1", border: "none", color: "#fff", borderRadius: 8, padding: "10px 20px", cursor: loading ? "wait" : "pointer", fontWeight: 600, fontSize: 13, whiteSpace: "nowrap" }}>
              {loading ? "…" : "Bağlan →"}
            </button>
          </div>
        </div>
        <div style={{ borderTop: "1px solid #1E293B", paddingTop: 16 }}>
          <div style={{ fontSize: 11, color: "#22C55E", letterSpacing: 2, textTransform: "uppercase", marginBottom: 6 }}>kubeconfig</div>
          <input ref={fileInputRef} type="file" accept=".yaml,.yml,.config,text/*" style={{ display: "none" }} onChange={async (e) => {
            const f = e.target.files?.[0]; if (!f) return;
            try { const t = await f.text(); setKubeconfigYaml(t); const doc = parseKubeconfigYaml(t); setKubeContexts(listKubeconfigContexts(doc)); setErr(""); } catch (ex) { setKubeContexts([]); setErr(ex.message || String(ex)); }
            e.target.value = "";
          }} />
          <textarea value={kubeconfigYaml} onChange={e => setKubeconfigYaml(e.target.value)} placeholder="apiVersion: v1&#10;kind: Config&#10;clusters: …" spellCheck={false}
            style={{ width: "100%", minHeight: 120, boxSizing: "border-box", background: "#020817", border: "1px solid #1E293B", borderRadius: 8, color: "#E2E8F0", fontFamily: "ui-monospace,monospace", fontSize: 11, padding: 12, resize: "vertical", outline: "none", marginBottom: 10 }} />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button type="button" onClick={() => fileInputRef.current?.click()} style={{ background: "#14532D", border: "1px solid #166534", color: "#BBF7D0", borderRadius: 8, padding: "8px 14px", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Dosya seç</button>
            <button type="button" onClick={() => { try { const doc = parseKubeconfigYaml(kubeconfigYaml); setKubeContexts(listKubeconfigContexts(doc)); setErr(""); } catch (ex) { setKubeContexts([]); setErr(ex.message || String(ex)); } }} style={{ background: "#0F172A", border: "1px solid #334155", color: "#CBD5E1", borderRadius: 8, padding: "8px 14px", cursor: "pointer", fontSize: 12 }}>Context listesini güncelle</button>
            <button type="button" onClick={() => { saveKubeconfigToStorage(kubeconfigYaml); setErr(""); }} style={{ background: "#0F172A", border: "1px solid #334155", color: "#CBD5E1", borderRadius: 8, padding: "8px 14px", cursor: "pointer", fontSize: 12 }}>Tarayıcıda sakla</button>
            <button type="button" onClick={() => { clearKubeconfigStorage(); setKubeconfigYaml(""); setKubeContexts([]); setErr(""); }} style={{ background: "#450A0A", border: "1px solid #7F1D1D", color: "#FCA5A5", borderRadius: 8, padding: "8px 14px", cursor: "pointer", fontSize: 12 }}>Temizle</button>
          </div>
        </div>
        {err && <div style={{ color: "#FCA5A5", fontSize: 13, background: "#450A0A", padding: "10px 12px", borderRadius: 8 }}>{err}</div>}
      </div>
      {/* Health legend */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center", maxWidth: 580 }}>
        {[
          { l: "🔴 Critical", c: "#EF4444", t: "CrashLoop, OOMKilled, Evicted, PVC sorunları" },
          { l: "🟡 Warning", c: "#F59E0B", t: "Pending, PartialReady, Yüksek CPU/Memory" },
          { l: "🔵 Info", c: "#60A5FA", t: "Orphan kaynak, HighFanOut bottleneck" },
          { l: "🟢 OK", c: "#22C55E", t: "Sağlıklı kaynaklar" },
        ].map(({ l, c, t }) => (
          <div key={l} style={{ background: "#0F172A", border: `1px solid ${c}33`, borderRadius: 8, padding: "8px 14px", textAlign: "center", flex: "1 1 200px" }}>
            <div style={{ fontWeight: 600, fontSize: 12, color: c }}>{l}</div>
            <div style={{ fontSize: 10, color: "#475569", marginTop: 3 }}>{t}</div>
          </div>
        ))}
      </div>
    </div>
  );

  if (screen === "input") return (
    <div style={{ background: "#020817", minHeight: "100vh", color: "#E2E8F0", fontFamily: "system-ui,sans-serif", display: "flex", flexDirection: "column", padding: 24, gap: 14, maxWidth: 800, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>{ghostBtn("← Geri", () => setScreen("home"))}<h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>kubectl Çıktısını Yapıştır</h2></div>
      <div style={{ background: "#0F172A", borderRadius: 10, padding: 14, border: "1px solid #1E293B", fontSize: 13 }}>
        <code style={{ color: "#A855F7", display: "block", marginBottom: 4 }}>kubectl get all,ingresses,configmaps,secrets,pvc -A -o json</code>
        <span style={{ color: "#64748B", fontSize: 11 }}>çıktısını aşağıya yapıştırın</span>
      </div>
      <textarea value={rawInput} onChange={e => setRawInput(e.target.value)} placeholder='{"kind":"List","items":[...]}'
        style={{ flex: 1, minHeight: 320, background: "#0F172A", border: "1px solid #1E293B", borderRadius: 10, color: "#E2E8F0", fontFamily: "monospace", fontSize: 12, padding: 14, resize: "vertical", outline: "none" }} />
      {err && <div style={{ color: "#EF4444", fontSize: 13, background: "#450A0A", padding: "8px 14px", borderRadius: 8 }}>{err}</div>}
      <div style={{ display: "flex", gap: 10 }}>
        <button onClick={applyInput} style={{ background: "#3B82F6", border: "none", color: "#fff", borderRadius: 8, padding: "9px 20px", cursor: "pointer", fontWeight: 600, fontSize: 13 }}>Görselleştir →</button>
        {ghostBtn("Demo", loadDemo)}
      </div>
    </div>
  );

  if (screen === "api") return (
    <div style={{ background: "#020817", minHeight: "100vh", color: "#E2E8F0", fontFamily: "system-ui,sans-serif", display: "flex", flexDirection: "column", padding: 24, gap: 14, maxWidth: 620, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>{ghostBtn("← Geri", () => setScreen("home"))}<h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Kubernetes API Bağlantısı</h2></div>
      <div style={{ background: "#0F172A", borderRadius: 10, padding: 14, border: "1px solid #1E293B", fontSize: 13 }}>
        <div style={{ color: "#22C55E", fontWeight: 600, marginBottom: 6 }}>Yerel geliştirme:</div>
        <code style={{ color: "#E2E8F0", background: "#020817", display: "block", padding: "8px 12px", borderRadius: 6, marginBottom: 10 }}>kubectl proxy --port=8001</code>
      </div>
      <div><label style={{ fontSize: 12, color: "#64748B", display: "block", marginBottom: 6 }}>API URL</label>
        <input value={apiUrl} onChange={e => setApiUrl(e.target.value)} style={{ width: "100%", background: "#0F172A", border: "1px solid #1E293B", borderRadius: 8, color: "#E2E8F0", fontSize: 14, padding: "10px 14px", outline: "none", boxSizing: "border-box" }} /></div>
      {err && <div style={{ color: "#EF4444", fontSize: 13, background: "#450A0A", padding: "8px 14px", borderRadius: 8 }}>{err}</div>}
      <div style={{ display: "flex", gap: 10 }}>
        <button onClick={() => fetchAPI()} style={{ background: "#22C55E", border: "none", color: "#000", borderRadius: 8, padding: "9px 20px", cursor: "pointer", fontWeight: 600, fontSize: 13 }}>{loading ? "Bağlanıyor..." : "Bağlan ve Keşfet →"}</button>
        {ghostBtn("Demo", loadDemo)}
      </div>
    </div>
  );

  // ── GRAPH SCREEN ──
  return (
    <div style={{ display: "flex", height: "100vh", background: "#020817", color: "#E2E8F0", fontFamily: "system-ui,sans-serif", overflow: "hidden" }}>
      <Sidebar
        filtered={filtered} issues={issues} nameFilter={nameFilter} setNameFilter={setNameFilter}
        healthFilter={healthFilter} setHealthFilter={setHealthFilter} nsFilter={nsFilter}
        nsSelectValue={nsSelectValue} setNsFilter={setNsFilter} namespaces={namespaces}
        typeFilters={typeFilters} toggleKind={toggleKind} selectAllKinds={selectAllKinds}
        clearAllKinds={clearAllKinds} kindCounts={kindCounts} searchInputRef={searchInputRef}
      />

      {/* Canvas */}
      <div style={{ flex: 1, position: "relative", overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {fetchWarnings.length > 0 && (
          <div style={{ flexShrink: 0, background: "#422006", borderBottom: "1px solid #D97706", color: "#FDE68A", fontSize: 11, padding: "6px 12px", lineHeight: 1.4 }}>
            <b>Kısmi API uyarısı</b> — {fetchWarnings.length} istek başarısız
          </div>
        )}
        <div style={{ position: "absolute", top: fetchWarnings.length ? 44 : 12, left: 12, right: 12, zIndex: 10, display: "flex", flexDirection: "column", gap: 6 }}>
          {/* Toolbar row 1 */}
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            {ghostBtn("← Menü", () => { setScreen("home"); setSelected(null); })}
            {ghostBtn("📋 Yeni", () => setScreen("input"))}
            {ghostBtn(loading ? "…" : "Yenile (r)", () => fetchAPI())}
            <select value={String(refreshIntervalSec)} onChange={e => setRefreshIntervalSec(Number(e.target.value))} style={{ background: "#0F172A", border: "1px solid #1E293B", borderRadius: 6, color: "#94A3B8", fontSize: 11, padding: "4px 8px", cursor: "pointer" }}>
              <option value="0">Otomatik kapalı</option>
              <option value="30">30 sn</option>
              <option value="60">1 dk</option>
              <option value="120">2 dk</option>
            </select>
            {lastRefreshAt && <span style={{ fontSize: 10, color: "#475569" }}>Son: {lastRefreshAt.toLocaleTimeString()}</span>}
            {critCount > 0 && <div style={{ background: "#7F1D1D", border: "1px solid #EF4444", borderRadius: 20, padding: "3px 10px", fontSize: 11, color: "#FCA5A5", fontWeight: 700 }}>🔴 {critCount}</div>}
            {warnCount > 0 && <div style={{ background: "#451A03", border: "1px solid #F59E0B", borderRadius: 20, padding: "3px 10px", fontSize: 11, color: "#FCD34D", fontWeight: 700 }}>🟡 {warnCount}</div>}
            {infoCount > 0 && <div style={{ background: "#0C1A3A", border: "1px solid #60A5FA", borderRadius: 20, padding: "3px 10px", fontSize: 11, color: "#93C5FD", fontWeight: 700 }}>🔵 {infoCount}</div>}
          </div>
          {/* Toolbar row 2 */}
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ display: "flex", border: "1px solid #1E293B", borderRadius: 6, overflow: "hidden" }}>
              <button type="button" onClick={() => setGraphView("graph")} style={{ background: graphView === "graph" ? "#1E3A5F" : "#0F172A", border: "none", color: graphView === "graph" ? "#60A5FA" : "#64748B", padding: "4px 10px", fontSize: 11, cursor: "pointer" }}>Grafik</button>
              <button type="button" onClick={() => setGraphView("table")} style={{ background: graphView === "table" ? "#1E3A5F" : "#0F172A", border: "none", color: graphView === "table" ? "#60A5FA" : "#64748B", padding: "4px 10px", fontSize: 11, cursor: "pointer" }}>Tablo</button>
            </div>
            {ghostBtn("SVG indir", () => exportTopologySvg(svgRef.current))}
            {ghostBtn("CSV indir", () => exportTableCsv(filtered.nodes, issues, nodeHealthLevel, maskSecrets))}
            {ghostBtn("Anlık kaydet", () => {
              if (!graphData) return;
              setSnapshotBaseline({ ids: [...new Set(graphData.nodes.map(n => n.id))].sort(), t: Date.now() });
              const snap = makeSnapshot(graphData);
              setSnapshotHistory(prev => [snap, ...prev.filter(s => s.id !== snap.id)].slice(0, 12));
              setCompareSnapshotId(snap.id); setDiffSummary(null);
            })}
            {ghostBtn("Karşılaştır", () => {
              if (!snapshotBaseline || !graphData) { setDiffSummary(null); return; }
              const now = new Set(graphData.nodes.map(n => n.id));
              const baseline = new Set(snapshotBaseline.ids);
              let added = 0, removed = 0;
              for (const id of now) if (!baseline.has(id)) added++;
              for (const id of baseline) if (!now.has(id)) removed++;
              setDiffSummary({ added, removed, total: graphData.nodes.length });
            })}
            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "#64748B", cursor: "pointer" }}>
              <input type="checkbox" checked={namespaceLanes} onChange={e => setNamespaceLanes(e.target.checked)} /> NS şeridi
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "#64748B", cursor: "pointer" }}>
              <input type="checkbox" checked={maskSecrets} onChange={e => setMaskSecrets(e.target.checked)} /> Secret gizle
            </label>
            {diffSummary && <span style={{ fontSize: 10, color: "#A78BFA" }}>Δ +{diffSummary.added} / −{diffSummary.removed} (toplam {diffSummary.total})</span>}
          </div>
          {/* Toolbar row 3 - snapshots */}
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 10, color: "#475569", textTransform: "uppercase", letterSpacing: 0.5 }}>Geçmiş</span>
            <select value={compareSnapshotId} onChange={e => setCompareSnapshotId(e.target.value)} style={{ background: "#0F172A", border: "1px solid #1E293B", borderRadius: 6, color: "#94A3B8", fontSize: 11, padding: "4px 8px", cursor: "pointer", minWidth: 220 }}>
              <option value="">Snapshot seçin</option>
              {snapshotHistory.map(s => <option key={s.id} value={s.id}>{new Date(s.createdAt).toLocaleString()} &middot; {s.total} kaynak</option>)}
            </select>
            {historyDiff && <span style={{ fontSize: 10, color: "#CBD5E1" }}>Eklenen {historyDiff.added.length} &middot; Silinen {historyDiff.removed.length} &middot; Durum değişen {historyDiff.changed.length}</span>}
          </div>
          {/* Toolbar row 4 - mesh */}
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", maxWidth: "100%" }}>
            <span style={{ fontSize: 10, color: "#475569", textTransform: "uppercase", letterSpacing: 0.5 }}>Mesh / Prometheus</span>
            <select value={meshProfile} onChange={e => setMeshProfile(e.target.value)} style={{ background: "#0F172A", border: "1px solid #1E293B", borderRadius: 6, color: "#94A3B8", fontSize: 11, padding: "4px 8px", cursor: "pointer" }}>
              {Object.entries(MESH_PROFILES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            {meshProfile === "auto" && meshAutoResolved && meshAutoResolved !== "off" && <span style={{ fontSize: 10, color: "#64748B" }}>→ {MESH_PROFILES[meshAutoResolved]?.label || meshAutoResolved}</span>}
            {meshProfile === "auto" && meshAutoResolved === "off" && <span style={{ fontSize: 10, color: "#64748B" }}>→ mesh yok</span>}
            {isUiServedViaTopologyPod() ? (
              <span style={{ flex: "1 1 200px", minWidth: 160, maxWidth: 420, fontSize: 10, color: "#64748B", padding: "5px 0" }}>Prometheus: otomatik &middot; /prometheus</span>
            ) : (
              <input type="url" value={prometheusUrl} onChange={e => setPrometheusUrl(e.target.value)} placeholder="/prometheus veya tam URL"
                style={{ flex: "1 1 200px", minWidth: 160, maxWidth: 420, background: "#020817", border: "1px solid #1E293B", borderRadius: 6, color: "#E2E8F0", fontSize: 11, padding: "5px 8px", outline: "none" }} />
            )}
            {ghostBtn(meshLoading ? "Trafik…" : "Trafik yenile", () => void loadMeshTraffic())}
            {meshFetchedAt && <span style={{ fontSize: 10, color: "#22D3EE" }}>RPS: {meshFetchedAt.toLocaleTimeString()}</span>}
            {meshErr && <span style={{ fontSize: 10, color: "#F87171", maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={meshErr}>{meshErr}</span>}
          </div>
        </div>

        {graphView === "table" ? (
          <div style={{ flex: 1, overflow: "auto", marginTop: 132, padding: "8px 12px", boxSizing: "border-box" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "#64748B", borderBottom: "1px solid #1E293B" }}>
                  <th style={{ padding: "6px 8px" }}>Tür</th><th style={{ padding: "6px 8px" }}>Ad</th><th style={{ padding: "6px 8px" }}>NS</th><th style={{ padding: "6px 8px" }}>Durum</th><th style={{ padding: "6px 8px" }}>Sağlık</th>
                </tr>
              </thead>
              <tbody>
                {filtered.nodes.map(n => {
                  const h = nodeHealthLevel(n.id, issues);
                  const disp = maskSecrets && n.kind === "Secret" ? "••••" : n.name;
                  return (
                    <tr key={n.id} onClick={() => setSelected(n)} style={{ cursor: "pointer", borderBottom: "1px solid #0F172A", background: selected?.id === n.id ? "#1E293B" : "transparent" }}
                      onMouseEnter={e => { if (selected?.id !== n.id) e.currentTarget.style.background = "#0F172A"; }}
                      onMouseLeave={e => { e.currentTarget.style.background = selected?.id === n.id ? "#1E293B" : "transparent"; }}>
                      <td style={{ padding: "6px 8px", color: KINDS[n.kind]?.color, fontFamily: "monospace" }}>{KINDS[n.kind]?.tag || n.kind}</td>
                      <td style={{ padding: "6px 8px", color: "#E2E8F0" }}>{disp}</td>
                      <td style={{ padding: "6px 8px", color: "#64748B" }}>{n.namespace}</td>
                      <td style={{ padding: "6px 8px", color: "#94A3B8" }}>{n.status}</td>
                      <td style={{ padding: "6px 8px", color: HEALTH_COLORS[h] }}>{h}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <svg ref={svgRef} style={{ flex: 1, width: "100%", minHeight: 0, background: "radial-gradient(ellipse at 50% 50%, #0D1B2A 0%, #020817 100%)" }} />
        )}
        {graphView === "graph" && (
          <div style={{ position: "absolute", bottom: 16, left: 16, background: "#0F172A99", border: "1px solid #1E293B", borderRadius: 8, padding: "5px 12px", fontSize: 11, color: "#475569" }}>
            scroll=zoom &middot; drag=pan &middot; click=detay &middot; Esc=kapat &middot; /=ara &middot; r=yenile
          </div>
        )}
      </div>

      {/* Panel resize handle */}
      <div role="separator" aria-orientation="vertical" onMouseDown={onRightPanelResizeStart}
        style={{ width: 6, flexShrink: 0, cursor: "ew-resize", background: "#0c1629", borderLeft: "1px solid #1E293B", borderRight: "1px solid #1E293B" }} />

      {/* Right panel */}
      <div style={{ width: rightPanelWidth, minWidth: 200, maxWidth: 900, background: "#0A1628", display: "flex", flexDirection: "column", overflow: "hidden", flexShrink: 0 }}>
        {/* Hot services */}
        {hotServices.length > 0 && (
          <div style={{ borderBottom: "1px solid #1E293B", flexShrink: 0, padding: "8px 12px", maxHeight: 140, overflowY: "auto" }}>
            <div style={{ fontSize: 10, color: "#475569", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>Yoğun servisler (gelen)</div>
            {hotServices.map((h, i) => (
              <div key={`${h.ns}/${h.name}-${i}`} style={{ fontSize: 10, marginBottom: 4, lineHeight: 1.35 }}>
                <span style={{ color: "#22D3EE", fontFamily: "monospace" }}>{formatShortRps(h.rps)} rps</span>
                <span style={{ color: "#94A3B8" }}> &middot; {h.ns}/{h.name}</span>
                {h.errPct >= 1 && <span style={{ color: "#F87171" }}> &middot; {h.errPct.toFixed(1)}% 5xx</span>}
              </div>
            ))}
          </div>
        )}

        {/* Events */}
        <div style={{ borderBottom: "1px solid #1E293B", flexShrink: 0 }}>
          <div onClick={() => setEventsOpen(o => !o)} style={{ padding: "8px 14px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", userSelect: "none" }}>
            <span style={{ fontWeight: 600, fontSize: 12 }}>📜 Events ({clusterEvents.length})</span>
            <span style={{ color: "#64748B", fontSize: 11 }}>{eventsOpen ? "▼" : "▶"}</span>
          </div>
          {eventsOpen && (
            <div style={{ maxHeight: 160, overflowY: "auto", padding: "0 10px 8px", fontSize: 10 }}>
              {clusterEvents.length === 0 && <div style={{ color: "#475569", padding: "6px 0" }}>Kayıt yok</div>}
              {clusterEvents.slice(0, 80).map(ev => (
                <div key={ev.id} style={{ borderBottom: "1px solid #0F172A", padding: "5px 0", lineHeight: 1.35 }}>
                  <div style={{ color: ev.type === "Warning" ? "#F59E0B" : "#94A3B8", fontWeight: 600 }}>{ev.reason || "—"} <span style={{ color: "#475569", fontWeight: 400 }}>{ev.ns}</span></div>
                  <div style={{ color: "#64748B" }}>{ev.obj}</div>
                  <div style={{ color: "#CBD5E1" }}>{ev.msg}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Snapshot diff */}
        {historyDiff && (
          <div style={{ borderBottom: "1px solid #1E293B", padding: "8px 12px", flexShrink: 0 }}>
            <div style={{ fontSize: 10, color: "#475569", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>Snapshot farkı</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
              <span style={{ fontSize: 10, color: "#86EFAC" }}>+ {historyDiff.added.length}</span>
              <span style={{ fontSize: 10, color: "#FCA5A5" }}>- {historyDiff.removed.length}</span>
              <span style={{ fontSize: 10, color: "#FCD34D" }}>~ {historyDiff.changed.length}</span>
            </div>
          </div>
        )}

        {/* Alerts */}
        <div style={{ borderBottom: "1px solid #1E293B" }}>
          <div onClick={() => setAlertsOpen(o => !o)} style={{ padding: "10px 14px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", userSelect: "none" }}>
            <span style={{ fontWeight: 700, fontSize: 13 }}>⚠️ Sorunlar & Bottleneck</span>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {critCount > 0 && <span style={{ background: "#EF444422", color: "#EF4444", fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 10 }}>{critCount}</span>}
              {warnCount > 0 && <span style={{ background: "#F59E0B22", color: "#F59E0B", fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 10 }}>{warnCount}</span>}
              <span style={{ color: "#64748B", fontSize: 12 }}>{alertsOpen ? "▼" : "▶"}</span>
            </div>
          </div>
          {alertsOpen && (
            <div style={{ maxHeight: 280, overflowY: "auto", padding: "0 10px 10px" }}>
              {issues.length === 0 && <div style={{ textAlign: "center", padding: "16px 0", color: "#22C55E", fontSize: 13 }}>✅ Tüm kaynaklar sağlıklı</div>}
              {["critical", "warning", "info"].flatMap(level =>
                issues.filter(i => i.level === level).map(issue => {
                  const n = filtered.nodes.find(n => n.id === issue.id);
                  return (
                    <div key={issue.id + issue.code} onClick={() => n && setSelected(n)}
                      style={{ background: level === "critical" ? "#1C0505" : level === "warning" ? "#1C1005" : "#051525", border: `1px solid ${HEALTH_COLORS[level]}44`, borderRadius: 8, padding: "8px 10px", marginBottom: 6, cursor: "pointer" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, fontFamily: "monospace", color: HEALTH_COLORS[level], background: `${HEALTH_COLORS[level]}22`, padding: "1px 6px", borderRadius: 4 }}>{issue.code}</span>
                        {n && <span style={{ fontSize: 9, color: "#475569" }}>{n.kind}</span>}
                      </div>
                      <div style={{ fontSize: 11, color: "#E2E8F0", marginBottom: 4, lineHeight: 1.4 }}>{issue.msg}</div>
                      <div style={{ fontSize: 10, color: "#64748B", lineHeight: 1.4 }}>💡 {issue.fix}</div>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>

        {/* Detail panel */}
        <DetailPanel
          selected={selected} detailNode={detailNode} issues={issues} filtered={filtered}
          graphWithTraffic={graphWithTraffic} dependencyImpact={dependencyImpact}
          selectedEvents={selectedEvents} rolloutNodes={rolloutNodes} selectedAzureDeps={selectedAzureDeps}
          maskSecrets={maskSecrets} setSelected={setSelected}
          podLogContainer={podLogContainer} setPodLogContainer={setPodLogContainer}
          podLogLoading={podLogLoading} podLogErr={podLogErr} podLogText={podLogText}
          onPodLogRefresh={() => setPodLogTick(t => t + 1)}
        />
      </div>
    </div>
  );
}
