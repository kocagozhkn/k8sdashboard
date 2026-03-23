import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import * as d3 from "d3";
import { CLUSTER_PRESETS, resolvePresetApiBase } from "./cluster-presets.js";
import {
  parseKubeconfigYaml,
  listKubeconfigContexts,
  resolveKubeconfigContext,
  loadKubeconfigFromStorage,
  saveKubeconfigToStorage,
  clearKubeconfigStorage,
} from "./kubeconfig-utils.js";
import {
  fetchMeshTrafficStats,
  mergeTrafficIntoGraph,
  formatShortRps,
  MESH_PROFILES,
  topInboundServices,
} from "./mesh-prometheus.js";

function isLocalViteDev() {
  if (typeof window === "undefined") return false;
  const { hostname, port } = window.location;
  if (hostname !== "localhost" && hostname !== "127.0.0.1") return false;
  return port === "5173" || port === "4173";
}

/** UI Nginx’ten geliyorsa (LB, port-forward, küme hostu); Vite dev hariç */
function isUiServedViaTopologyPod() {
  if (typeof window === "undefined") return false;
  return !isLocalViteDev();
}

/** kubectl proxy listesi: Vite dışında aynı UI origin’inde /k8s-api; farklı origin’deki tam QA URL korunur; laptop :8001 yanlışlığı düzeltilir */
function normalizeKubernetesListBase(baseRaw, requestHeaders = {}) {
  const hasAuth = Boolean(requestHeaders.Authorization || requestHeaders.authorization);
  const base = (baseRaw || "").trim().replace(/\/$/, "");
  if (typeof window === "undefined") return base;
  if (hasAuth) return base;
  try {
    if (base.startsWith("http://") || base.startsWith("https://")) {
      const u = new URL(base);
      if (u.origin !== window.location.origin) {
        const laptopKubectlProxy =
          (u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.port === "8001";
        if (!laptopKubectlProxy) return base;
      }
    }
  } catch {
    /* */
  }
  if (isLocalViteDev()) return base || "http://127.0.0.1:8001";
  return `${window.location.origin.replace(/\/$/, "")}/k8s-api`;
}

/** fetch için mutlak URL (göreli çözümleme / PNA sorunlarını azaltır) */
function kubernetesListFetchUrl(baseRaw, pathSuffix) {
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

const KINDS = {
  Ingress:               { color: "#A855F7", tag: "ING" },
  Service:               { color: "#22C55E", tag: "SVC" },
  Deployment:            { color: "#3B82F6", tag: "DEP" },
  StatefulSet:           { color: "#F97316", tag: "STS" },
  DaemonSet:             { color: "#EF4444", tag: "DS"  },
  ReplicaSet:            { color: "#60A5FA", tag: "RS"  },
  Pod:                   { color: "#64748B", tag: "POD" },
  Node:                  { color: "#0EA5E9", tag: "NOD" },
  AzureService:          { color: "#2563EB", tag: "AZR" },
  ConfigMap:             { color: "#EAB308", tag: "CM"  },
  Secret:                { color: "#94A3B8", tag: "SEC" },
  PersistentVolumeClaim: { color: "#14B8A6", tag: "PVC" },
  Job:                   { color: "#8B5CF6", tag: "JOB" },
  CronJob:               { color: "#EC4899", tag: "CJ"  },
  HorizontalPodAutoscaler:{ color: "#06B6D4", tag: "HPA" },
  PodDisruptionBudget:   { color: "#F43F5E", tag: "PDB" },
  NetworkPolicy:         { color: "#84CC16", tag: "NP"  },
};

const EDGE_COLORS = { routes:"#A855F7", selects:"#22C55E", owns:"#3B82F6", uses:"#EAB308", calls:"#F97316", scales:"#06B6D4", disrupts:"#F43F5E", policies:"#84CC16", hosts:"#0EA5E9", azure:"#2563EB" };
const EDGE_LEGEND_TR = { routes:"Ingress→Svc", selects:"Service→Pod", owns:"Controller→Pod", uses:"Volume/Env", calls:"App çağrısı", scales:"HPA ölçekleme", disrupts:"PDB koruma", policies:"NetworkPolicy→Pod", hosts:"Node→Pod", azure:"Azure bağımlılığı" };
const HEALTH_COLORS = { critical:"#EF4444", warning:"#F59E0B", info:"#60A5FA", ok:"#22C55E" };
const NW = 172, NH = 66;

// ── Health analysis ──────────────────────────────────────────────────────────
function analyzeHealth(nodes, edges) {
  const issues = [];
  for (const n of nodes) {
    const s = (n.status||"").toLowerCase();
    const r = n.restarts||0, cpu = n.cpuPercent||0, mem = n.memPercent||0;

    if (n.kind === "Pod") {
      if (s==="oomkilled")        issues.push({id:n.id,level:"critical",code:"OOMKilled",     msg:`${n.name} bellek yetersizliğinden öldürüldü`,    fix:"Memory limit artırın veya memory leak araştırın"});
      if (s==="crashloopbackoff") issues.push({id:n.id,level:"critical",code:"CrashLoop",     msg:`${n.name} sürekli çöküyor`,                       fix:"kubectl logs ile uygulama loglarını inceleyin"});
      if (s==="error")            issues.push({id:n.id,level:"critical",code:"Error",         msg:`${n.name} hata durumunda`,                        fix:"kubectl describe pod ile detay bakın"});
      if (s==="evicted")          issues.push({id:n.id,level:"critical",code:"Evicted",       msg:`${n.name} node'dan tahliye edildi`,               fix:"Node kaynakları yetersiz, yeni node ekleyin"});
      if (s==="pending")          issues.push({id:n.id,level:"warning", code:"Pending",       msg:`${n.name} schedule edilemiyor`,                   fix:"Node resource, taint veya affinity kurallarını kontrol edin"});
      if (s==="terminating")      issues.push({id:n.id,level:"warning", code:"Terminating",   msg:`${n.name} uzun süredir sonlandırılıyor`,          fix:"Finalizer takılmış olabilir, force delete deneyin"});
      if (r>=10)                  issues.push({id:n.id,level:"critical",code:"HighRestarts",  msg:`${n.name} ${r} kez yeniden başladı`,              fix:"Liveness probe ve uygulama loglarını kontrol edin"});
      else if (r>=3)              issues.push({id:n.id,level:"warning", code:"Restarts",      msg:`${n.name} ${r} kez yeniden başladı`,              fix:"Pod loglarına bakın"});
      if (cpu>90)                 issues.push({id:n.id,level:"critical",code:"HighCPU",       msg:`${n.name} CPU %${cpu} kullanıyor`,                fix:"CPU limit artırın veya HPA ile scale edin"});
      else if (cpu>70)            issues.push({id:n.id,level:"warning", code:"ElevatedCPU",   msg:`${n.name} CPU %${cpu} kullanıyor`,                fix:"CPU kullanımını izlemeye devam edin"});
      if (mem>90)                 issues.push({id:n.id,level:"critical",code:"HighMemory",    msg:`${n.name} Memory %${mem} kullanıyor`,             fix:"Memory limit artırın veya memory leak araştırın"});
      else if (mem>75)            issues.push({id:n.id,level:"warning", code:"ElevatedMemory",msg:`${n.name} Memory %${mem} kullanıyor`,             fix:"Bellek tüketimini izleyin"});
    }
    if (n.kind === "Node") {
      if (n.nodeReady === false) issues.push({id:n.id,level:"critical",code:"NodeNotReady",msg:`${n.name} hazır değil`,fix:"kubectl describe node ile condition ve kubelet durumunu inceleyin"});
      if (n.nodePressure?.some(p=>p.status)) issues.push({id:n.id,level:"warning",code:"NodePressure",msg:`${n.name} kaynak baskısı altında (${n.nodePressure.filter(p=>p.status).map(p=>p.type).join(", ")})`,fix:"CPU, memory ve disk kullanımını azaltın veya node kapasitesini artırın"});
      if ((n.podCount||0) >= 40) issues.push({id:n.id,level:"warning",code:"BusyNode",msg:`${n.name} üzerinde ${n.podCount} pod çalışıyor`,fix:"Pod dağılımını dengeleyin veya node havuzunu genişletin"});
    }
    if (["Deployment","StatefulSet","DaemonSet"].includes(n.kind)) {
      const p=(n.status||"").split("/");
      if (p.length===2) {
        const ready=parseInt(p[0]),desired=parseInt(p[1]);
        if (!isNaN(ready)&&!isNaN(desired)) {
          if (desired>0&&ready===0)    issues.push({id:n.id,level:"critical",code:"NotReady",   msg:`${n.name}: hiç pod hazır değil (0/${desired})`,    fix:"kubectl describe deployment ile event'lere bakın"});
          else if (ready<desired)      issues.push({id:n.id,level:"warning", code:"PartialReady",msg:`${n.name}: ${ready}/${desired} pod hazır`,        fix:"Kısmi hazır — pod event'lerini kontrol edin"});
        }
      }
    }
    if (n.kind==="PersistentVolumeClaim") {
      if (s==="pending") issues.push({id:n.id,level:"critical",code:"PVCPending",msg:`${n.name} PVC bağlanmadı`,       fix:"StorageClass ve PV kullanılabilirliğini kontrol edin"});
      if (s==="lost")    issues.push({id:n.id,level:"critical",code:"PVCLost",   msg:`${n.name} PVC kaybedildi`,       fix:"Altındaki PV silinmiş olabilir"});
    }
    // Bottleneck: high fan-out
    const out=edges.filter(e=>e.source===n.id).length;
    if (out>=8) issues.push({id:n.id,level:"warning",code:"HighFanOut",msg:`${n.name} çok fazla bağlantı (${out})`,fix:"Bu servis bottleneck olabilir, load balancing stratejisini gözden geçirin"});
    // Orphan
    const linked=edges.some(e=>e.source===n.id||e.target===n.id);
    if (!linked&&["Service","Deployment","StatefulSet"].includes(n.kind))
      issues.push({id:n.id,level:"info",code:"Orphan",msg:`${n.name} hiçbir kaynakla bağlı değil`,fix:"Kullanılmayan kaynak olabilir, temizlemeyi düşünün"});
  }
  return issues;
}

function nodeHealthLevel(id, issues) {
  if (issues.some(i=>i.id===id&&i.level==="critical")) return "critical";
  if (issues.some(i=>i.id===id&&i.level==="warning"))  return "warning";
  if (issues.some(i=>i.id===id&&i.level==="info"))     return "info";
  return "ok";
}

// ── Demo data ────────────────────────────────────────────────────────────────
const DEMO = {
  nodes:[
    {id:"node-cluster-node-a",kind:"Node",name:"cluster-node-a",namespace:"cluster",status:"Ready",nodeReady:true,nodeRoles:["worker"],podCount:5},
    {id:"node-cluster-node-b",kind:"Node",name:"cluster-node-b",namespace:"cluster",status:"MemoryPressure",nodeReady:true,nodeRoles:["worker"],podCount:4,nodePressure:[{type:"MemoryPressure",status:true}]},
    {id:"ing-web",  kind:"Ingress",    name:"web-ingress",      namespace:"production",status:"Active"},
    {id:"svc-fe",   kind:"Service",    name:"frontend-svc",     namespace:"production",status:"Active"},
    {id:"svc-api",  kind:"Service",    name:"api-svc",          namespace:"production",status:"Active"},
    {id:"svc-db",   kind:"Service",    name:"db-svc",           namespace:"production",status:"Active"},
    {id:"dep-fe",   kind:"Deployment", name:"frontend",         namespace:"production",status:"3/3"},
    {id:"dep-api",  kind:"Deployment", name:"api-server",       namespace:"production",status:"1/3"},
    {id:"sts-db",   kind:"StatefulSet",name:"postgres",         namespace:"production",status:"1/1"},
    {id:"pod-f1",   kind:"Pod",        name:"frontend-x7k2p",   namespace:"production",status:"Running",   cpuPercent:45,memPercent:52,restarts:0,nodeName:"cluster-node-a",
      podContainers:["app"],podImageInfo:"app: demo/app:v2.4.1",sampleLog:"2026-03-23T10:00:01.123Z [demo] GET /health 200 2ms\n2026-03-23T10:00:11.456Z [demo] GET /api/ready 200 4ms"},
    {id:"pod-f2",   kind:"Pod",        name:"frontend-m9n3q",   namespace:"production",status:"Running",   cpuPercent:38,memPercent:48,restarts:1,nodeName:"cluster-node-a"},
    {id:"pod-f3",   kind:"Pod",        name:"frontend-p4r8s",   namespace:"production",status:"Running",   cpuPercent:92,memPercent:61,restarts:0,nodeName:"cluster-node-b"},
    {id:"pod-a1",   kind:"Pod",        name:"api-server-a2b3",  namespace:"production",status:"CrashLoopBackOff",cpuPercent:12,memPercent:18,restarts:14,nodeName:"cluster-node-b"},
    {id:"pod-a2",   kind:"Pod",        name:"api-server-c4d5",  namespace:"production",status:"Pending",   cpuPercent:0, memPercent:0, restarts:0},
    {id:"pod-a3",   kind:"Pod",        name:"api-server-e6f7",  namespace:"production",status:"Running",   cpuPercent:55,memPercent:77,restarts:2,nodeName:"cluster-node-a"},
    {id:"pod-db",   kind:"Pod",        name:"postgres-0",       namespace:"production",status:"Running",   cpuPercent:62,memPercent:88,restarts:0,nodeName:"cluster-node-b"},
    {id:"cm-app",   kind:"ConfigMap",  name:"app-config",       namespace:"production",status:"Active"},
    {id:"cm-nginx", kind:"ConfigMap",  name:"nginx-config",     namespace:"production",status:"Active"},
    {id:"sec-tls",  kind:"Secret",     name:"tls-secret",       namespace:"production",status:"Active"},
    {id:"pvc-db",   kind:"PersistentVolumeClaim",name:"postgres-data",namespace:"production",status:"Bound"},
    {id:"dep-cache",kind:"Deployment", name:"redis-cache",      namespace:"production",status:"0/2"},
    {id:"svc-cache",kind:"Service",    name:"redis-svc",        namespace:"production",status:"Active"},
    {id:"pod-c1",   kind:"Pod",        name:"redis-0",          namespace:"production",status:"OOMKilled", cpuPercent:88,memPercent:98,restarts:7,nodeName:"cluster-node-b"},
    {id:"pod-c2",   kind:"Pod",        name:"redis-1",          namespace:"production",status:"Evicted",   cpuPercent:0, memPercent:0, restarts:0,nodeName:"cluster-node-b"},
    {id:"dep-prom", kind:"Deployment", name:"prometheus",       namespace:"monitoring",status:"1/1"},
    {id:"svc-prom", kind:"Service",    name:"prometheus-svc",   namespace:"monitoring",status:"Active"},
    {id:"pod-prom", kind:"Pod",        name:"prometheus-9x8y",  namespace:"monitoring",status:"Running",   cpuPercent:22,memPercent:41,restarts:0,nodeName:"cluster-node-a"},
    {id:"dep-graf", kind:"Deployment", name:"grafana",          namespace:"monitoring",status:"1/1"},
    {id:"svc-graf", kind:"Service",    name:"grafana-svc",      namespace:"monitoring",status:"Active"},
    {id:"pod-graf", kind:"Pod",        name:"grafana-a1b2c3",   namespace:"monitoring",status:"Running",   cpuPercent:14,memPercent:33,restarts:0,nodeName:"cluster-node-a"},
    {id:"cm-prom",  kind:"ConfigMap",  name:"prometheus-config",namespace:"monitoring",status:"Active"},
    {id:"svc-old",  kind:"Service",    name:"legacy-svc",       namespace:"production",status:"Active"},
  ],
  edges:[
    {id:"e1", source:"ing-web",  target:"svc-fe",   type:"routes",  label:"/"},
    {id:"e2", source:"ing-web",  target:"svc-api",  type:"routes",  label:"/api"},
    {id:"e3", source:"svc-fe",   target:"pod-f1",   type:"selects"},
    {id:"e4", source:"svc-fe",   target:"pod-f2",   type:"selects"},
    {id:"e5", source:"svc-fe",   target:"pod-f3",   type:"selects"},
    {id:"e6", source:"svc-api",  target:"pod-a1",   type:"selects"},
    {id:"e7", source:"svc-api",  target:"pod-a2",   type:"selects"},
    {id:"e8", source:"svc-api",  target:"pod-a3",   type:"selects"},
    {id:"e9", source:"svc-db",   target:"pod-db",   type:"selects"},
    {id:"e10",source:"dep-fe",   target:"pod-f1",   type:"owns"},
    {id:"e11",source:"dep-fe",   target:"pod-f2",   type:"owns"},
    {id:"e12",source:"dep-fe",   target:"pod-f3",   type:"owns"},
    {id:"e13",source:"dep-api",  target:"pod-a1",   type:"owns"},
    {id:"e14",source:"dep-api",  target:"pod-a2",   type:"owns"},
    {id:"e15",source:"dep-api",  target:"pod-a3",   type:"owns"},
    {id:"e16",source:"sts-db",   target:"pod-db",   type:"owns"},
    {id:"e17",source:"dep-api",  target:"cm-app",   type:"uses"},
    {id:"e18",source:"dep-fe",   target:"cm-nginx", type:"uses"},
    {id:"e19",source:"ing-web",  target:"sec-tls",  type:"uses"},
    {id:"e20",source:"sts-db",   target:"pvc-db",   type:"uses"},
    {id:"e21",source:"dep-api",  target:"svc-db",   type:"calls"},
    {id:"e22",source:"dep-api",  target:"svc-cache",type:"calls"},
    {id:"e23",source:"dep-cache",target:"pod-c1",   type:"owns"},
    {id:"e24",source:"dep-cache",target:"pod-c2",   type:"owns"},
    {id:"e25",source:"svc-cache",target:"pod-c1",   type:"selects"},
    {id:"e26",source:"svc-cache",target:"pod-c2",   type:"selects"},
    {id:"e27",source:"dep-prom", target:"pod-prom", type:"owns"},
    {id:"e28",source:"dep-graf", target:"pod-graf", type:"owns"},
    {id:"e29",source:"svc-prom", target:"pod-prom", type:"selects"},
    {id:"e30",source:"svc-graf", target:"pod-graf", type:"selects"},
    {id:"e31",source:"dep-prom", target:"cm-prom",  type:"uses"},
    {id:"e32",source:"dep-graf", target:"svc-prom", type:"calls"},
    {id:"e33",source:"node-cluster-node-a", target:"pod-f1", type:"hosts"},
    {id:"e34",source:"node-cluster-node-a", target:"pod-f2", type:"hosts"},
    {id:"e35",source:"node-cluster-node-a", target:"pod-a3", type:"hosts"},
    {id:"e36",source:"node-cluster-node-a", target:"pod-prom", type:"hosts"},
    {id:"e37",source:"node-cluster-node-a", target:"pod-graf", type:"hosts"},
    {id:"e38",source:"node-cluster-node-b", target:"pod-f3", type:"hosts"},
    {id:"e39",source:"node-cluster-node-b", target:"pod-a1", type:"hosts"},
    {id:"e40",source:"node-cluster-node-b", target:"pod-db", type:"hosts"},
    {id:"e41",source:"node-cluster-node-b", target:"pod-c1", type:"hosts"},
    {id:"e42",source:"node-cluster-node-b", target:"pod-c2", type:"hosts"},
  ],
};

// ── kubectl parser ────────────────────────────────────────────────────────────
function getStatus(item) {
  if (item.kind==="Pod") return item.status?.phase||"Unknown";
  if (item.kind==="Node") {
    const conds=item.status?.conditions||[];
    const ready=conds.find(c=>c.type==="Ready")?.status==="True";
    const pressure=conds.find(c=>["MemoryPressure","DiskPressure","PIDPressure"].includes(c.type)&&c.status==="True");
    if (!ready) return "NotReady";
    if (pressure) return pressure.type;
    return "Ready";
  }
  if (["Deployment","StatefulSet","DaemonSet"].includes(item.kind)) {
    return `${item.status?.readyReplicas??0}/${item.spec?.replicas??1}`;
  }
  if (item.kind==="PersistentVolumeClaim") return item.status?.phase||"Unknown";
  if (item.kind==="HorizontalPodAutoscaler") {
    const cur=item.status?.currentReplicas??0, des=item.status?.desiredReplicas??0, mx=item.spec?.maxReplicas??"?";
    return `${cur}/${des} (max ${mx})`;
  }
  if (item.kind==="PodDisruptionBudget") {
    const d=item.status?.currentHealthy??0, e=item.status?.expectedPods??"?";
    return `healthy ${d}/${e}`;
  }
  if (item.kind==="NetworkPolicy") return item.spec?.policyTypes?.join(",")||"Active";
  return "Active";
}
function getRestarts(item) {
  if (item.kind!=="Pod") return 0;
  return item.status?.containerStatuses?.reduce((a,c)=>a+(c.restartCount||0),0)||0;
}

function nodeRolesFromItem(item) {
  if (item.kind!=="Node") return undefined;
  const labels=item.metadata?.labels||{};
  const roles=Object.keys(labels)
    .filter(k=>k.startsWith("node-role.kubernetes.io/"))
    .map(k=>k.split("/")[1]||"worker")
    .filter(Boolean);
  return roles.length?roles:["worker"];
}

function nodePressureFromItem(item) {
  if (item.kind!=="Node") return undefined;
  return (item.status?.conditions||[])
    .filter(c=>["MemoryPressure","DiskPressure","PIDPressure"].includes(c.type))
    .map(c=>({type:c.type,status:c.status==="True"}));
}
function buildEdges(nodes, rawItems) {
  const edges=[]; let eid=0;
  const ids=new Set(nodes.map(n=>n.id));
  const mkId=(kind,ns,name)=>`${kind.toLowerCase()}-${ns||"default"}-${name}`;
  for (const item of rawItems) {
    const kind=item.kind, ns=item.metadata?.namespace||"default", src=item._id;
    if (kind==="Ingress") for (const rule of item.spec?.rules||[]) for (const path of rule.http?.paths||[]) {
      const svc=path.backend?.service?.name||path.backend?.serviceName;
      if (svc) { const t=mkId("service",ns,svc); if(ids.has(t)) edges.push({id:`e${eid++}`,source:src,target:t,type:"routes",label:path.path||"/"}); }
    }
    if (kind==="Service") { const sel=item.spec?.selector||{}; const keys=Object.keys(sel);
      if (keys.length) nodes.filter(n=>n.kind==="Pod"&&n.namespace===ns).forEach(pod=>{
        if (keys.every(k=>pod.labels?.[k]===sel[k])) edges.push({id:`e${eid++}`,source:src,target:pod.id,type:"selects"});
      });
    }
    if (kind==="Pod") for (const o of item.metadata?.ownerReferences||[]) {
      const oid=mkId(o.kind,ns,o.name); if(ids.has(oid)) edges.push({id:`e${eid++}`,source:oid,target:src,type:"owns"});
    }
    if (kind==="Pod" && item.spec?.nodeName) {
      const t=mkId("node","cluster",item.spec.nodeName);
      if(ids.has(t)) edges.push({id:`e${eid++}`,source:t,target:src,type:"hosts"});
    }
    if (["Deployment","StatefulSet","DaemonSet"].includes(kind)) {
      const spec=item.spec?.template?.spec||{};
      for (const v of spec.volumes||[]) {
        if (v.configMap){const t=mkId("configmap",ns,v.configMap.name);if(ids.has(t))edges.push({id:`e${eid++}`,source:src,target:t,type:"uses"});}
        if (v.secret){const t=mkId("secret",ns,v.secret.secretName);if(ids.has(t))edges.push({id:`e${eid++}`,source:src,target:t,type:"uses"});}
        if (v.persistentVolumeClaim){const t=mkId("persistentvolumeclaim",ns,v.persistentVolumeClaim.claimName);if(ids.has(t))edges.push({id:`e${eid++}`,source:src,target:t,type:"uses"});}
      }
      for (const c of [...(spec.containers||[]),...(spec.initContainers||[])]) for (const ef of c.envFrom||[]) {
        if (ef.configMapRef){const t=mkId("configmap",ns,ef.configMapRef.name);if(ids.has(t))edges.push({id:`e${eid++}`,source:src,target:t,type:"uses"});}
        if (ef.secretRef){const t=mkId("secret",ns,ef.secretRef.name);if(ids.has(t))edges.push({id:`e${eid++}`,source:src,target:t,type:"uses"});}
      }
    }
    if (kind==="HorizontalPodAutoscaler") {
      const ref=item.spec?.scaleTargetRef;
      if (ref?.kind&&ref?.name) {
        const t=mkId(ref.kind,ns,ref.name);
        if (ids.has(t)) edges.push({id:`e${eid++}`,source:src,target:t,type:"scales"});
      }
    }
    if (kind==="PodDisruptionBudget") {
      const ml=item.spec?.selector?.matchLabels;
      if (ml&&Object.keys(ml).length) {
        for (const n of nodes) {
          if (!["Deployment","StatefulSet","ReplicaSet"].includes(n.kind)||n.namespace!==ns) continue;
          const tl=Object.keys(n.templateLabels||{}).length?n.templateLabels:n.labels;
          if (Object.keys(ml).every(k=>tl?.[k]===ml[k])) edges.push({id:`e${eid++}`,source:src,target:n.id,type:"disrupts"});
        }
      }
    }
    if (kind==="NetworkPolicy") {
      const sel=item.spec?.podSelector?.matchLabels||{};
      const keys=Object.keys(sel);
      if (keys.length) nodes.filter(n=>n.kind==="Pod"&&n.namespace===ns).forEach(pod=>{
        if (keys.every(k=>pod.labels?.[k]===sel[k])) edges.push({id:`e${eid++}`,source:src,target:pod.id,type:"policies"});
      });
    }
  }
  const seen=new Set(); return edges.filter(e=>{const k=`${e.source}→${e.target}`;if(seen.has(k))return false;seen.add(k);return true;});
}
function itemKindFromListKind(listKind) {
  if (!listKind || typeof listKind !== "string" || !listKind.endsWith("List")) return "";
  const base = listKind.slice(0, -4);
  return KINDS[base] ? base : "";
}

/** İlk yüklemede `default` namespace varsa onu seç; yoksa tümü */
function pickInitialNamespace(nodes) {
  if (!nodes?.length) return "all";
  return nodes.some(n => n.namespace === "default") ? "default" : "all";
}

function podContainerNamesFromSpec(item) {
  if (item.kind !== "Pod") return undefined;
  const names = (item.spec?.containers || []).map(c => c.name).filter(Boolean);
  return names.length ? names : undefined;
}

/** Container adı + spec.image (sadece image:tag, digest yok) */
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

function formatCpuRequestMilli(value) {
  if (value == null) return "";
  return `${value}m`;
}

function formatMemoryMi(value) {
  if (value == null) return "";
  return `${value} Mi`;
}

function parseCpuToMilli(v) {
  if (!v || typeof v !== "string") return 0;
  if (v.endsWith("m")) return Math.round(parseFloat(v) || 0);
  if (v.endsWith("n")) return Math.round((parseFloat(v) || 0) / 1e6);
  if (v.endsWith("u")) return Math.round((parseFloat(v) || 0) / 1e3);
  return Math.round((parseFloat(v) || 0) * 1000);
}

function parseMemoryToMi(v) {
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
  if (!["Deployment","ReplicaSet"].includes(item.kind)) return undefined;
  const ann = item.metadata?.annotations || {};
  const owners = (item.metadata?.ownerReferences || []).map(o => `${o.kind}/${o.name}`);
  return {
    revision: ann["deployment.kubernetes.io/revision"] || "",
    changeCause: ann["kubernetes.io/change-cause"] || "",
    owners,
  };
}

function normalizeAzureName(v) {
  return String(v || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

function pushAzureDep(deps, dep) {
  if (!dep?.serviceType || !dep?.name) return;
  deps.push({
    ...dep,
    name: normalizeAzureName(dep.name),
    confidence: dep.confidence || "inferred",
    evidence: dep.evidence || "metadata",
  });
}

function azureDepsFromEnv(envList = []) {
  const deps = [];
  for (const env of envList) {
    const key = String(env?.name || "");
    const value = String(env?.value || "");
    const hay = `${key} ${value}`.toLowerCase();
    if (!hay.trim()) continue;
    if (value.includes(".azurecr.io")) pushAzureDep(deps, { serviceType:"ACR", name:value.match(/[a-z0-9]+\.azurecr\.io/i)?.[0] || value, confidence:"confirmed", evidence:`env:${key}` });
    if (hay.includes("vault.azure.net") || hay.includes("keyvault")) pushAzureDep(deps, { serviceType:"Key Vault", name:value.match(/[a-z0-9-]+\.vault\.azure\.net/i)?.[0] || key, confidence:value.includes("vault.azure.net")?"confirmed":"inferred", evidence:`env:${key}` });
    if (hay.includes("servicebus.windows.net")) pushAzureDep(deps, { serviceType:"Service Bus", name:value.match(/[a-z0-9-]+\.servicebus\.windows\.net/i)?.[0] || key, confidence:"confirmed", evidence:`env:${key}` });
    if (hay.includes("eventhub") || hay.includes("servicebus.windows.net")) pushAzureDep(deps, { serviceType:"Event Hubs", name:value.match(/[a-z0-9-]+\.servicebus\.windows\.net/i)?.[0] || key, confidence:hay.includes("eventhub")?"inferred":"confirmed", evidence:`env:${key}` });
    if (hay.includes("documents.azure.com") || hay.includes("cosmos")) pushAzureDep(deps, { serviceType:"Cosmos DB", name:value.match(/[a-z0-9-]+\.documents\.azure\.com/i)?.[0] || key, confidence:value.includes("documents.azure.com")?"confirmed":"inferred", evidence:`env:${key}` });
    if (hay.includes("database.windows.net")) pushAzureDep(deps, { serviceType:"Azure SQL", name:value.match(/[a-z0-9-]+\.database\.windows\.net/i)?.[0] || key, confidence:"confirmed", evidence:`env:${key}` });
    if (hay.includes("blob.core.windows.net") || hay.includes("queue.core.windows.net") || hay.includes("table.core.windows.net") || hay.includes("dfs.core.windows.net")) pushAzureDep(deps, { serviceType:"Storage Account", name:value.match(/[a-z0-9-]+\.(blob|queue|table|dfs)\.core\.windows\.net/i)?.[0] || key, confidence:"confirmed", evidence:`env:${key}` });
    if (hay.includes("redis.cache.windows.net")) pushAzureDep(deps, { serviceType:"Azure Cache for Redis", name:value.match(/[a-z0-9-]+\.redis\.cache\.windows\.net/i)?.[0] || key, confidence:"confirmed", evidence:`env:${key}` });
  }
  return deps;
}

function azureDepsFromItem(item) {
  const deps = [];
  const ann = item.metadata?.annotations || {};
  const labels = item.metadata?.labels || {};
  const kind = item.kind;

  if (kind === "Pod") {
    for (const c of [...(item.spec?.containers || []), ...(item.spec?.initContainers || [])]) {
      if ((c.image || "").includes(".azurecr.io")) {
        pushAzureDep(deps, { serviceType:"ACR", name:c.image.match(/[a-z0-9]+\.azurecr\.io/i)?.[0] || c.image, confidence:"confirmed", evidence:`image:${c.name}` });
      }
      deps.push(...azureDepsFromEnv(c.env || []));
    }
    for (const v of item.spec?.volumes || []) {
      if (v.csi?.driver?.includes("secrets-store") && (v.csi?.volumeAttributes?.secretProviderClass || "").toLowerCase().includes("azure")) {
        pushAzureDep(deps, { serviceType:"Key Vault", name:v.csi.volumeAttributes.secretProviderClass, confidence:"confirmed", evidence:"csi:secretProviderClass" });
      }
    }
  }

  if (["Deployment","StatefulSet","DaemonSet","ReplicaSet"].includes(kind)) {
    const spec = item.spec?.template?.spec || {};
    for (const c of [...(spec.containers || []), ...(spec.initContainers || [])]) {
      if ((c.image || "").includes(".azurecr.io")) {
        pushAzureDep(deps, { serviceType:"ACR", name:c.image.match(/[a-z0-9]+\.azurecr\.io/i)?.[0] || c.image, confidence:"confirmed", evidence:`image:${c.name}` });
      }
      deps.push(...azureDepsFromEnv(c.env || []));
    }
    for (const v of spec.volumes || []) {
      if (v.csi?.driver?.includes("secrets-store") && (v.csi?.volumeAttributes?.secretProviderClass || "").toLowerCase().includes("azure")) {
        pushAzureDep(deps, { serviceType:"Key Vault", name:v.csi.volumeAttributes.secretProviderClass, confidence:"confirmed", evidence:"csi:secretProviderClass" });
      }
    }
  }

  if (labels["azure.workload.identity/use"] === "true" || ann["azure.workload.identity/client-id"] || labels["aadpodidbinding"]) {
    pushAzureDep(deps, {
      serviceType:"Managed Identity",
      name: ann["azure.workload.identity/client-id"] || labels["aadpodidbinding"] || "workload-identity",
      confidence:"confirmed",
      evidence: ann["azure.workload.identity/client-id"] ? "annotation:azure.workload.identity/client-id" : "label:aadpodidbinding",
    });
  }

  if (kind === "PersistentVolumeClaim") {
    const sc = item.spec?.storageClassName || "";
    if (/azurefile/i.test(sc)) pushAzureDep(deps, { serviceType:"Azure Files", name:sc, confidence:"confirmed", evidence:"storageClassName" });
    if (/managed-csi|disk|azuredisk/i.test(sc)) pushAzureDep(deps, { serviceType:"Azure Disk", name:sc, confidence:"confirmed", evidence:"storageClassName" });
  }

  if (kind === "Service") {
    if (Object.keys(ann).some(k => k.includes("azure-load-balancer"))) {
      pushAzureDep(deps, { serviceType:"Azure Load Balancer", name:item.metadata?.name || "load-balancer", confidence:"confirmed", evidence:"service annotations" });
    }
  }

  if (kind === "Ingress") {
    if (Object.keys(ann).some(k => /appgw|application-gateway/i.test(k))) {
      pushAzureDep(deps, { serviceType:"Application Gateway", name:item.metadata?.name || "application-gateway", confidence:"confirmed", evidence:"ingress annotations" });
    }
  }

  const dedup = new Map();
  for (const dep of deps) {
    const key = `${dep.serviceType}|${dep.name}`;
    if (!dedup.has(key)) dedup.set(key, dep);
  }
  return [...dedup.values()];
}

function buildAzureDependencyGraph(rawItems) {
  const azureNodes = [];
  const azureEdges = [];
  const seenNodes = new Set();
  let eid = 0;
  for (const item of rawItems) {
    const deps = azureDepsFromItem(item);
    for (const dep of deps) {
      const azureId = `azureservice-azure-${dep.serviceType.toLowerCase().replace(/[^a-z0-9]+/g,"-")}-${dep.name.toLowerCase().replace(/[^a-z0-9]+/g,"-")}`;
      if (!seenNodes.has(azureId)) {
        seenNodes.add(azureId);
        azureNodes.push({
          id: azureId,
          kind: "AzureService",
          name: dep.name,
          namespace: "azure",
          status: dep.confidence === "confirmed" ? "Confirmed" : "Inferred",
          azureServiceType: dep.serviceType,
          azureConfidence: dep.confidence,
          azureEvidence: dep.evidence,
        });
      }
      azureEdges.push({
        id: `azure-e${eid++}`,
        source: item._id,
        target: azureId,
        type: "azure",
        label: dep.serviceType,
      });
    }
  }
  return { nodes: azureNodes, edges: azureEdges };
}

async function fetchPodLogTail(apiBaseRaw, hdr, namespace, podName, container, tailLines = 400) {
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

function parseKubectl(jsonStr) {
  const data=JSON.parse(jsonStr), items=data.items||(data.kind!=="List"?[data]:[]);
  const fallbackKind=itemKindFromListKind(data.kind);
  const nodes=[],rawItems=[];
  for (const item of items) {
    const k=item.kind||fallbackKind;
    if (!k||!KINDS[k]) continue;
    const full={...item,kind:k};
    const ns=k==="Node"?"cluster":(item.metadata?.namespace||"default");
    const id=`${k.toLowerCase()}-${ns}-${item.metadata.name}`;
    const tplLabels=["Deployment","StatefulSet","ReplicaSet","DaemonSet"].includes(k)
      ? (item.spec?.template?.metadata?.labels||{})
      : {};
    nodes.push({
      id,kind:k,name:item.metadata.name,namespace:ns,
      labels:item.metadata.labels||{},
      templateLabels:tplLabels,
      status:getStatus(full),
      restarts:getRestarts(full),
      cpuPercent:item._cpuPercent,
      metricsCpuMilli:item._metricsCpuMilli,
      nodeName:k==="Pod"?item.spec?.nodeName:undefined,
      nodeReady:k==="Node"?((item.status?.conditions||[]).find(c=>c.type==="Ready")?.status==="True"):undefined,
      nodeRoles:k==="Node"?nodeRolesFromItem(full):undefined,
      nodePressure:k==="Node"?nodePressureFromItem(full):undefined,
      nodeVersion:k==="Node"?item.status?.nodeInfo?.kubeletVersion:undefined,
      resources:["Pod","Deployment","StatefulSet","DaemonSet","ReplicaSet"].includes(k)?resourceSummaryFromPodSpec(k==="Pod"?item.spec:item.spec?.template?.spec):undefined,
      rollout:["Deployment","ReplicaSet"].includes(k)?rolloutSummaryFromItem(full):undefined,
      podContainers:k==="Pod"?podContainerNamesFromSpec(full):undefined,
      podImageInfo:k==="Pod"?podImageInfoFromItem(full):undefined,
    });
    rawItems.push({...full,_id:id});
  }
  const baseEdges = buildEdges(nodes,rawItems);
  const azureGraph = buildAzureDependencyGraph(rawItems);
  return {
    nodes:[...nodes,...azureGraph.nodes],
    edges:[...baseEdges,...azureGraph.edges],
  };
}

function mergePodMetricsFromApi(items, metricsDoc) {
  if (!metricsDoc?.items?.length) return;
  const usageNano = new Map();
  for (const it of metricsDoc.items) {
    const ns = it.metadata?.namespace, nm = it.metadata?.name;
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
    const ns = item.metadata?.namespace, nm = item.metadata?.name;
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

async function fetchClusterEvents(base, hdr) {
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

const KUBECTL_PLURAL = {
  Pod: "pods", Service: "services", Deployment: "deployments", StatefulSet: "statefulsets", DaemonSet: "daemonsets",
  ReplicaSet: "replicasets", Ingress: "ingresses", ConfigMap: "configmaps", Secret: "secrets",
  PersistentVolumeClaim: "persistentvolumeclaims", Job: "jobs", CronJob: "cronjobs",
  HorizontalPodAutoscaler: "horizontalpodautoscalers", PodDisruptionBudget: "poddisruptionbudgets", NetworkPolicy: "networkpolicies", Node: "nodes",
};

// ── D3 hook ──────────────────────────────────────────────────────────────────
function useGraph(svgRef, nodes, edges, issues, selectedId, onSelect, opts = {}) {
  const { namespaceLanes = false, maskSecrets = false } = opts;
  useEffect(()=>{
    if (!svgRef.current||!nodes?.length) return;
    const el=svgRef.current, W=el.clientWidth||900, H=el.clientHeight||650;
    const svg=d3.select(el); svg.selectAll("*").remove();
    const defs=svg.append("defs");
    Object.entries(EDGE_COLORS).forEach(([t,c])=>
      defs.append("marker").attr("id",`arr-${t}`).attr("viewBox","0 -5 10 10").attr("refX",34).attr("refY",0)
        .attr("markerWidth",5).attr("markerHeight",5).attr("orient","auto")
        .append("path").attr("d","M0,-5L10,0L0,5").attr("fill",c).attr("opacity",.8)
    );
    const glow=defs.append("filter").attr("id","glow");
    glow.append("feGaussianBlur").attr("stdDeviation","5").attr("result","blur");
    const fm=glow.append("feMerge"); fm.append("feMergeNode").attr("in","blur"); fm.append("feMergeNode").attr("in","SourceGraphic");

    const g=svg.append("g");
    const zoom=d3.zoom().scaleExtent([0.05,6]).on("zoom",e=>g.attr("transform",e.transform));
    svg.call(zoom);

    const sN=nodes.map(n=>({...n})), nMap=new Map(sN.map(n=>[n.id,n]));
    const sE=edges.filter(e=>nMap.has(e.source)&&nMap.has(e.target)).map(e=>({...e}));
    const showName=d=>(maskSecrets&&d.kind==="Secret"?"••••":d.name);

    const sim=d3.forceSimulation(sN)
      .force("link",d3.forceLink(sE).id(d=>d.id).distance(namespaceLanes?200:230).strength(0.4))
      .force("charge",d3.forceManyBody().strength(-850))
      .force("collide",d3.forceCollide(105));
    if(namespaceLanes&&sN.length){
      const nss=[...new Set(sN.map(n=>n.namespace))].sort();
      const nlen=Math.max(nss.length,1);
      sim.force("center",d3.forceCenter(W/2,H/2).strength(0.02))
        .force("x",d3.forceX(W/2).strength(0.06))
        .force("y",d3.forceY(d=>{const i=Math.max(0,nss.indexOf(d.namespace));return((i+0.5)/nlen)*H;}).strength(0.26));
    }else{
      sim.force("center",d3.forceCenter(W/2,H/2))
        .force("x",d3.forceX(W/2).strength(0.04))
        .force("y",d3.forceY(H/2).strength(0.04));
    }

    const linkG=g.append("g");
    const link=linkG.selectAll("line").data(sE).join("line")
      .attr("stroke",d=>EDGE_COLORS[d.type]||"#555")
      .attr("stroke-width",d=>{const sh=nodeHealthLevel(d.source,issues),th=nodeHealthLevel(d.target,issues);return(sh==="critical"||th==="critical")?2.5:1.5;})
      .attr("stroke-opacity",d=>{const sh=nodeHealthLevel(d.source,issues),th=nodeHealthLevel(d.target,issues);return(sh==="critical"||th==="critical")?0.75:0.35;})
      .attr("stroke-dasharray",d=>{const sh=nodeHealthLevel(d.source,issues),th=nodeHealthLevel(d.target,issues);return(sh==="critical"||th==="critical")?"7,3":null;})
      .attr("marker-end",d=>`url(#arr-${d.type})`);
    const linkLbl=linkG.selectAll("text").data(sE.filter(e=>e.label||e.trafficLabel)).join("text")
      .attr("text-anchor","middle").attr("fill",d=>d.trafficLabel&&!d.label?"#22D3EE":"#A855F7").attr("font-size","9px").attr("font-family","monospace")
      .text(d=>(d.label&&d.trafficLabel)?`${d.label} · ${d.trafficLabel}`:(d.label||d.trafficLabel||""));

    const nodeG=g.append("g");
    const node=nodeG.selectAll("g").data(sN).join("g").style("cursor","pointer")
      .call(d3.drag()
        .on("start",(ev,d)=>{if(!ev.active)sim.alphaTarget(0.3).restart();d.fx=d.x;d.fy=d.y;})
        .on("drag",(ev,d)=>{d.fx=ev.x;d.fy=ev.y;})
        .on("end",(ev,d)=>{if(!ev.active)sim.alphaTarget(0);d.fx=null;d.fy=null;})
      )
      .on("click",(ev,d)=>{ev.stopPropagation();onSelect(d.id===selectedId?null:d);});

    // Glow ring
    node.append("rect")
      .attr("x",-NW/2-6).attr("y",-NH/2-6).attr("width",NW+12).attr("height",NH+12).attr("rx",14)
      .attr("fill","none")
      .attr("stroke",d=>{const h=nodeHealthLevel(d.id,issues);return d.id===selectedId?(KINDS[d.kind]?.color||"#fff"):h==="ok"?"transparent":HEALTH_COLORS[h];})
      .attr("stroke-width",2).attr("stroke-opacity",0.7)
      .attr("filter",d=>{const h=nodeHealthLevel(d.id,issues);return(h!=="ok"||d.id===selectedId)?"url(#glow)":"none";});

    // Card
    node.append("rect")
      .attr("x",-NW/2).attr("y",-NH/2).attr("width",NW).attr("height",NH).attr("rx",10)
      .attr("fill","#0F172A")
      .attr("stroke",d=>{const h=nodeHealthLevel(d.id,issues);return h!=="ok"?HEALTH_COLORS[h]:KINDS[d.kind]?.color||"#334";})
      .attr("stroke-width",d=>{const h=nodeHealthLevel(d.id,issues);return h!=="ok"?2:1.2;});

    // Header tint
    node.append("rect").attr("x",-NW/2).attr("y",-NH/2).attr("width",NW).attr("height",26).attr("rx",10)
      .attr("fill",d=>{const h=nodeHealthLevel(d.id,issues);return h!=="ok"?HEALTH_COLORS[h]:KINDS[d.kind]?.color||"#555";}).attr("opacity",.14);
    node.append("rect").attr("x",-NW/2).attr("y",-NH/2+16).attr("width",NW).attr("height",10)
      .attr("fill",d=>{const h=nodeHealthLevel(d.id,issues);return h!=="ok"?HEALTH_COLORS[h]:KINDS[d.kind]?.color||"#555";}).attr("opacity",.14);

    // Kind tag
    node.append("text").attr("x",-NW/2+10).attr("y",-NH/2+17)
      .attr("fill",d=>KINDS[d.kind]?.color||"#94A3B8").attr("font-size","10px").attr("font-weight","bold").attr("font-family","monospace")
      .text(d=>KINDS[d.kind]?.tag||d.kind.slice(0,3).toUpperCase());

    // Health icon
    node.append("text").attr("x",NW/2-22).attr("y",-NH/2+17).attr("font-size","12px").attr("text-anchor","middle")
      .text(d=>{const h=nodeHealthLevel(d.id,issues);return h==="critical"?"🔴":h==="warning"?"🟡":h==="info"?"🔵":"🟢";});

    // Name
    node.append("text").attr("y",5).attr("text-anchor","middle")
      .attr("fill","#E2E8F0").attr("font-size","12px").attr("font-weight","600")
      .text(d=>{const n=showName(d);return n.length>21?n.slice(0,20)+"…":n;});

    // Status + metrics
    node.append("text").attr("y",NH/2-8).attr("text-anchor","middle")
      .attr("font-size","10px").attr("font-family","monospace")
      .attr("fill",d=>{const s=(d.status||"").toLowerCase();
        if(/run|ready|active|bound/.test(s)) return "#22C55E";
        if(/pend|wait/.test(s)) return "#F59E0B";
        if(/crash|oom|error|evict/.test(s)) return "#EF4444";
        return "#64748B";})
      .text(d=>{
        const s=d.status||"",sl=s.length>14?s.slice(0,13)+"…":s;
        const parts=[sl];
        if(d.cpuPercent!=null) parts.push(`CPU:${d.cpuPercent}%`);
        else if(d.metricsCpuMilli!=null) parts.push(`CPU:${d.metricsCpuMilli}m`);
        if(d.memPercent!=null) parts.push(`MEM:${d.memPercent}%`);
        if(d.trafficInRps!=null) parts.push(`↓${formatShortRps(d.trafficInRps)}rps`);
        if(d.trafficOutRps!=null) parts.push(`↑${formatShortRps(d.trafficOutRps)}rps`);
        if(d.trafficErrRatio>0.02) parts.push(`${(d.trafficErrRatio*100).toFixed(0)}%err`);
        const line=parts.join("  ");
        return line.length>38?line.slice(0,37)+"…":line;
      });

    // Restart badge
    node.filter(d=>d.restarts>=3).append("rect")
      .attr("x",NW/2-40).attr("y",-NH/2+22).attr("width",37).attr("height",16).attr("rx",4)
      .attr("fill",d=>d.restarts>=10?"#7F1D1D":"#451A03");
    node.filter(d=>d.restarts>=3).append("text")
      .attr("x",NW/2-21).attr("y",-NH/2+33).attr("text-anchor","middle")
      .attr("fill",d=>d.restarts>=10?"#FCA5A5":"#FCD34D").attr("font-size","9px").attr("font-weight","bold").attr("font-family","monospace")
      .text(d=>`↺${d.restarts}`);

    // Namespace label below card
    node.append("text").attr("y",NH/2+13).attr("text-anchor","middle")
      .attr("fill","#334155").attr("font-size","9px").text(d=>d.namespace);

    svg.on("click",()=>onSelect(null));
    sim.on("tick",()=>{
      link.attr("x1",d=>d.source.x).attr("y1",d=>d.source.y).attr("x2",d=>d.target.x).attr("y2",d=>d.target.y);
      linkLbl.attr("x",d=>(d.source.x+d.target.x)/2).attr("y",d=>(d.source.y+d.target.y)/2-5);
      node.attr("transform",d=>`translate(${d.x},${d.y})`);
    });
    sim.on("end",()=>{
      const b=g.node().getBBox(); if(!b.width) return;
      const pad=60,sc=Math.min((W-pad*2)/b.width,(H-pad*2)/b.height,1);
      svg.transition().duration(800).call(zoom.transform,
        d3.zoomIdentity.translate(W/2-sc*(b.x+b.width/2),H/2-sc*(b.y+b.height/2)).scale(sc));
    });
    return ()=>sim.stop();
  },[nodes,edges,issues,selectedId,namespaceLanes,maskSecrets]);
}

function prometheusUrlInitial() {
  if (typeof window === "undefined") return "";
  try {
    const saved = localStorage.getItem("k8s-topology-prometheus-url");
    if (saved != null) return saved;
  } catch { /* */ }
  const o = window.location.origin.replace(/\/$/, "");
  if (isLocalViteDev()) return `${o}/prometheus`;
  return `${o}/prometheus`;
}

function toCsvValue(value) {
  const str = value == null ? "" : String(value);
  return `"${str.replace(/"/g, '""')}"`;
}

function downloadTextFile(filename, contents, mimeType) {
  const blob = new Blob([contents], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function enrichGraphData(graph) {
  const hostCounts = new Map();
  for (const e of graph.edges || []) {
    if (e.type !== "hosts") continue;
    hostCounts.set(e.source, (hostCounts.get(e.source) || 0) + 1);
  }
  return {
    ...graph,
    nodes: (graph.nodes || []).map(n => n.kind === "Node" ? { ...n, podCount: hostCounts.get(n.id) || 0 } : n),
  };
}

function dependencyImpactForNode(selectedId, nodes, edges) {
  if (!selectedId) return null;
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const incoming = new Map();
  const outgoing = new Map();
  for (const e of edges) {
    if (!outgoing.has(e.source)) outgoing.set(e.source, []);
    if (!incoming.has(e.target)) incoming.set(e.target, []);
    outgoing.get(e.source).push(e);
    incoming.get(e.target).push(e);
  }
  const walk = (seed, dir) => {
    const seen = new Set();
    const queue = [seed];
    while (queue.length) {
      const cur = queue.shift();
      const list = (dir === "out" ? outgoing.get(cur) : incoming.get(cur)) || [];
      for (const e of list) {
        const next = dir === "out" ? e.target : e.source;
        if (next === seed || seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    return [...seen].map(id => nodeMap.get(id)).filter(Boolean);
  };
  const directUpstream = ((incoming.get(selectedId) || []).map(e => nodeMap.get(e.source))).filter(Boolean);
  const directDownstream = ((outgoing.get(selectedId) || []).map(e => nodeMap.get(e.target))).filter(Boolean);
  const upstreamClosure = walk(selectedId, "in");
  const downstreamClosure = walk(selectedId, "out");
  return {
    directUpstream,
    directDownstream,
    upstreamClosure,
    downstreamClosure,
    impactedWorkloads: downstreamClosure.filter(n => ["Pod","Deployment","StatefulSet","DaemonSet","Service"].includes(n.kind)),
  };
}

function eventsForSelectedNode(selected, clusterEvents) {
  if (!selected) return [];
  const prefixes = [
    `${selected.kind}/${selected.name}`,
    selected.kind === "Deployment" ? `ReplicaSet/${selected.name}` : "",
  ].filter(Boolean);
  return (clusterEvents || []).filter(ev => {
    if (ev.ns && selected.namespace && ev.ns !== selected.namespace && selected.kind !== "Node") return false;
    if ((ev.obj || "") === `${selected.kind}/${selected.name}`) return true;
    return prefixes.some(p => (ev.msg || "").includes(selected.name) || (ev.obj || "").startsWith(p));
  });
}

function rolloutRelatedNodes(selected, nodes) {
  if (!selected || !["Deployment","ReplicaSet"].includes(selected.kind)) return [];
  if (selected.kind === "Deployment") {
    return nodes.filter(n => n.kind === "ReplicaSet" && n.namespace === selected.namespace && n.rollout?.owners?.includes(`Deployment/${selected.name}`));
  }
  return nodes.filter(n => n.kind === "Pod" && n.namespace === selected.namespace && n.labels?.["pod-template-hash"] && selected.labels?.["pod-template-hash"] && n.labels["pod-template-hash"] === selected.labels["pod-template-hash"]);
}

const SNAPSHOT_STORAGE_KEY = "k8s-topology-snapshot-history";

function loadSnapshotHistory() {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(SNAPSHOT_STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function makeSnapshot(graph) {
  const entries = (graph?.nodes || []).map(n => ({
    id: n.id,
    kind: n.kind,
    namespace: n.namespace,
    name: n.name,
    status: n.status || "",
  }));
  return {
    id: `snap-${Date.now()}`,
    createdAt: new Date().toISOString(),
    total: entries.length,
    entries,
  };
}

function compareGraphToSnapshot(graph, snapshot) {
  if (!graph || !snapshot) return null;
  const current = new Map((graph.nodes || []).map(n => [n.id, n]));
  const baseline = new Map((snapshot.entries || []).map(e => [e.id, e]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [id, n] of current) {
    if (!baseline.has(id)) {
      added.push(n);
      continue;
    }
    const prev = baseline.get(id);
    if ((prev.status || "") !== (n.status || "")) changed.push({ before: prev, after: n });
  }
  for (const [id, oldNode] of baseline) {
    if (!current.has(id)) removed.push(oldNode);
  }
  return { added, removed, changed, snapshot };
}

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [screen,setScreen]=useState("home");
  const [graphData,setGraphData]=useState(null);
  const [selected,setSelected]=useState(null);
  const [nsFilter,setNsFilter]=useState("default");
  const [typeFilters,setTypeFilters]=useState(() => new Set(["Pod","Node","AzureService"]));
  const [nameFilter,setNameFilter]=useState("");
  const [healthFilter,setHealthFilter]=useState("all");
  const [rawInput,setRawInput]=useState("");
  const [apiUrl,setApiUrl]=useState(()=>{
    if(typeof window==="undefined") return "http://127.0.0.1:8001";
    if(isLocalViteDev()) return "http://127.0.0.1:8001";
    return `${window.location.origin.replace(/\/$/,"")}/k8s-api`;
  });
  const [err,setErr]=useState("");
  const [loading,setLoading]=useState(false);
  const [alertsOpen,setAlertsOpen]=useState(true);
  const [clusterPresetId,setClusterPresetId]=useState(()=>CLUSTER_PRESETS[0]?.id||"");
  const [kubeconfigYaml,setKubeconfigYaml]=useState("");
  const [kubeContexts,setKubeContexts]=useState([]);
  const [apiFetchHeaders,setApiFetchHeaders]=useState({});
  const [inClusterBootstrap,setInClusterBootstrap]=useState(isUiServedViaTopologyPod);
  const [fetchWarnings,setFetchWarnings]=useState([]);
  const [clusterEvents,setClusterEvents]=useState([]);
  const [eventsOpen,setEventsOpen]=useState(false);
  const [lastRefreshAt,setLastRefreshAt]=useState(null);
  const [refreshIntervalSec,setRefreshIntervalSec]=useState(0);
  const [graphView,setGraphView]=useState("graph");
  const [namespaceLanes,setNamespaceLanes]=useState(false);
  const [maskSecrets,setMaskSecrets]=useState(false);
  const [snapshotBaseline,setSnapshotBaseline]=useState(null);
  const [diffSummary,setDiffSummary]=useState(null);
  const [snapshotHistory,setSnapshotHistory]=useState(loadSnapshotHistory);
  const [compareSnapshotId,setCompareSnapshotId]=useState("");
  const [podLogText,setPodLogText]=useState("");
  const [podLogLoading,setPodLogLoading]=useState(false);
  const [podLogErr,setPodLogErr]=useState("");
  const [podLogContainer,setPodLogContainer]=useState("");
  const [podLogTick,setPodLogTick]=useState(0);
  const [prometheusUrl,setPrometheusUrl]=useState(prometheusUrlInitial);
  const [meshProfile,setMeshProfile]=useState("istio");
  const [meshStats,setMeshStats]=useState(null);
  const [meshErr,setMeshErr]=useState("");
  const [meshLoading,setMeshLoading]=useState(false);
  const [meshFetchedAt,setMeshFetchedAt]=useState(null);
  const [rightPanelWidth,setRightPanelWidth]=useState(()=>{
    if (typeof window === "undefined") return 278;
    try {
      const raw = sessionStorage.getItem("k8s-topology-right-panel-px");
      const n = raw ? parseInt(raw, 10) : NaN;
      if (Number.isFinite(n) && n >= 200 && n <= 900) return n;
    } catch { /* */ }
    return 278;
  });
  const rightPanelDragWRef = useRef(278);
  const autoConnectDoneRef=useRef(false);
  const fetchAPIRef=useRef(async()=>{});
  const fileInputRef=useRef(null);
  const svgRef=useRef(null);

  useEffect(()=>{
    const s=loadKubeconfigFromStorage();
    if(!s.trim()) return;
    setKubeconfigYaml(s);
    try{
      const doc=parseKubeconfigYaml(s);
      setKubeContexts(listKubeconfigContexts(doc));
    }catch{ setKubeContexts([]); }
  },[]);

  useEffect(()=>{
    setNameFilter("");
    setHealthFilter("all");
  },[graphData]);

  useEffect(()=>{
    try{localStorage.setItem("k8s-topology-prometheus-url",prometheusUrl);}catch{/* */}
  },[prometheusUrl]);

  useEffect(()=>{
    try{localStorage.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshotHistory.slice(0, 12)));}catch{/* */}
  },[snapshotHistory]);

  const loadMeshTraffic=useCallback(async()=>{
    if(meshProfile==="off"||!prometheusUrl.trim()){
      setMeshStats(null);
      setMeshErr("");
      setMeshLoading(false);
      return;
    }
    setMeshLoading(true);
    setMeshErr("");
    try{
      const s=await fetchMeshTrafficStats(prometheusUrl.trim(),meshProfile);
      setMeshStats(s);
      setMeshFetchedAt(new Date());
    }catch(e){
      setMeshErr(e.message||String(e));
      setMeshStats(null);
    }finally{
      setMeshLoading(false);
    }
  },[prometheusUrl,meshProfile]);

  useEffect(()=>{ rightPanelDragWRef.current = rightPanelWidth; }, [rightPanelWidth]);

  const onRightPanelResizeStart = useCallback((e)=>{
    e.preventDefault();
    const startX = e.clientX;
    const startW = rightPanelDragWRef.current;
    const maxW = typeof window !== "undefined" ? Math.min(900, Math.floor(window.innerWidth * 0.72)) : 900;
    const minW = 200;
    const onMove = (ev)=>{
      const nw = Math.min(maxW, Math.max(minW, startW + (startX - ev.clientX)));
      rightPanelDragWRef.current = nw;
      setRightPanelWidth(nw);
    };
    const onUp = ()=>{
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try {
        sessionStorage.setItem("k8s-topology-right-panel-px", String(rightPanelDragWRef.current));
      } catch { /* */ }
    };
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  const shapeFiltered=useMemo(()=>{
    if(!graphData) return {nodes:[],edges:[]};
    const q=nameFilter.trim().toLowerCase();
    const nodes=graphData.nodes.filter(n=>{
      if(nsFilter!=="all"&&n.namespace!==nsFilter) return false;
      if(!typeFilters.has(n.kind)) return false;
      if(q){
        const nm=n.name.toLowerCase(), ns=n.namespace.toLowerCase(), id=n.id.toLowerCase();
        if(!nm.includes(q)&&!ns.includes(q)&&!id.includes(q)) return false;
      }
      return true;
    });
    const ids=new Set(nodes.map(n=>n.id));
    return {nodes,edges:graphData.edges.filter(e=>ids.has(e.source)&&ids.has(e.target))};
  },[graphData,nsFilter,typeFilters,nameFilter]);

  const issues=useMemo(()=>analyzeHealth(shapeFiltered.nodes,shapeFiltered.edges),[shapeFiltered]);

  const filtered=useMemo(()=>{
    if(healthFilter==="all") return shapeFiltered;
    const nodes=shapeFiltered.nodes.filter(n=>nodeHealthLevel(n.id,issues)===healthFilter);
    const ids=new Set(nodes.map(n=>n.id));
    return {nodes,edges:shapeFiltered.edges.filter(e=>ids.has(e.source)&&ids.has(e.target))};
  },[shapeFiltered,healthFilter,issues]);

  const graphWithTraffic=useMemo(()=>{
    if(!meshStats||meshProfile==="off") return filtered;
    return mergeTrafficIntoGraph(filtered,meshStats);
  },[filtered,meshStats,meshProfile]);

  const detailNode=useMemo(()=>{
    if(!selected) return null;
    return graphWithTraffic.nodes.find(n=>n.id===selected.id)||selected;
  },[selected,graphWithTraffic]);

  const hotServices=useMemo(()=>topInboundServices(meshStats,8),[meshStats]);
  const dependencyImpact=useMemo(()=>dependencyImpactForNode(selected?.id, graphWithTraffic.nodes, graphWithTraffic.edges),[selected?.id,graphWithTraffic]);
  const historyDiff=useMemo(()=>compareGraphToSnapshot(graphData, snapshotHistory.find(s=>s.id===compareSnapshotId)||null),[graphData,snapshotHistory,compareSnapshotId]);
  const selectedEvents=useMemo(()=>eventsForSelectedNode(detailNode || selected, clusterEvents),[detailNode,selected,clusterEvents]);
  const rolloutNodes=useMemo(()=>rolloutRelatedNodes(detailNode || selected, graphWithTraffic.nodes),[detailNode,selected,graphWithTraffic]);
  const selectedAzureDeps=useMemo(()=>{
    const current = detailNode || selected;
    if(!current) return [];
    const out = graphWithTraffic.edges
      .filter(e=>e.source===current.id && e.type==="azure")
      .map(e=>graphWithTraffic.nodes.find(n=>n.id===e.target))
      .filter(Boolean);
    return out;
  },[detailNode,selected,graphWithTraffic]);

  useEffect(()=>{
    if(!selected) return;
    if(filtered.nodes.some(n=>n.id===selected.id)) return;
    setSelected(null);
  },[filtered,selected]);

  useEffect(()=>{
    if(meshProfile==="off"){
      setMeshStats(null);
      setMeshErr("");
    }
  },[meshProfile]);

  const critCount=issues.filter(i=>i.level==="critical").length;
  const warnCount=issues.filter(i=>i.level==="warning").length;
  const infoCount=issues.filter(i=>i.level==="info").length;

  useGraph(svgRef,graphView==="graph"?graphWithTraffic.nodes:[],graphView==="graph"?graphWithTraffic.edges:[],issues,selected?.id,(n)=>setSelected(n),{namespaceLanes,maskSecrets});

  const namespaces=useMemo(()=>[...new Set((graphData?.nodes||[]).map(n=>n.namespace))].sort(),[graphData]);
  const nsSelectValue=useMemo(()=>{
    if(nsFilter==="all") return "all";
    if(namespaces.includes(nsFilter)) return nsFilter;
    return "all";
  },[nsFilter,namespaces]);

  useEffect(()=>{
    if(!graphData?.nodes?.length) return;
    if(nsFilter!=="all"&&!namespaces.includes(nsFilter)){
      setNsFilter(pickInitialNamespace(graphData.nodes));
    }
  },[graphData,namespaces,nsFilter]);

  useEffect(()=>{
    if(!selected||selected.kind!=="Pod"){setPodLogContainer("");return;}
    const pc=selected.podContainers;
    setPodLogContainer(pc?.[0]||"");
  },[selected?.id,selected?.kind]);

  useEffect(()=>{
    if(screen!=="graph"||!selected||selected.kind!=="Pod"){
      setPodLogText("");
      setPodLogErr("");
      setPodLogLoading(false);
      return;
    }
    if(selected.sampleLog){
      setPodLogText(selected.sampleLog);
      setPodLogErr("");
      setPodLogLoading(false);
      return;
    }
    let cancelled=false;
    const run=async()=>{
      setPodLogLoading(true);
      setPodLogErr("");
      try{
        const cont=podLogContainer||selected.podContainers?.[0]||"";
        const txt=await fetchPodLogTail(apiUrl,apiFetchHeaders,selected.namespace,selected.name,cont);
        if(!cancelled) setPodLogText(txt);
      }catch(e){
        if(!cancelled) setPodLogErr(e.message||String(e));
      }finally{
        if(!cancelled) setPodLogLoading(false);
      }
    };
    run();
    return ()=>{cancelled=true;};
  },[screen,selected?.id,selected?.kind,podLogContainer,apiUrl,apiFetchHeaders,podLogTick]);
  const kindCounts=useMemo(()=>{
    const c={};
    if(!graphData) return c;
    const q=nameFilter.trim().toLowerCase();
    for(const n of graphData.nodes){
      if(nsFilter!=="all"&&n.namespace!==nsFilter) continue;
      if(q){
        const nm=n.name.toLowerCase(), ns=n.namespace.toLowerCase(), id=n.id.toLowerCase();
        if(!nm.includes(q)&&!ns.includes(q)&&!id.includes(q)) continue;
      }
      c[n.kind]=(c[n.kind]||0)+1;
    }
    return c;
  },[graphData,nsFilter,nameFilter]);

  const loadDemo=()=>{setErr("");const g=enrichGraphData(DEMO);setGraphData(g);setSelected(null);setNsFilter(pickInitialNamespace(g.nodes));setScreen("graph");void loadMeshTraffic();};
  const applyInput=()=>{setErr("");try{const p=enrichGraphData(parseKubectl(rawInput));setGraphData(p);setSelected(null);setNsFilter(pickInitialNamespace(p.nodes));setScreen("graph");void loadMeshTraffic();}catch(e){setErr("JSON hatası: "+e.message);}};
  const fetchAPI=useCallback(async(apiBaseOverride,opts={})=>{
    setLoading(true);setErr("");
    const results=[];
    const hdr={...apiFetchHeaders,...(opts.headers||{})};
    const failures=[];
    const baseRaw=(apiBaseOverride??apiUrl).replace(/\/$/,"");
    const base=normalizeKubernetesListBase(baseRaw,hdr);
    const collect=async(pathSuffix,kindName)=>{
      const url=kubernetesListFetchUrl(base,pathSuffix);
      try{
        const r=await fetch(url,{headers:hdr,cache:"no-store",credentials:"omit"});
        if(!r.ok){
          let detail="";
          try{const t=await r.text();if(t)detail=t.slice(0,180);}catch{/* */}
          failures.push(`${pathSuffix} → HTTP ${r.status}${detail?`: ${detail}`:""}`);
          return;
        }
        const text=await r.text();
        if(!text)return;
        const d=JSON.parse(text);
        if(!Array.isArray(d.items))return;
        for(const it of d.items)results.push({...it,kind:it.kind||kindName});
      }catch(e){
        failures.push(`${pathSuffix}: ${e.message||String(e)}`);
      }
    };
    await Promise.all([
      collect("/api/v1/pods","Pod"),
      collect("/api/v1/nodes","Node"),
      collect("/api/v1/services","Service"),
      collect("/api/v1/configmaps","ConfigMap"),
      collect("/api/v1/secrets","Secret"),
      collect("/api/v1/persistentvolumeclaims","PersistentVolumeClaim"),
    ]);
    await Promise.all([
      collect("/apis/apps/v1/deployments","Deployment"),
      collect("/apis/apps/v1/statefulsets","StatefulSet"),
      collect("/apis/apps/v1/daemonsets","DaemonSet"),
      collect("/apis/apps/v1/replicasets","ReplicaSet"),
    ]);
    await collect("/apis/networking.k8s.io/v1/ingresses","Ingress");
    await Promise.all([
      collect("/apis/batch/v1/jobs","Job"),
      collect("/apis/batch/v1/cronjobs","CronJob"),
    ]);
    await Promise.all([
      collect("/apis/autoscaling/v2/horizontalpodautoscalers","HorizontalPodAutoscaler"),
      collect("/apis/policy/v1/poddisruptionbudgets","PodDisruptionBudget"),
      collect("/apis/networking.k8s.io/v1/networkpolicies","NetworkPolicy"),
    ]);
    try{
      const mUrl=kubernetesListFetchUrl(base,"/apis/metrics.k8s.io/v1/pods");
      const mr=await fetch(mUrl,{headers:hdr,cache:"no-store",credentials:"omit"});
      if(mr.ok){
        const md=await mr.json();
        mergePodMetricsFromApi(results,md);
      }
    }catch{/* metrics-server yok */}
    let ev=[];
    try{ev=await fetchClusterEvents(base,hdr);}catch{ev=[];}
    setClusterEvents(ev);
    if(!results.length){
      setFetchWarnings([]);
      const corsHint=hdr.Authorization?" Doğrudan token ile çağrıda CORS engeli olabilir; kubectl proxy --port=8001 deneyin.":"";
      const pfHint=!isLocalViteDev()&&typeof window!=="undefined"&&(window.location.hostname==="localhost"||window.location.hostname==="127.0.0.1")?" Port-forward kullanıyorsanız adresin http://localhost:PORT şeklinde olduğundan ve API’nin aynı PORT üzerinden /k8s-api ile geldiğinden emin olun (127.0.0.1:8001 laptop’taki kubectl proxy içindir).":"";
      const failTail=failures.length?` Detay: ${failures.slice(0,3).join(" · ")}${failures.length>3?" …":""}`:"";
      setErr("API’den kayıt alınamadı (liste boş veya tüm istekler başarısız). LB veya port-forward ile açıyorsanız sayfa adresi ile /k8s-api aynı origin’de olmalı. Önbellek için hard refresh deneyin."+corsHint+pfHint+failTail);
      setMeshStats(null);
      setLoading(false);
      return;
    }
    setFetchWarnings(failures.length?failures:[]);
    try{
      const parsed=enrichGraphData(parseKubectl(JSON.stringify({kind:"List",items:results})));
      setGraphData(parsed);
      setSelected(null);
      setNsFilter(pickInitialNamespace(parsed.nodes));
      setScreen("graph");
      setLastRefreshAt(new Date());
      void loadMeshTraffic();
    }catch(e){setErr(e.message);}
    setLoading(false);
  },[apiUrl,apiFetchHeaders,loadMeshTraffic]);

  fetchAPIRef.current=fetchAPI;

  useEffect(()=>{
    if(screen!=="graph"||refreshIntervalSec<=0)return undefined;
    const id=setInterval(()=>{fetchAPIRef.current();},refreshIntervalSec*1000);
    return ()=>clearInterval(id);
  },[screen,refreshIntervalSec]);

  useEffect(()=>{
    if(!isUiServedViaTopologyPod()){
      setInClusterBootstrap(false);
      return;
    }
    if(autoConnectDoneRef.current) return;
    autoConnectDoneRef.current=true;
    const base=normalizeKubernetesListBase(`${window.location.origin.replace(/\/$/,"")}/k8s-api`,{});
    setApiUrl(base);
    setApiFetchHeaders({});
    const internalId=CLUSTER_PRESETS.find(p=>p.id==="cortex-internal-aks")?.id;
    if(internalId) setClusterPresetId(internalId);
    (async()=>{
      try{
        await fetchAPI(base,{headers:{}});
      }finally{
        setInClusterBootstrap(false);
      }
    })();
  },[fetchAPI]);

  const toggleKind=k=>setTypeFilters(prev=>{const s=new Set(prev);s.has(k)?s.delete(k):s.add(k);return s;});
  const selectAllKinds=()=>setTypeFilters(new Set(Object.keys(KINDS)));
  const clearAllKinds=()=>setTypeFilters(new Set());

  const exportTopologySvg=()=>{
    const el=svgRef.current;
    if(!el)return;
    const ser=new XMLSerializer().serializeToString(el);
    downloadTextFile(
      `k8s-topology-${new Date().toISOString().slice(0,19).replace(/:/g,"")}.svg`,
      ser,
      "image/svg+xml;charset=utf-8",
    );
  };

  const exportTableCsv=()=>{
    const rows = filtered.nodes.map(n=>[
      n.kind,
      maskSecrets&&n.kind==="Secret"?"••••":n.name,
      n.namespace,
      n.status||"",
      nodeHealthLevel(n.id,issues),
      n.restarts??"",
      n.cpuPercent!=null?`${n.cpuPercent}`:"",
      n.memPercent!=null?`${n.memPercent}`:"",
    ].map(toCsvValue).join(","));
    const csv = [
      "kind,name,namespace,status,health,restarts,cpu_percent,memory_percent",
      ...rows,
    ].join("\n");
    downloadTextFile(
      `k8s-topology-${new Date().toISOString().slice(0,19).replace(/:/g,"")}.csv`,
      csv,
      "text/csv;charset=utf-8",
    );
  };

  const copyText=async(t)=>{
    try{await navigator.clipboard.writeText(t);}catch{/* */}
  };

  const btn=(label,action,bg,fg="#fff")=>(
    <button onClick={action} style={{background:bg,border:"none",color:fg,borderRadius:8,padding:"9px 20px",cursor:"pointer",fontWeight:600,fontSize:13}}>{label}</button>
  );
  const ghostBtn=(label,action)=>(
    <button onClick={action} style={{background:"#0F172A",border:"1px solid #1E293B",color:"#94A3B8",borderRadius:8,padding:"9px 18px",cursor:"pointer",fontSize:13}}>{label}</button>
  );

  if(inClusterBootstrap) return (
    <div style={{background:"#020817",minHeight:"100vh",color:"#E2E8F0",fontFamily:"system-ui,sans-serif",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:16,padding:24}}>
      <div style={{width:40,height:40,border:"3px solid #1E293B",borderTopColor:"#6366F1",borderRadius:"50%",animation:"k8s-spin .8s linear infinite"}}/>
      <style>{`@keyframes k8s-spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{fontSize:15,fontWeight:600,color:"#CBD5E1"}}>Bulunduğunuz kümenin API’sine bağlanılıyor…</div>
      <div style={{fontSize:12,color:"#64748B",maxWidth:360,textAlign:"center"}}>Pod içi proxy (<code style={{color:"#94A3B8"}}>/k8s-api</code>) ile otomatik keşif</div>
    </div>
  );

  if(screen==="home") return (
    <div style={{background:"#020817",minHeight:"100vh",color:"#E2E8F0",fontFamily:"system-ui,sans-serif",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:28,padding:24}}>
      <div style={{textAlign:"center"}}>
        <div style={{fontSize:11,color:"#475569",letterSpacing:3,textTransform:"uppercase",marginBottom:8}}>Open Source · Self-Hosted</div>
        <h1 style={{fontSize:38,fontWeight:800,margin:0,background:"linear-gradient(135deg,#3B82F6,#A855F7,#EF4444)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>K8s Topology Viewer</h1>
        <p style={{color:"#64748B",marginTop:8,fontSize:14}}>Tüm kaynakları, bağlantıları, hataları ve bottleneck'leri otomatik keşfeder</p>
      </div>
      <div style={{display:"flex",gap:14,flexWrap:"wrap",justifyContent:"center"}}>
        {[{icon:"🎮",title:"Demo Modu",sub:"Hata & bottleneck örnekleriyle",color:"#3B82F6",action:loadDemo},
          {icon:"📋",title:"kubectl Yapıştır",sub:"kubectl get all -A -o json",color:"#A855F7",action:()=>{setErr("");setScreen("input");}},
          {icon:"🔌",title:"Canlı API",sub:"Kümede pod proxy · yerelde kubectl proxy",color:"#22C55E",action:()=>{setErr("");setScreen("api");}},
        ].map(({icon,title,sub,color,action})=>(
          <div key={title} onClick={action} style={{background:"#0F172A",border:`1px solid ${color}33`,borderRadius:14,padding:"24px 32px",cursor:"pointer",minWidth:185,textAlign:"center",transition:"border-color .2s"}}
            onMouseEnter={e=>e.currentTarget.style.borderColor=color} onMouseLeave={e=>e.currentTarget.style.borderColor=color+"33"}>
            <div style={{fontSize:28,marginBottom:8}}>{icon}</div>
            <div style={{fontWeight:700,fontSize:14,color:"#E2E8F0"}}>{title}</div>
            <div style={{fontSize:11,color:"#64748B",marginTop:4}}>{sub}</div>
          </div>
        ))}
      </div>
      <div style={{width:"100%",maxWidth:620,background:"#0F172A",border:"1px solid #6366F133",borderRadius:14,padding:"18px 20px",boxSizing:"border-box",display:"flex",flexDirection:"column",gap:16}}>
        <div>
          <div style={{fontSize:11,color:"#6366F1",letterSpacing:2,textTransform:"uppercase",marginBottom:6}}>Ön tanımlı küme</div>
          <div style={{fontSize:13,color:"#94A3B8",marginBottom:12}}>Hazır hedefler. Yerelde çoğu zaman önce <code style={{color:"#E2E8F0",background:"#020817",padding:"2px 6px",borderRadius:4}}>kubectl config use-context …</code> ve gerekirse <code style={{color:"#E2E8F0",background:"#020817",padding:"2px 6px",borderRadius:4}}>kubectl proxy --port=8001</code>.</div>
          <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"stretch"}}>
            <select
              value={clusterPresetId}
              onChange={e=>setClusterPresetId(e.target.value)}
              style={{flex:"1 1 220px",minWidth:0,background:"#020817",border:"1px solid #1E293B",borderRadius:8,color:"#E2E8F0",fontSize:14,padding:"10px 12px",cursor:"pointer"}}
            >
              <optgroup label="Ön tanımlı">
                {CLUSTER_PRESETS.map(p=>(
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </optgroup>
              {kubeContexts.length>0&&(
                <optgroup label="kubeconfig">
                  {kubeContexts.map(c=>(
                    <option key={c.name} value={`kc:${c.name}`}>{c.name}{c.hasToken?"":" · token yok"}</option>
                  ))}
                </optgroup>
              )}
            </select>
            <button
              type="button"
              disabled={loading}
              onClick={async()=>{
                if(clusterPresetId.startsWith("kc:")){
                  const ctxName=clusterPresetId.slice(3);
                  let doc;
                  try{doc=parseKubeconfigYaml(kubeconfigYaml);}catch{
                    setErr("Önce geçerli kubeconfig yapıştırın veya dosyadan yükleyin.");
                    return;
                  }
                  const r=resolveKubeconfigContext(doc,ctxName);
                  if(!r){setErr("Context çözülemedi.");return;}
                  if(r.exec){
                    setErr(`Bu context exec kullanıyor (OIDC vb.). Tarayıcı çalıştıramaz. Terminal: kubectl config use-context ${ctxName} && kubectl proxy --port=8001 — sonra API URL http://127.0.0.1:8001`);
                    return;
                  }
                  if(r.clientCertificateData&&r.clientKeyData&&!r.token){
                    setErr("Bu context istemci sertifikası kullanıyor; tarayıcıda kullanılamaz. kubectl proxy --port=8001 deneyin.");
                    return;
                  }
                  if(!r.token){
                    setErr("kubeconfig içinde bu kullanıcı için token yok. kubectl proxy veya token içeren bir context seçin.");
                    return;
                  }
                  const base=r.server.replace(/\/$/,"");
                  setApiUrl(base);
                  const auth={Authorization:`Bearer ${r.token}`};
                  setApiFetchHeaders(auth);
                  setErr("");
                  await fetchAPI(base,{headers:auth});
                  return;
                }
                const preset=CLUSTER_PRESETS.find(p=>p.id===clusterPresetId);
                const resolved=resolvePresetApiBase(preset);
                if(!resolved){
                  setErr(preset?.id==="cortex-qa-aks"?"QA için VITE_K8S_API_CORTEX_QA_AKS (QA /k8s-api tam URL) build ortamında tanımlı olmalı.":"Bu küme için API adresi yok.");
                  return;
                }
                setApiUrl(resolved);
                setApiFetchHeaders({});
                setErr("");
                await fetchAPI(resolved);
              }}
              style={{background:"#6366F1",border:"none",color:"#fff",borderRadius:8,padding:"10px 20px",cursor:loading?"wait":"pointer",fontWeight:600,fontSize:13,whiteSpace:"nowrap"}}
            >{loading?"…":"Bağlan →"}</button>
          </div>
        </div>
        <div style={{borderTop:"1px solid #1E293B",paddingTop:16}}>
          <div style={{fontSize:11,color:"#22C55E",letterSpacing:2,textTransform:"uppercase",marginBottom:6}}>kubeconfig</div>
          <p style={{fontSize:12,color:"#64748B",margin:"0 0 10px",lineHeight:1.5}}>Bu uygulama <b style={{color:"#94A3B8"}}>Kubernetes içinde</b> çalışırken ana sayfada otomatik olarak pod proxy (<code style={{color:"#94A3B8"}}>/k8s-api</code>) ile aynı kümeye bağlanır. Yerelde <b style={{color:"#94A3B8"}}>~/.kube/config</b> tarayıcıdan okunamaz; yapıştırın veya dosya seçin. Token’lı context’ler listede görünür; doğrudan API’de <b style={{color:"#94A3B8"}}>CORS</b> sık engeller — o zaman <code style={{color:"#E2E8F0",background:"#020817",padding:"2px 6px",borderRadius:4}}>kubectl proxy</code> kullanın.</p>
          <input ref={fileInputRef} type="file" accept=".yaml,.yml,.config,text/*" style={{display:"none"}} onChange={async(e)=>{
            const f=e.target.files?.[0];
            if(!f)return;
            try{
              const t=await f.text();
              setKubeconfigYaml(t);
              const doc=parseKubeconfigYaml(t);
              setKubeContexts(listKubeconfigContexts(doc));
              setErr("");
            }catch(ex){setKubeContexts([]);setErr(ex.message||String(ex));}
            e.target.value="";
          }}/>
          <textarea
            value={kubeconfigYaml}
            onChange={e=>setKubeconfigYaml(e.target.value)}
            placeholder="apiVersion: v1&#10;kind: Config&#10;clusters: …"
            spellCheck={false}
            style={{width:"100%",minHeight:120,boxSizing:"border-box",background:"#020817",border:"1px solid #1E293B",borderRadius:8,color:"#E2E8F0",fontFamily:"ui-monospace,monospace",fontSize:11,padding:12,resize:"vertical",outline:"none",marginBottom:10}}
          />
          <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
            <button type="button" onClick={()=>fileInputRef.current?.click()} style={{background:"#14532D",border:"1px solid #166534",color:"#BBF7D0",borderRadius:8,padding:"8px 14px",cursor:"pointer",fontSize:12,fontWeight:600}}>Dosya seç</button>
            <button type="button" onClick={()=>{
              try{
                const doc=parseKubeconfigYaml(kubeconfigYaml);
                setKubeContexts(listKubeconfigContexts(doc));
                setErr("");
              }catch(ex){setKubeContexts([]);setErr(ex.message||String(ex));}
            }} style={{background:"#0F172A",border:"1px solid #334155",color:"#CBD5E1",borderRadius:8,padding:"8px 14px",cursor:"pointer",fontSize:12}}>Context listesini güncelle</button>
            <button type="button" onClick={()=>{saveKubeconfigToStorage(kubeconfigYaml);setErr("");}} style={{background:"#0F172A",border:"1px solid #334155",color:"#CBD5E1",borderRadius:8,padding:"8px 14px",cursor:"pointer",fontSize:12}}>Tarayıcıda sakla</button>
            <button type="button" onClick={()=>{clearKubeconfigStorage();setKubeconfigYaml("");setKubeContexts([]);setErr("");}} style={{background:"#450A0A",border:"1px solid #7F1D1D",color:"#FCA5A5",borderRadius:8,padding:"8px 14px",cursor:"pointer",fontSize:12}}>Temizle</button>
          </div>
        </div>
        {err&&<div style={{color:"#FCA5A5",fontSize:13,background:"#450A0A",padding:"10px 12px",borderRadius:8}}>{err}</div>}
      </div>
      <div style={{display:"flex",gap:10,flexWrap:"wrap",justifyContent:"center",maxWidth:580}}>
        {[{l:"🔴 Critical",c:"#EF4444",t:"CrashLoop, OOMKilled, Evicted, PVC sorunları"},
          {l:"🟡 Warning",c:"#F59E0B",t:"Pending, PartialReady, Yüksek CPU/Memory"},
          {l:"🔵 Info",c:"#60A5FA",t:"Orphan kaynak, HighFanOut bottleneck"},
          {l:"🟢 OK",c:"#22C55E",t:"Sağlıklı kaynaklar"},
        ].map(({l,c,t})=>(
          <div key={l} style={{background:"#0F172A",border:`1px solid ${c}33`,borderRadius:8,padding:"8px 14px",textAlign:"center",flex:"1 1 200px"}}>
            <div style={{fontWeight:600,fontSize:12,color:c}}>{l}</div>
            <div style={{fontSize:10,color:"#475569",marginTop:3}}>{t}</div>
          </div>
        ))}
      </div>
    </div>
  );

  if(screen==="input") return (
    <div style={{background:"#020817",minHeight:"100vh",color:"#E2E8F0",fontFamily:"system-ui,sans-serif",display:"flex",flexDirection:"column",padding:24,gap:14,maxWidth:800,margin:"0 auto"}}>
      <div style={{display:"flex",alignItems:"center",gap:12}}>{ghostBtn("← Geri",()=>setScreen("home"))}<h2 style={{margin:0,fontSize:18,fontWeight:700}}>kubectl Çıktısını Yapıştır</h2></div>
      <div style={{background:"#0F172A",borderRadius:10,padding:14,border:"1px solid #1E293B",fontSize:13}}>
        <code style={{color:"#A855F7",display:"block",marginBottom:4}}>kubectl get all,ingresses,configmaps,secrets,pvc -A -o json</code>
        <span style={{color:"#64748B",fontSize:11}}>çıktısını aşağıya yapıştırın</span>
      </div>
      <textarea value={rawInput} onChange={e=>setRawInput(e.target.value)} placeholder='{"kind":"List","items":[...]}'
        style={{flex:1,minHeight:320,background:"#0F172A",border:"1px solid #1E293B",borderRadius:10,color:"#E2E8F0",fontFamily:"monospace",fontSize:12,padding:14,resize:"vertical",outline:"none"}}/>
      {err&&<div style={{color:"#EF4444",fontSize:13,background:"#450A0A",padding:"8px 14px",borderRadius:8}}>{err}</div>}
      <div style={{display:"flex",gap:10}}>{btn("Görselleştir →",applyInput,"#3B82F6")} {ghostBtn("Demo",loadDemo)}</div>
    </div>
  );

  if(screen==="api") return (
    <div style={{background:"#020817",minHeight:"100vh",color:"#E2E8F0",fontFamily:"system-ui,sans-serif",display:"flex",flexDirection:"column",padding:24,gap:14,maxWidth:620,margin:"0 auto"}}>
      <div style={{display:"flex",alignItems:"center",gap:12}}>{ghostBtn("← Geri",()=>setScreen("home"))}<h2 style={{margin:0,fontSize:18,fontWeight:700}}>Kubernetes API Bağlantısı</h2></div>
      <div style={{background:"#0F172A",borderRadius:10,padding:14,border:"1px solid #1E293B",fontSize:13}}>
        <div style={{color:"#22C55E",fontWeight:600,marginBottom:6}}>Yerel geliştirme:</div>
        <code style={{color:"#E2E8F0",background:"#020817",display:"block",padding:"8px 12px",borderRadius:6,marginBottom:10}}>kubectl proxy --port=8001</code>
        <div style={{color:"#64748B",fontSize:12}}>Bu uygulama Ingress üzerinden açıldığında varsayılan olarak aynı sitedeki <b style={{color:"#94A3B8"}}>/k8s-api</b> üzerinden pod içi proxy kullanılır (ek bir komut gerekmez).</div>
      </div>
      <div><label style={{fontSize:12,color:"#64748B",display:"block",marginBottom:6}}>API URL</label>
        <input value={apiUrl} onChange={e=>setApiUrl(e.target.value)} style={{width:"100%",background:"#0F172A",border:"1px solid #1E293B",borderRadius:8,color:"#E2E8F0",fontSize:14,padding:"10px 14px",outline:"none",boxSizing:"border-box"}}/></div>
      {err&&<div style={{color:"#EF4444",fontSize:13,background:"#450A0A",padding:"8px 14px",borderRadius:8}}>{err}</div>}
      <div style={{display:"flex",gap:10}}>{btn(loading?"Bağlanıyor...":"Bağlan ve Keşfet →",()=>fetchAPI(),"#22C55E","#000")} {ghostBtn("Demo",loadDemo)}</div>
    </div>
  );

  // ── GRAPH ──
  return (
    <div style={{display:"flex",height:"100vh",background:"#020817",color:"#E2E8F0",fontFamily:"system-ui,sans-serif",overflow:"hidden"}}>

      {/* Sidebar */}
      <div style={{width:208,background:"#0A1628",borderRight:"1px solid #1E293B",display:"flex",flexDirection:"column",overflow:"hidden",flexShrink:0}}>
        <div style={{padding:"12px 14px 10px",borderBottom:"1px solid #1E293B"}}>
          <div style={{fontWeight:700,fontSize:14}}>K8s Topology</div>
          <div style={{fontSize:11,color:"#475569",marginTop:2}}>{filtered.nodes.length} kaynak · {filtered.edges.length} bağlantı</div>
        </div>
        {/* Health summary */}
        <div style={{padding:"8px 10px",borderBottom:"1px solid #1E293B",display:"grid",gridTemplateColumns:"1fr 1fr",gap:5}}>
          {[{l:"Tümü",c:"#94A3B8",n:filtered.nodes.length},
            {l:"🔴 Kritik",c:"#EF4444",n:critCount},
            {l:"🟡 Uyarı",c:"#F59E0B",n:warnCount},
            {l:"🟢 Sağlıklı",c:"#22C55E",n:filtered.nodes.filter(n=>nodeHealthLevel(n.id,issues)==="ok").length},
          ].map(({l,c,n:count})=>(
            <div key={l} style={{background:"#0F172A",border:`1px solid ${c}33`,borderRadius:7,padding:"5px 8px",textAlign:"center"}}>
              <div style={{fontSize:14,fontWeight:700,color:c}}>{count}</div>
              <div style={{fontSize:9,color:"#64748B"}}>{l}</div>
            </div>
          ))}
        </div>
        {/* Filtre */}
        <div style={{padding:"8px 14px",borderBottom:"1px solid #1E293B"}}>
          <div style={{fontSize:10,color:"#475569",marginBottom:6,textTransform:"uppercase",letterSpacing:1}}>Filtre</div>
          <input
            type="search"
            value={nameFilter}
            onChange={e=>setNameFilter(e.target.value)}
            placeholder="İsim, ns veya id…"
            style={{width:"100%",boxSizing:"border-box",background:"#020817",border:"1px solid #1E293B",borderRadius:6,color:"#E2E8F0",fontSize:11,padding:"6px 8px",outline:"none",marginBottom:8}}
          />
          <div style={{fontSize:9,color:"#475569",marginBottom:4}}>Sağlık</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
            {[
              {k:"all",l:"Tümü",c:"#64748B"},
              {k:"critical",l:"Kritik",c:"#EF4444"},
              {k:"warning",l:"Uyarı",c:"#F59E0B"},
              {k:"info",l:"Bilgi",c:"#60A5FA"},
              {k:"ok",l:"OK",c:"#22C55E"},
            ].map(({k,l,c})=>(
              <button
                key={k}
                type="button"
                onClick={()=>setHealthFilter(k)}
                style={{
                  border:`1px solid ${healthFilter===k?c:"#334155"}`,
                  background:healthFilter===k?`${c}22`:"#0F172A",
                  color:healthFilter===k?c:"#94A3B8",
                  borderRadius:6,
                  padding:"3px 8px",
                  fontSize:10,
                  cursor:"pointer",
                  fontWeight:healthFilter===k?700:500,
                }}
              >{l}</button>
            ))}
          </div>
        </div>
        {/* NS */}
        <div style={{padding:"8px 14px",borderBottom:"1px solid #1E293B"}}>
          <label htmlFor="ns-filter-select" style={{display:"block",fontSize:10,color:"#475569",marginBottom:6,textTransform:"uppercase",letterSpacing:1}}>Namespace</label>
          <select
            id="ns-filter-select"
            value={nsSelectValue}
            onChange={e=>setNsFilter(e.target.value)}
            style={{
              width:"100%",
              boxSizing:"border-box",
              background:"#020817",
              border:"1px solid #1E293B",
              borderRadius:6,
              color:"#E2E8F0",
              fontSize:12,
              padding:"6px 8px",
              outline:"none",
              cursor:"pointer",
              appearance:"auto",
            }}
          >
            <option value="all">Tüm namespace’ler</option>
            {namespaces.map(ns=>(
              <option key={ns} value={ns}>{ns}</option>
            ))}
          </select>
        </div>
        {/* Kinds */}
        <div style={{padding:"8px 14px",flex:1,overflowY:"auto"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:6,marginBottom:6}}>
            <span style={{fontSize:10,color:"#475569",textTransform:"uppercase",letterSpacing:1}}>Türler</span>
            <div style={{display:"flex",gap:4}}>
              <button type="button" onClick={selectAllKinds} style={{background:"#0F172A",border:"1px solid #334155",color:"#94A3B8",borderRadius:4,padding:"2px 6px",fontSize:9,cursor:"pointer"}}>Tümü</button>
              <button type="button" onClick={clearAllKinds} style={{background:"#0F172A",border:"1px solid #334155",color:"#94A3B8",borderRadius:4,padding:"2px 6px",fontSize:9,cursor:"pointer"}}>Temizle</button>
            </div>
          </div>
          {Object.entries(KINDS).map(([k,v])=>(
            <div key={k} onClick={()=>toggleKind(k)} style={{display:"flex",alignItems:"center",gap:7,padding:"3px 6px",borderRadius:6,cursor:"pointer",marginBottom:2,opacity:typeFilters.has(k)?1:0.28}}>
              <div style={{width:9,height:9,borderRadius:2,background:v.color,flexShrink:0}}/>
              <span style={{fontSize:11,color:"#94A3B8",flex:1}}>{k}</span>
              {kindCounts[k]&&<span style={{fontSize:10,color:v.color,fontWeight:600}}>{kindCounts[k]}</span>}
            </div>
          ))}
        </div>
        {/* Edge legend */}
        <div style={{padding:"8px 14px",borderTop:"1px solid #1E293B"}}>
          {Object.entries(EDGE_COLORS).map(([t,c])=>(
            <div key={t} style={{display:"flex",alignItems:"center",gap:7,marginBottom:3}}>
              <div style={{width:18,height:2,background:c,borderRadius:1}}/>
              <span style={{fontSize:10,color:"#64748B"}}>{EDGE_LEGEND_TR[t]||t}</span>
            </div>
          ))}
          <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:3}}>
            <div style={{width:18,height:2,background:"#22D3EE",borderRadius:1}}/>
            <span style={{fontSize:10,color:"#64748B"}}>Mesh RPS (Prometheus)</span>
          </div>
        </div>
      </div>

      {/* Canvas */}
      <div style={{flex:1,position:"relative",overflow:"hidden",display:"flex",flexDirection:"column"}}>
        {fetchWarnings.length>0&&(
          <div style={{flexShrink:0,background:"#422006",borderBottom:"1px solid #D97706",color:"#FDE68A",fontSize:11,padding:"6px 12px",lineHeight:1.4}}>
            <b>Kısmi API uyarısı</b> — {fetchWarnings.length} istek başarısız; grafik mevcut verilerle gösteriliyor. {fetchWarnings.slice(0,2).join(" · ")}{fetchWarnings.length>2?" …":""}
          </div>
        )}
        <div style={{position:"absolute",top:fetchWarnings.length?44:12,left:12,right:12,zIndex:10,display:"flex",flexDirection:"column",gap:6}}>
          <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
            {ghostBtn("← Menü",()=>{setScreen("home");setSelected(null);})}
            {ghostBtn("📋 Yeni",()=>setScreen("input"))}
            {ghostBtn(loading?"…":"Yenile",()=>fetchAPI())}
            <select value={String(refreshIntervalSec)} onChange={e=>setRefreshIntervalSec(Number(e.target.value))} style={{background:"#0F172A",border:"1px solid #1E293B",borderRadius:6,color:"#94A3B8",fontSize:11,padding:"4px 8px",cursor:"pointer"}}>
              <option value="0">Otomatik kapalı</option>
              <option value="30">30 sn</option>
              <option value="60">1 dk</option>
              <option value="120">2 dk</option>
            </select>
            {lastRefreshAt&&<span style={{fontSize:10,color:"#475569"}}>Son: {lastRefreshAt.toLocaleTimeString()}</span>}
            {critCount>0&&<div style={{background:"#7F1D1D",border:"1px solid #EF4444",borderRadius:20,padding:"3px 10px",fontSize:11,color:"#FCA5A5",fontWeight:700}}>🔴 {critCount}</div>}
            {warnCount>0&&<div style={{background:"#451A03",border:"1px solid #F59E0B",borderRadius:20,padding:"3px 10px",fontSize:11,color:"#FCD34D",fontWeight:700}}>🟡 {warnCount}</div>}
            {infoCount>0&&<div style={{background:"#0C1A3A",border:"1px solid #60A5FA",borderRadius:20,padding:"3px 10px",fontSize:11,color:"#93C5FD",fontWeight:700}}>🔵 {infoCount}</div>}
          </div>
          <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
            <div style={{display:"flex",border:"1px solid #1E293B",borderRadius:6,overflow:"hidden"}}>
              <button type="button" onClick={()=>setGraphView("graph")} style={{background:graphView==="graph"?"#1E3A5F":"#0F172A",border:"none",color:graphView==="graph"?"#60A5FA":"#64748B",padding:"4px 10px",fontSize:11,cursor:"pointer"}}>Grafik</button>
              <button type="button" onClick={()=>setGraphView("table")} style={{background:graphView==="table"?"#1E3A5F":"#0F172A",border:"none",color:graphView==="table"?"#60A5FA":"#64748B",padding:"4px 10px",fontSize:11,cursor:"pointer"}}>Tablo</button>
            </div>
            {ghostBtn("SVG indir",exportTopologySvg)}
            {ghostBtn("CSV indir",exportTableCsv)}
            {ghostBtn("Anlık kaydet",()=>{
              if(!graphData)return;
              setSnapshotBaseline({ids:[...new Set(graphData.nodes.map(n=>n.id))].sort(),t:Date.now()});
              const snap=makeSnapshot(graphData);
              setSnapshotHistory(prev=>[snap,...prev.filter(s=>s.id!==snap.id)].slice(0,12));
              setCompareSnapshotId(snap.id);
              setDiffSummary(null);
            })}
            {ghostBtn("Karşılaştır",()=>{
              if(!snapshotBaseline||!graphData){setDiffSummary(null);return;}
              const now=new Set(graphData.nodes.map(n=>n.id));
              const baseline=new Set(snapshotBaseline.ids);
              let added=0,removed=0;
              for(const id of now)if(!baseline.has(id))added++;
              for(const id of baseline)if(!now.has(id))removed++;
              setDiffSummary({added,removed,total:graphData.nodes.length});
            })}
            <label style={{display:"flex",alignItems:"center",gap:4,fontSize:10,color:"#64748B",cursor:"pointer"}}>
              <input type="checkbox" checked={namespaceLanes} onChange={e=>setNamespaceLanes(e.target.checked)}/> NS şeridi
            </label>
            <label style={{display:"flex",alignItems:"center",gap:4,fontSize:10,color:"#64748B",cursor:"pointer"}}>
              <input type="checkbox" checked={maskSecrets} onChange={e=>setMaskSecrets(e.target.checked)}/> Secret gizle
            </label>
            {diffSummary&&<span style={{fontSize:10,color:"#A78BFA"}}>Δ +{diffSummary.added} / −{diffSummary.removed} (toplam {diffSummary.total})</span>}
          </div>
          <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
            <span style={{fontSize:10,color:"#475569",textTransform:"uppercase",letterSpacing:0.5}}>Geçmiş</span>
            <select value={compareSnapshotId} onChange={e=>setCompareSnapshotId(e.target.value)} style={{background:"#0F172A",border:"1px solid #1E293B",borderRadius:6,color:"#94A3B8",fontSize:11,padding:"4px 8px",cursor:"pointer",minWidth:220}}>
              <option value="">Snapshot seçin</option>
              {snapshotHistory.map(s=>(
                <option key={s.id} value={s.id}>{new Date(s.createdAt).toLocaleString()} · {s.total} kaynak</option>
              ))}
            </select>
            {historyDiff&&<span style={{fontSize:10,color:"#CBD5E1"}}>Eklenen {historyDiff.added.length} · Silinen {historyDiff.removed.length} · Durum değişen {historyDiff.changed.length}</span>}
          </div>
          <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap",maxWidth:"100%"}}>
            <span style={{fontSize:10,color:"#475569",textTransform:"uppercase",letterSpacing:0.5}}>Mesh / Prometheus</span>
            <select value={meshProfile} onChange={e=>setMeshProfile(e.target.value)} style={{background:"#0F172A",border:"1px solid #1E293B",borderRadius:6,color:"#94A3B8",fontSize:11,padding:"4px 8px",cursor:"pointer"}}>
              {Object.entries(MESH_PROFILES).map(([k,v])=>(<option key={k} value={k}>{v.label}</option>))}
            </select>
            <input
              type="url"
              value={prometheusUrl}
              onChange={e=>setPrometheusUrl(e.target.value)}
              placeholder="/prometheus veya tam URL"
              title="Örn: https://topology.example.com/prometheus — pod içi nginx proxy"
              style={{flex:"1 1 200px",minWidth:160,maxWidth:420,background:"#020817",border:"1px solid #1E293B",borderRadius:6,color:"#E2E8F0",fontSize:11,padding:"5px 8px",outline:"none"}}
            />
            {ghostBtn(meshLoading?"Trafik…":"Trafik yenile",()=>void loadMeshTraffic())}
            {meshFetchedAt&&<span style={{fontSize:10,color:"#22D3EE"}}>RPS: {meshFetchedAt.toLocaleTimeString()}</span>}
            {meshErr&&<span style={{fontSize:10,color:"#F87171",maxWidth:280,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}} title={meshErr}>{meshErr}</span>}
          </div>
        </div>
        {graphView==="table"?(
          <div style={{flex:1,overflow:"auto",marginTop:132,padding:"8px 12px",boxSizing:"border-box"}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
              <thead>
                <tr style={{textAlign:"left",color:"#64748B",borderBottom:"1px solid #1E293B"}}>
                  <th style={{padding:"6px 8px"}}>Tür</th><th style={{padding:"6px 8px"}}>Ad</th><th style={{padding:"6px 8px"}}>NS</th><th style={{padding:"6px 8px"}}>Durum</th><th style={{padding:"6px 8px"}}>Sağlık</th>
                </tr>
              </thead>
              <tbody>
                {filtered.nodes.map(n=>{
                  const h=nodeHealthLevel(n.id,issues);
                  const disp=maskSecrets&&n.kind==="Secret"?"••••":n.name;
                  return(
                    <tr key={n.id} onClick={()=>setSelected(n)} style={{cursor:"pointer",borderBottom:"1px solid #0F172A",background:selected?.id===n.id?"#1E293B":"transparent"}}
                      onMouseEnter={e=>{if(selected?.id!==n.id)e.currentTarget.style.background="#0F172A";}}
                      onMouseLeave={e=>{e.currentTarget.style.background=selected?.id===n.id?"#1E293B":"transparent";}}>
                      <td style={{padding:"6px 8px",color:KINDS[n.kind]?.color,fontFamily:"monospace"}}>{KINDS[n.kind]?.tag||n.kind}</td>
                      <td style={{padding:"6px 8px",color:"#E2E8F0"}}>{disp}</td>
                      <td style={{padding:"6px 8px",color:"#64748B"}}>{n.namespace}</td>
                      <td style={{padding:"6px 8px",color:"#94A3B8"}}>{n.status}</td>
                      <td style={{padding:"6px 8px",color:HEALTH_COLORS[h]}}>{h}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ):(
          <svg ref={svgRef} style={{flex:1,width:"100%",minHeight:0,background:"radial-gradient(ellipse at 50% 50%, #0D1B2A 0%, #020817 100%)"}}/>
        )}
        {graphView==="graph"&&<div style={{position:"absolute",bottom:16,left:16,background:"#0F172A99",border:"1px solid #1E293B",borderRadius:8,padding:"5px 12px",fontSize:11,color:"#475569"}}>
          scroll=zoom · drag=pan · click=detay
        </div>}
      </div>

      {/* Right panel resize (drag left/right) */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Sağ panel genişliği"
        title="Sürükleyerek genişlet"
        onMouseDown={onRightPanelResizeStart}
        style={{
          width: 6,
          flexShrink: 0,
          cursor: "ew-resize",
          background: "#0c1629",
          borderLeft: "1px solid #1E293B",
          borderRight: "1px solid #1E293B",
        }}
      />

      {/* Right panel */}
      <div style={{width:rightPanelWidth,minWidth:200,maxWidth:900,background:"#0A1628",display:"flex",flexDirection:"column",overflow:"hidden",flexShrink:0}}>

        {hotServices.length>0&&(
          <div style={{borderBottom:"1px solid #1E293B",flexShrink:0,padding:"8px 12px",maxHeight:140,overflowY:"auto"}}>
            <div style={{fontSize:10,color:"#475569",textTransform:"uppercase",letterSpacing:1,marginBottom:6}}>Yoğun servisler (gelen)</div>
            {hotServices.map((h,i)=>(
              <div key={`${h.ns}/${h.name}-${i}`} style={{fontSize:10,marginBottom:4,lineHeight:1.35}}>
                <span style={{color:"#22D3EE",fontFamily:"monospace"}}>{formatShortRps(h.rps)} rps</span>
                <span style={{color:"#94A3B8"}}> · {h.ns}/{h.name}</span>
                {h.errPct>=1&&<span style={{color:"#F87171"}}> · {(h.errPct).toFixed(1)}% 5xx</span>}
              </div>
            ))}
          </div>
        )}

        {/* Events */}
        <div style={{borderBottom:"1px solid #1E293B",flexShrink:0}}>
          <div onClick={()=>setEventsOpen(o=>!o)} style={{padding:"8px 14px",cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center",userSelect:"none"}}>
            <span style={{fontWeight:600,fontSize:12}}>📜 Events ({clusterEvents.length})</span>
            <span style={{color:"#64748B",fontSize:11}}>{eventsOpen?"▼":"▶"}</span>
          </div>
          {eventsOpen&&(
            <div style={{maxHeight:160,overflowY:"auto",padding:"0 10px 8px",fontSize:10}}>
              {clusterEvents.length===0&&<div style={{color:"#475569",padding:"6px 0"}}>Kayıt yok veya API erişilemedi</div>}
              {clusterEvents.slice(0,80).map(ev=>(
                <div key={ev.id} style={{borderBottom:"1px solid #0F172A",padding:"5px 0",lineHeight:1.35}}>
                  <div style={{color:ev.type==="Warning"?"#F59E0B":"#94A3B8",fontWeight:600}}>{ev.reason||"—"} <span style={{color:"#475569",fontWeight:400}}>{ev.ns}</span></div>
                  <div style={{color:"#64748B"}}>{ev.obj}</div>
                  <div style={{color:"#CBD5E1"}}>{ev.msg}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {historyDiff&&(
          <div style={{borderBottom:"1px solid #1E293B",padding:"8px 12px",flexShrink:0}}>
            <div style={{fontSize:10,color:"#475569",textTransform:"uppercase",letterSpacing:1,marginBottom:6}}>Snapshot farkı</div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:6}}>
              <span style={{fontSize:10,color:"#86EFAC"}}>+ {historyDiff.added.length}</span>
              <span style={{fontSize:10,color:"#FCA5A5"}}>- {historyDiff.removed.length}</span>
              <span style={{fontSize:10,color:"#FCD34D"}}>~ {historyDiff.changed.length}</span>
            </div>
            <div style={{fontSize:10,color:"#94A3B8",lineHeight:1.45,maxHeight:84,overflowY:"auto"}}>
              {historyDiff.added.slice(0,2).map(n=><div key={`a-${n.id}`}>+ {n.kind} {n.namespace}/{n.name}</div>)}
              {historyDiff.removed.slice(0,2).map(n=><div key={`r-${n.id}`}>- {n.kind} {n.namespace}/{n.name}</div>)}
              {historyDiff.changed.slice(0,2).map(c=><div key={`c-${c.after.id}`}>~ {c.after.kind} {c.after.namespace}/{c.after.name}: {c.before.status} → {c.after.status}</div>)}
            </div>
          </div>
        )}

        {/* Alerts */}
        <div style={{borderBottom:"1px solid #1E293B"}}>
          <div onClick={()=>setAlertsOpen(o=>!o)} style={{padding:"10px 14px",cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center",userSelect:"none"}}>
            <span style={{fontWeight:700,fontSize:13}}>⚠️ Sorunlar & Bottleneck</span>
            <div style={{display:"flex",alignItems:"center",gap:6}}>
              {critCount>0&&<span style={{background:"#EF444422",color:"#EF4444",fontSize:10,fontWeight:700,padding:"1px 6px",borderRadius:10}}>{critCount}</span>}
              {warnCount>0&&<span style={{background:"#F59E0B22",color:"#F59E0B",fontSize:10,fontWeight:700,padding:"1px 6px",borderRadius:10}}>{warnCount}</span>}
              <span style={{color:"#64748B",fontSize:12}}>{alertsOpen?"▼":"▶"}</span>
            </div>
          </div>
          {alertsOpen&&(
            <div style={{maxHeight:280,overflowY:"auto",padding:"0 10px 10px"}}>
              {issues.length===0&&<div style={{textAlign:"center",padding:"16px 0",color:"#22C55E",fontSize:13}}>✅ Tüm kaynaklar sağlıklı</div>}
              {["critical","warning","info"].flatMap(level=>
                issues.filter(i=>i.level===level).map(issue=>{
                  const n=filtered.nodes.find(n=>n.id===issue.id);
                  return(
                    <div key={issue.id+issue.code} onClick={()=>n&&setSelected(n)}
                      style={{background:level==="critical"?"#1C0505":level==="warning"?"#1C1005":"#051525",
                        border:`1px solid ${HEALTH_COLORS[level]}44`,borderRadius:8,padding:"8px 10px",marginBottom:6,cursor:"pointer"}}>
                      <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                        <span style={{fontSize:10,fontWeight:700,fontFamily:"monospace",color:HEALTH_COLORS[level],background:`${HEALTH_COLORS[level]}22`,padding:"1px 6px",borderRadius:4}}>{issue.code}</span>
                        {n&&<span style={{fontSize:9,color:"#475569"}}>{n.kind}</span>}
                      </div>
                      <div style={{fontSize:11,color:"#E2E8F0",marginBottom:4,lineHeight:1.4}}>{issue.msg}</div>
                      <div style={{fontSize:10,color:"#64748B",lineHeight:1.4}}>💡 {issue.fix}</div>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>

        {/* Detail */}
        {selected?(
          <div style={{flex:1,minHeight:0,display:"flex",flexDirection:"column",overflow:"hidden"}}>
            <div style={{
              flex: selected.kind==="Pod" ? "0 1 auto" : 1,
              maxHeight: selected.kind==="Pod" ? "46%" : undefined,
              minHeight: 0,
              overflowY: "auto",
              padding: 14,
              boxSizing: "border-box",
            }}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <span style={{fontWeight:700,fontSize:13}}>Detay</span>
              <button onClick={()=>setSelected(null)} style={{background:"transparent",border:"none",color:"#64748B",cursor:"pointer",fontSize:18,lineHeight:1}}>×</button>
            </div>
            {(()=>{
              const plural=KUBECTL_PLURAL[selected.kind]||`${selected.kind.toLowerCase()}s`;
              const getL=`kubectl get ${plural} ${selected.name} -n ${selected.namespace}`;
              const descL=`kubectl describe ${plural} ${selected.name} -n ${selected.namespace}`;
              return(
                <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:10}}>
                  <button type="button" onClick={()=>copyText(getL)} style={{background:"#14532D",border:"1px solid #166534",color:"#BBF7D0",borderRadius:6,padding:"4px 8px",fontSize:10,cursor:"pointer"}}>get kopyala</button>
                  <button type="button" onClick={()=>copyText(descL)} style={{background:"#0F172A",border:"1px solid #334155",color:"#CBD5E1",borderRadius:6,padding:"4px 8px",fontSize:10,cursor:"pointer"}}>describe kopyala</button>
                </div>
              );
            })()}
            {(()=>{const h=nodeHealthLevel(selected.id,issues);return(
              <div style={{display:"inline-flex",alignItems:"center",gap:6,background:`${HEALTH_COLORS[h]}22`,border:`1px solid ${HEALTH_COLORS[h]}55`,borderRadius:20,padding:"3px 12px",marginBottom:10,fontSize:11,color:HEALTH_COLORS[h],fontWeight:600}}>
                {h==="critical"?"🔴 Kritik":h==="warning"?"🟡 Uyarı":h==="info"?"🔵 Bilgi":"🟢 Sağlıklı"}
              </div>
            );})()} {" "}
            <span style={{background:`${KINDS[selected.kind]?.color}22`,border:`1px solid ${KINDS[selected.kind]?.color}55`,borderRadius:6,padding:"2px 10px",fontSize:11,color:KINDS[selected.kind]?.color,fontFamily:"monospace"}}>
              {KINDS[selected.kind]?.tag} {selected.kind}
            </span>

            {detailNode&&(detailNode.trafficInRps!=null||detailNode.trafficOutRps!=null)&&(
              <div style={{marginTop:10,padding:"8px 10px",background:"#042f2e",border:"1px solid #134e4a",borderRadius:8}}>
                <div style={{fontSize:10,color:"#5eead4",textTransform:"uppercase",letterSpacing:1,marginBottom:6}}>Mesh trafiği (5m rate)</div>
                {detailNode.trafficInRps!=null&&(
                  <div style={{fontSize:12,color:"#ccfbf1",marginBottom:4}}>
                    ↓ Gelen: <b>{formatShortRps(detailNode.trafficInRps)}</b> rps
                    {detailNode.trafficErrRatio>0.005&&<span style={{color:"#fca5a5"}}> · ~{(detailNode.trafficErrRatio*100).toFixed(1)}% 5xx</span>}
                  </div>
                )}
                {detailNode.trafficOutRps!=null&&(
                  <div style={{fontSize:12,color:"#ccfbf1"}}>↑ Giden: <b>{formatShortRps(detailNode.trafficOutRps)}</b> rps</div>
                )}
              </div>
            )}

            {dependencyImpact&&(
              <div style={{marginTop:10,padding:"8px 10px",background:"#111827",border:"1px solid #1F2937",borderRadius:8}}>
                <div style={{fontSize:10,color:"#93C5FD",textTransform:"uppercase",letterSpacing:1,marginBottom:6}}>Bağımlılık etkisi</div>
                <div style={{display:"flex",gap:10,flexWrap:"wrap",fontSize:11,marginBottom:6}}>
                  <span style={{color:"#CBD5E1"}}>Doğrudan upstream: <b>{dependencyImpact.directUpstream.length}</b></span>
                  <span style={{color:"#CBD5E1"}}>Doğrudan downstream: <b>{dependencyImpact.directDownstream.length}</b></span>
                  <span style={{color:"#FCA5A5"}}>Etkilenebilecek kaynak: <b>{dependencyImpact.impactedWorkloads.length}</b></span>
                </div>
                <div style={{fontSize:10,color:"#94A3B8",lineHeight:1.45}}>
                  {dependencyImpact.directUpstream.slice(0,3).map(n=><div key={`up-${n.id}`}>↑ {n.kind} {n.namespace}/{maskSecrets&&n.kind==="Secret"?"••••":n.name}</div>)}
                  {dependencyImpact.directDownstream.slice(0,4).map(n=><div key={`dn-${n.id}`}>↓ {n.kind} {n.namespace}/{maskSecrets&&n.kind==="Secret"?"••••":n.name}</div>)}
                </div>
              </div>
            )}

            <div style={{marginTop:12}}>
              {[[ "Ad", maskSecrets&&selected.kind==="Secret"?"••••":selected.name, "monospace"],["Namespace",selected.namespace],["Durum",selected.status],
                ...(selected.kind==="Node"&&selected.nodeRoles?.length?[["Rol",selected.nodeRoles.join(", ")]]:[]),
                ...(selected.kind==="Node"&&selected.nodeVersion?[["Kubelet",selected.nodeVersion]]:[]),
                ...(selected.kind==="Pod"&&selected.nodeName?[["Node",selected.nodeName]]:[]),
                ...(selected.kind==="Node"&&selected.podCount!=null?[["Pod sayısı",String(selected.podCount)]]:[]),
                ...(selected.restarts>0?[["Yeniden Başlama",`${selected.restarts} kez`]]:[]),
                ...(selected.cpuPercent!=null?[["CPU Kullanımı",`%${selected.cpuPercent}`,null,selected.cpuPercent>80?"#EF4444":selected.cpuPercent>60?"#F59E0B":"#22C55E"]]:[]),
                ...(selected.metricsCpuMilli!=null&&selected.cpuPercent==null?[["CPU (metrics)",`${selected.metricsCpuMilli}m`,null,"#94A3B8"]]:[]),
                ...(selected.memPercent!=null?[["Memory Kullanımı",`%${selected.memPercent}`,null,selected.memPercent>85?"#EF4444":selected.memPercent>70?"#F59E0B":"#22C55E"]]:[]),
              ].map(([l,v,ff,vc])=>(
                <div key={l} style={{marginBottom:9}}>
                  <div style={{fontSize:10,color:"#475569",textTransform:"uppercase",letterSpacing:1,marginBottom:2}}>{l}</div>
                  <div style={{fontSize:13,wordBreak:"break-all",fontFamily:ff||"inherit",color:vc||"#E2E8F0"}}>{v}</div>
                </div>
              ))}
            </div>

            {selected.kind==="Pod"&&selected.podImageInfo&&(
              <div style={{marginTop:10,marginBottom:4}}>
                <div style={{fontSize:10,color:"#475569",textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>Container imajları</div>
                <div style={{fontSize:11,fontFamily:"ui-monospace,monospace",color:"#CBD5E1",whiteSpace:"pre-wrap",wordBreak:"break-all",lineHeight:1.45}}>{selected.podImageInfo}</div>
              </div>
            )}

            {selected.kind==="Node"&&selected.nodePressure?.length>0&&(
              <div style={{marginTop:10,marginBottom:4}}>
                <div style={{fontSize:10,color:"#475569",textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>Node condition</div>
                <div style={{fontSize:11,color:"#CBD5E1",lineHeight:1.45}}>
                  {selected.nodePressure.map(p=>(
                    <div key={p.type} style={{color:p.status?"#FCD34D":"#64748B"}}>{p.type}: {p.status?"aktif":"yok"}</div>
                  ))}
                </div>
              </div>
            )}

            {selected.kind==="AzureService"&&(
              <div style={{marginTop:10,marginBottom:4}}>
                <div style={{fontSize:10,color:"#475569",textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>Azure servis bilgisi</div>
                <div style={{fontSize:11,color:"#CBD5E1",lineHeight:1.5}}>
                  <div>Tür: {selected.azureServiceType || "Azure Service"}</div>
                  <div>Güven: <span style={{color:selected.azureConfidence==="confirmed"?"#86EFAC":"#FCD34D"}}>{selected.azureConfidence==="confirmed"?"Confirmed":"Inferred"}</span></div>
                  <div>Kanıt: {selected.azureEvidence || "metadata"}</div>
                </div>
              </div>
            )}

            {selectedAzureDeps.length>0&&selected.kind!=="AzureService"&&(
              <div style={{marginTop:10,marginBottom:4}}>
                <div style={{fontSize:10,color:"#475569",textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>Azure Dependencies</div>
                <div style={{fontSize:11,lineHeight:1.45}}>
                  {selectedAzureDeps.map(dep=>(
                    <div key={dep.id} onClick={()=>setSelected(dep)} style={{cursor:"pointer",padding:"4px 0",borderBottom:"1px solid #0F172A"}}>
                      <span style={{color:"#60A5FA"}}>{dep.azureServiceType || "Azure Service"}</span>
                      <span style={{color:"#CBD5E1"}}> · {dep.name}</span>
                      <span style={{color:dep.azureConfidence==="confirmed"?"#86EFAC":"#FCD34D"}}> · {dep.azureConfidence==="confirmed"?"Confirmed":"Inferred"}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {selected.resources&&(
              <div style={{marginTop:10,marginBottom:4}}>
                <div style={{fontSize:10,color:"#475569",textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>İstek / limit</div>
                <div style={{fontSize:11,color:"#CBD5E1",lineHeight:1.5}}>
                  {selected.resources.reqCpuMilli!=null&&<div>CPU istek: {formatCpuRequestMilli(selected.resources.reqCpuMilli)}</div>}
                  {selected.resources.limCpuMilli!=null&&<div>CPU limit: {formatCpuRequestMilli(selected.resources.limCpuMilli)}</div>}
                  {selected.resources.reqMemMi!=null&&<div>Memory istek: {formatMemoryMi(selected.resources.reqMemMi)}</div>}
                  {selected.resources.limMemMi!=null&&<div>Memory limit: {formatMemoryMi(selected.resources.limMemMi)}</div>}
                  {selected.metricsCpuMilli!=null&&selected.resources.reqCpuMilli!=null&&(
                    <div style={{color:selected.metricsCpuMilli>selected.resources.reqCpuMilli?"#FCD34D":"#86EFAC"}}>
                      Canlı CPU / istek: {selected.metricsCpuMilli}m / {selected.resources.reqCpuMilli}m
                    </div>
                  )}
                </div>
              </div>
            )}

            {selected.rollout&&(
              <div style={{marginTop:10,marginBottom:4}}>
                <div style={{fontSize:10,color:"#475569",textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>Rollout</div>
                <div style={{fontSize:11,color:"#CBD5E1",lineHeight:1.5}}>
                  {selected.rollout.revision&&<div>Revizyon: {selected.rollout.revision}</div>}
                  {selected.rollout.changeCause&&<div>Change cause: {selected.rollout.changeCause}</div>}
                  {selected.rollout.owners?.length>0&&<div>Sahip: {selected.rollout.owners.join(", ")}</div>}
                  {rolloutNodes.length>0&&(
                    <div style={{marginTop:4,color:"#93C5FD"}}>
                      İlgili {selected.kind==="Deployment"?"ReplicaSet":"Pod"}: {rolloutNodes.slice(0,4).map(n=>n.name).join(", ")}{rolloutNodes.length>4?" …":""}
                    </div>
                  )}
                </div>
              </div>
            )}

            {selectedEvents.length>0&&(
              <div style={{marginTop:10,marginBottom:4}}>
                <div style={{fontSize:10,color:"#475569",textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>Kaynağa özel event</div>
                <div style={{maxHeight:120,overflowY:"auto",fontSize:10,lineHeight:1.45}}>
                  {selectedEvents.slice(0,6).map(ev=>(
                    <div key={`sel-ev-${ev.id}`} style={{padding:"4px 0",borderBottom:"1px solid #0F172A"}}>
                      <div style={{color:ev.type==="Warning"?"#F59E0B":"#94A3B8"}}>{ev.reason||"—"} <span style={{color:"#475569"}}>{ev.last?new Date(ev.last).toLocaleTimeString():""}</span></div>
                      <div style={{color:"#CBD5E1"}}>{ev.msg}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Node issues */}
            {issues.filter(i=>i.id===selected.id).length>0&&(
              <div style={{marginTop:8,marginBottom:12}}>
                <div style={{fontSize:10,color:"#475569",textTransform:"uppercase",letterSpacing:1,marginBottom:6}}>Sorunlar</div>
                {issues.filter(i=>i.id===selected.id).map(issue=>(
                  <div key={issue.code} style={{background:`${HEALTH_COLORS[issue.level]}11`,border:`1px solid ${HEALTH_COLORS[issue.level]}33`,borderRadius:7,padding:"7px 9px",marginBottom:5}}>
                    <div style={{fontSize:10,fontWeight:700,color:HEALTH_COLORS[issue.level],fontFamily:"monospace",marginBottom:3}}>{issue.code}</div>
                    <div style={{fontSize:11,color:"#CBD5E1",marginBottom:4}}>{issue.msg}</div>
                    <div style={{fontSize:10,color:"#64748B"}}>💡 {issue.fix}</div>
                  </div>
                ))}
              </div>
            )}

            {/* Connections */}
            {(()=>{
              const conns=filtered.edges.filter(e=>e.source===selected.id||e.target===selected.id);
              if(!conns.length) return null;
              return(
                <div>
                  <div style={{fontSize:10,color:"#475569",textTransform:"uppercase",letterSpacing:1,marginBottom:6}}>Bağlantılar ({conns.length})</div>
                  {conns.slice(0,14).map(e=>{
                    const isOut=e.source===selected.id, otherId=isOut?e.target:e.source;
                    const other=filtered.nodes.find(n=>n.id===otherId); if(!other) return null;
                    const oh=nodeHealthLevel(other.id,issues);
                    return(
                      <div key={e.id} onClick={()=>setSelected(other)}
                        style={{display:"flex",alignItems:"center",gap:6,padding:"5px 8px",borderRadius:7,cursor:"pointer",marginBottom:2,
                          background:oh==="critical"?"#1C0505":oh==="warning"?"#1C1005":"#0F172A",
                          border:`1px solid ${oh!=="ok"?HEALTH_COLORS[oh]+"44":"transparent"}`}}>
                        <span style={{color:EDGE_COLORS[e.type],fontSize:11}}>{isOut?"→":"←"}</span>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{fontSize:11,color:"#E2E8F0",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{maskSecrets&&other.kind==="Secret"?"••••":other.name}</div>
                          <div style={{fontSize:9,color:"#475569"}}>{e.type}{e.label?` · ${e.label}`:""}</div>
                        </div>
                        <span style={{fontSize:9,color:KINDS[other.kind]?.color,fontFamily:"monospace"}}>{KINDS[other.kind]?.tag}</span>
                        {oh!=="ok"&&<span style={{fontSize:10}}>{oh==="critical"?"🔴":"🟡"}</span>}
                      </div>
                    );
                  })}
                </div>
              );
            })()}
            </div>
            {selected.kind==="Pod"&&(
              <div style={{
                flex: 1,
                minHeight: 96,
                display: "flex",
                flexDirection: "column",
                borderTop: "1px solid #1E293B",
                padding: "10px 14px 12px",
                boxSizing: "border-box",
                overflow: "hidden",
              }}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:8,flexShrink:0}}>
                  <div style={{fontSize:10,color:"#475569",textTransform:"uppercase",letterSpacing:1}}>Pod logları</div>
                  <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
                    {selected.podContainers?.length>1&&(
                      <select value={podLogContainer} onChange={e=>setPodLogContainer(e.target.value)} style={{background:"#020817",border:"1px solid #1E293B",borderRadius:6,color:"#E2E8F0",fontSize:11,padding:"4px 8px",cursor:"pointer"}}>
                        {selected.podContainers.map(nm=>(<option key={nm} value={nm}>{nm}</option>))}
                      </select>
                    )}
                    <button type="button" onClick={()=>setPodLogTick(t=>t+1)} style={{background:"#1E3A5F",border:"1px solid #3B82F6",color:"#93C5FD",borderRadius:6,padding:"4px 10px",fontSize:10,cursor:"pointer"}}>Yenile</button>
                  </div>
                </div>
                <div style={{flex:1,minHeight:0,overflowY:"scroll",overflowX:"auto",WebkitOverflowScrolling:"touch",marginTop:8}}>
                  {podLogLoading&&<div style={{fontSize:11,color:"#64748B",padding:"4px 0"}}>Yükleniyor…</div>}
                  {podLogErr&&!podLogLoading&&<div style={{fontSize:11,color:"#F87171",wordBreak:"break-word",padding:"4px 0"}}>{podLogErr}</div>}
                  {!podLogLoading&&podLogText&&(
                    <pre style={{margin:0,fontSize:10,lineHeight:1.35,background:"#020817",border:"1px solid #1E293B",borderRadius:8,padding:10,color:"#E2E8F0",whiteSpace:"pre-wrap",wordBreak:"break-word"}}>{podLogText}</pre>
                  )}
                  {!podLogLoading&&!podLogErr&&!podLogText&&selected.sampleLog===undefined&&<div style={{fontSize:11,color:"#64748B",padding:"4px 0"}}>Log boş veya henüz yüklenmedi.</div>}
                </div>
              </div>
            )}
          </div>
        ):(
          <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",color:"#334155",fontSize:13,padding:20,textAlign:"center",gap:8}}>
            <div style={{fontSize:36}}>👆</div>
            <div>Bir node'a tıklayın</div>
            <div style={{fontSize:11,color:"#1E293B"}}>Detayları, metrikleri ve sorunlarını görün</div>
          </div>
        )}
      </div>
    </div>
  );
}
