import { useState, useEffect, useRef, useMemo } from "react";
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

const KINDS = {
  Ingress:               { color: "#A855F7", tag: "ING" },
  Service:               { color: "#22C55E", tag: "SVC" },
  Deployment:            { color: "#3B82F6", tag: "DEP" },
  StatefulSet:           { color: "#F97316", tag: "STS" },
  DaemonSet:             { color: "#EF4444", tag: "DS"  },
  ReplicaSet:            { color: "#60A5FA", tag: "RS"  },
  Pod:                   { color: "#64748B", tag: "POD" },
  ConfigMap:             { color: "#EAB308", tag: "CM"  },
  Secret:                { color: "#94A3B8", tag: "SEC" },
  PersistentVolumeClaim: { color: "#14B8A6", tag: "PVC" },
  Job:                   { color: "#8B5CF6", tag: "JOB" },
  CronJob:               { color: "#EC4899", tag: "CJ"  },
};

const EDGE_COLORS = { routes:"#A855F7", selects:"#22C55E", owns:"#3B82F6", uses:"#EAB308", calls:"#F97316" };
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
    {id:"ing-web",  kind:"Ingress",    name:"web-ingress",      namespace:"production",status:"Active"},
    {id:"svc-fe",   kind:"Service",    name:"frontend-svc",     namespace:"production",status:"Active"},
    {id:"svc-api",  kind:"Service",    name:"api-svc",          namespace:"production",status:"Active"},
    {id:"svc-db",   kind:"Service",    name:"db-svc",           namespace:"production",status:"Active"},
    {id:"dep-fe",   kind:"Deployment", name:"frontend",         namespace:"production",status:"3/3"},
    {id:"dep-api",  kind:"Deployment", name:"api-server",       namespace:"production",status:"1/3"},
    {id:"sts-db",   kind:"StatefulSet",name:"postgres",         namespace:"production",status:"1/1"},
    {id:"pod-f1",   kind:"Pod",        name:"frontend-x7k2p",   namespace:"production",status:"Running",   cpuPercent:45,memPercent:52,restarts:0},
    {id:"pod-f2",   kind:"Pod",        name:"frontend-m9n3q",   namespace:"production",status:"Running",   cpuPercent:38,memPercent:48,restarts:1},
    {id:"pod-f3",   kind:"Pod",        name:"frontend-p4r8s",   namespace:"production",status:"Running",   cpuPercent:92,memPercent:61,restarts:0},
    {id:"pod-a1",   kind:"Pod",        name:"api-server-a2b3",  namespace:"production",status:"CrashLoopBackOff",cpuPercent:12,memPercent:18,restarts:14},
    {id:"pod-a2",   kind:"Pod",        name:"api-server-c4d5",  namespace:"production",status:"Pending",   cpuPercent:0, memPercent:0, restarts:0},
    {id:"pod-a3",   kind:"Pod",        name:"api-server-e6f7",  namespace:"production",status:"Running",   cpuPercent:55,memPercent:77,restarts:2},
    {id:"pod-db",   kind:"Pod",        name:"postgres-0",       namespace:"production",status:"Running",   cpuPercent:62,memPercent:88,restarts:0},
    {id:"cm-app",   kind:"ConfigMap",  name:"app-config",       namespace:"production",status:"Active"},
    {id:"cm-nginx", kind:"ConfigMap",  name:"nginx-config",     namespace:"production",status:"Active"},
    {id:"sec-tls",  kind:"Secret",     name:"tls-secret",       namespace:"production",status:"Active"},
    {id:"pvc-db",   kind:"PersistentVolumeClaim",name:"postgres-data",namespace:"production",status:"Bound"},
    {id:"dep-cache",kind:"Deployment", name:"redis-cache",      namespace:"production",status:"0/2"},
    {id:"svc-cache",kind:"Service",    name:"redis-svc",        namespace:"production",status:"Active"},
    {id:"pod-c1",   kind:"Pod",        name:"redis-0",          namespace:"production",status:"OOMKilled", cpuPercent:88,memPercent:98,restarts:7},
    {id:"pod-c2",   kind:"Pod",        name:"redis-1",          namespace:"production",status:"Evicted",   cpuPercent:0, memPercent:0, restarts:0},
    {id:"dep-prom", kind:"Deployment", name:"prometheus",       namespace:"monitoring",status:"1/1"},
    {id:"svc-prom", kind:"Service",    name:"prometheus-svc",   namespace:"monitoring",status:"Active"},
    {id:"pod-prom", kind:"Pod",        name:"prometheus-9x8y",  namespace:"monitoring",status:"Running",   cpuPercent:22,memPercent:41,restarts:0},
    {id:"dep-graf", kind:"Deployment", name:"grafana",          namespace:"monitoring",status:"1/1"},
    {id:"svc-graf", kind:"Service",    name:"grafana-svc",      namespace:"monitoring",status:"Active"},
    {id:"pod-graf", kind:"Pod",        name:"grafana-a1b2c3",   namespace:"monitoring",status:"Running",   cpuPercent:14,memPercent:33,restarts:0},
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
  ],
};

// ── kubectl parser ────────────────────────────────────────────────────────────
function getStatus(item) {
  if (item.kind==="Pod") return item.status?.phase||"Unknown";
  if (["Deployment","StatefulSet","DaemonSet"].includes(item.kind)) {
    return `${item.status?.readyReplicas??0}/${item.spec?.replicas??1}`;
  }
  if (item.kind==="PersistentVolumeClaim") return item.status?.phase||"Unknown";
  return "Active";
}
function getRestarts(item) {
  if (item.kind!=="Pod") return 0;
  return item.status?.containerStatuses?.reduce((a,c)=>a+(c.restartCount||0),0)||0;
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
  }
  const seen=new Set(); return edges.filter(e=>{const k=`${e.source}→${e.target}`;if(seen.has(k))return false;seen.add(k);return true;});
}
function parseKubectl(jsonStr) {
  const data=JSON.parse(jsonStr), items=data.items||(data.kind!=="List"?[data]:[]);
  const nodes=[],rawItems=[];
  for (const item of items) {
    if (!KINDS[item.kind]) continue;
    const ns=item.metadata?.namespace||"default";
    const id=`${item.kind.toLowerCase()}-${ns}-${item.metadata.name}`;
    nodes.push({id,kind:item.kind,name:item.metadata.name,namespace:ns,labels:item.metadata.labels||{},status:getStatus(item),restarts:getRestarts(item)});
    rawItems.push({...item,_id:id});
  }
  return {nodes,edges:buildEdges(nodes,rawItems)};
}

// ── D3 hook ──────────────────────────────────────────────────────────────────
function useGraph(svgRef, nodes, edges, issues, selectedId, onSelect) {
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

    const sim=d3.forceSimulation(sN)
      .force("link",d3.forceLink(sE).id(d=>d.id).distance(230).strength(0.4))
      .force("charge",d3.forceManyBody().strength(-850))
      .force("center",d3.forceCenter(W/2,H/2))
      .force("collide",d3.forceCollide(105))
      .force("x",d3.forceX(W/2).strength(0.04))
      .force("y",d3.forceY(H/2).strength(0.04));

    const linkG=g.append("g");
    const link=linkG.selectAll("line").data(sE).join("line")
      .attr("stroke",d=>EDGE_COLORS[d.type]||"#555")
      .attr("stroke-width",d=>{const sh=nodeHealthLevel(d.source,issues),th=nodeHealthLevel(d.target,issues);return(sh==="critical"||th==="critical")?2.5:1.5;})
      .attr("stroke-opacity",d=>{const sh=nodeHealthLevel(d.source,issues),th=nodeHealthLevel(d.target,issues);return(sh==="critical"||th==="critical")?0.75:0.35;})
      .attr("stroke-dasharray",d=>{const sh=nodeHealthLevel(d.source,issues),th=nodeHealthLevel(d.target,issues);return(sh==="critical"||th==="critical")?"7,3":null;})
      .attr("marker-end",d=>`url(#arr-${d.type})`);
    const linkLbl=linkG.selectAll("text").data(sE.filter(e=>e.label)).join("text")
      .attr("text-anchor","middle").attr("fill","#A855F7").attr("font-size","9px").attr("font-family","monospace").text(d=>d.label);

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
      .text(d=>d.name.length>21?d.name.slice(0,20)+"…":d.name);

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
        if(d.memPercent!=null) parts.push(`MEM:${d.memPercent}%`);
        return parts.join("  ");
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
  },[nodes,edges,issues,selectedId]);
}

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [screen,setScreen]=useState("home");
  const [graphData,setGraphData]=useState(null);
  const [selected,setSelected]=useState(null);
  const [nsFilter,setNsFilter]=useState("all");
  const [typeFilters,setTypeFilters]=useState(new Set(Object.keys(KINDS)));
  const [rawInput,setRawInput]=useState("");
  const [apiUrl,setApiUrl]=useState(()=>{
    if(typeof window==="undefined") return "http://127.0.0.1:8001";
    const h=window.location.hostname;
    if(h==="localhost"||h==="127.0.0.1") return "http://127.0.0.1:8001";
    return `${window.location.origin.replace(/\/$/,"")}/k8s-api`;
  });
  const [err,setErr]=useState("");
  const [loading,setLoading]=useState(false);
  const [alertsOpen,setAlertsOpen]=useState(true);
  const [clusterPresetId,setClusterPresetId]=useState(()=>CLUSTER_PRESETS[0]?.id||"");
  const [kubeconfigYaml,setKubeconfigYaml]=useState("");
  const [kubeContexts,setKubeContexts]=useState([]);
  const [apiFetchHeaders,setApiFetchHeaders]=useState({});
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

  const filtered=useMemo(()=>{
    if(!graphData) return {nodes:[],edges:[]};
    const nodes=graphData.nodes.filter(n=>(nsFilter==="all"||n.namespace===nsFilter)&&typeFilters.has(n.kind));
    const ids=new Set(nodes.map(n=>n.id));
    return {nodes,edges:graphData.edges.filter(e=>ids.has(e.source)&&ids.has(e.target))};
  },[graphData,nsFilter,typeFilters]);

  const issues=useMemo(()=>analyzeHealth(filtered.nodes,filtered.edges),[filtered]);
  const critCount=issues.filter(i=>i.level==="critical").length;
  const warnCount=issues.filter(i=>i.level==="warning").length;
  const infoCount=issues.filter(i=>i.level==="info").length;

  useGraph(svgRef,filtered.nodes,filtered.edges,issues,selected?.id,(n)=>setSelected(n));

  const namespaces=useMemo(()=>[...new Set((graphData?.nodes||[]).map(n=>n.namespace))].sort(),[graphData]);
  const kindCounts=useMemo(()=>{const c={};(graphData?.nodes||[]).forEach(n=>c[n.kind]=(c[n.kind]||0)+1);return c;},[graphData]);

  const loadDemo=()=>{setErr("");setGraphData(DEMO);setSelected(null);setNsFilter("all");setScreen("graph");};
  const applyInput=()=>{setErr("");try{setGraphData(parseKubectl(rawInput));setSelected(null);setNsFilter("all");setScreen("graph");}catch(e){setErr("JSON hatası: "+e.message);}};
  const fetchAPI=async(apiBaseOverride,opts={})=>{
    setLoading(true);setErr("");const results=[];
    const hdr={...apiFetchHeaders,...(opts.headers||{})};
    const tf=async(url)=>{try{const r=await fetch(url,{headers:hdr});if(r.ok){const d=await r.json();results.push(...(d.items||[]));}}catch{}};
    const base=(apiBaseOverride??apiUrl).replace(/\/$/,"");
    await Promise.all(["pods","services","configmaps","secrets","persistentvolumeclaims"].map(r=>tf(`${base}/api/v1/${r}`)));
    await Promise.all(["deployments","statefulsets","daemonsets","replicasets"].map(r=>tf(`${base}/apis/apps/v1/${r}`)));
    await tf(`${base}/apis/networking.k8s.io/v1/ingresses`);
    await Promise.all(["jobs","cronjobs"].map(r=>tf(`${base}/apis/batch/v1/${r}`)));
    if(!results.length){
      const corsHint=hdr.Authorization?" Çoğu kümede API sunucusu tarayıcıdan CORS izin vermez; bu durumda kubectl proxy --port=8001 ve API URL http://127.0.0.1:8001 kullanın.":"";
      setErr("Hiç kaynak bulunamadı. Yerelde: kubectl proxy --port=8001. Kümede: …/k8s-api veya token ile doğrudan API (CORS kısıtı mümkün)."+corsHint);
      setLoading(false);
      return;
    }
    try{setGraphData(parseKubectl(JSON.stringify({kind:"List",items:results})));setSelected(null);setNsFilter("all");setScreen("graph");}catch(e){setErr(e.message);}
    setLoading(false);
  };
  const toggleKind=k=>setTypeFilters(prev=>{const s=new Set(prev);s.has(k)?s.delete(k):s.add(k);return s;});

  const btn=(label,action,bg,fg="#fff")=>(
    <button onClick={action} style={{background:bg,border:"none",color:fg,borderRadius:8,padding:"9px 20px",cursor:"pointer",fontWeight:600,fontSize:13}}>{label}</button>
  );
  const ghostBtn=(label,action)=>(
    <button onClick={action} style={{background:"#0F172A",border:"1px solid #1E293B",color:"#94A3B8",borderRadius:8,padding:"9px 18px",cursor:"pointer",fontSize:13}}>{label}</button>
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
          <p style={{fontSize:12,color:"#64748B",margin:"0 0 10px",lineHeight:1.5}}>Tarayıcı güvenliği nedeniyle <b style={{color:"#94A3B8"}}>~/.kube/config</b> otomatik okunmaz. İçeriği yapıştırın veya dosyayı seçin. Token’lı context’ler üstteki listede görünür; doğrudan API çağrısı birçok kümede <b style={{color:"#94A3B8"}}>CORS</b> yüzünden başarısız olur — o zaman <code style={{color:"#E2E8F0",background:"#020817",padding:"2px 6px",borderRadius:4}}>kubectl proxy</code> kullanın.</p>
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
        {/* NS */}
        <div style={{padding:"8px 14px",borderBottom:"1px solid #1E293B"}}>
          <div style={{fontSize:10,color:"#475569",marginBottom:5,textTransform:"uppercase",letterSpacing:1}}>Namespace</div>
          {["all",...namespaces].map(ns=>(
            <div key={ns} onClick={()=>setNsFilter(ns)}
              style={{padding:"4px 8px",borderRadius:6,marginBottom:2,cursor:"pointer",fontSize:12,background:nsFilter===ns?"#1E3A5F":"transparent",color:nsFilter===ns?"#60A5FA":"#94A3B8"}}>
              {ns==="all"?"🌐 Tümü":`📁 ${ns}`}
            </div>
          ))}
        </div>
        {/* Kinds */}
        <div style={{padding:"8px 14px",flex:1,overflowY:"auto"}}>
          <div style={{fontSize:10,color:"#475569",marginBottom:5,textTransform:"uppercase",letterSpacing:1}}>Türler</div>
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
              <span style={{fontSize:10,color:"#64748B"}}>{t}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Canvas */}
      <div style={{flex:1,position:"relative",overflow:"hidden"}}>
        <div style={{position:"absolute",top:12,left:12,zIndex:10,display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
          {ghostBtn("← Menü",()=>{setScreen("home");setSelected(null);})}
          {ghostBtn("📋 Yeni",()=>setScreen("input"))}
          {critCount>0&&<div style={{background:"#7F1D1D",border:"1px solid #EF4444",borderRadius:20,padding:"3px 10px",fontSize:11,color:"#FCA5A5",fontWeight:700}}>🔴 {critCount} kritik hata</div>}
          {warnCount>0&&<div style={{background:"#451A03",border:"1px solid #F59E0B",borderRadius:20,padding:"3px 10px",fontSize:11,color:"#FCD34D",fontWeight:700}}>🟡 {warnCount} uyarı</div>}
          {infoCount>0&&<div style={{background:"#0C1A3A",border:"1px solid #60A5FA",borderRadius:20,padding:"3px 10px",fontSize:11,color:"#93C5FD",fontWeight:700}}>🔵 {infoCount} bilgi</div>}
        </div>
        <svg ref={svgRef} style={{width:"100%",height:"100%",background:"radial-gradient(ellipse at 50% 50%, #0D1B2A 0%, #020817 100%)"}}/>
        <div style={{position:"absolute",bottom:16,left:16,background:"#0F172A99",border:"1px solid #1E293B",borderRadius:8,padding:"5px 12px",fontSize:11,color:"#475569"}}>
          scroll=zoom · drag=pan · click=detay
        </div>
      </div>

      {/* Right panel */}
      <div style={{width:278,background:"#0A1628",borderLeft:"1px solid #1E293B",display:"flex",flexDirection:"column",overflow:"hidden",flexShrink:0}}>

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
          <div style={{flex:1,overflowY:"auto",padding:14}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <span style={{fontWeight:700,fontSize:13}}>Detay</span>
              <button onClick={()=>setSelected(null)} style={{background:"transparent",border:"none",color:"#64748B",cursor:"pointer",fontSize:18,lineHeight:1}}>×</button>
            </div>
            {(()=>{const h=nodeHealthLevel(selected.id,issues);return(
              <div style={{display:"inline-flex",alignItems:"center",gap:6,background:`${HEALTH_COLORS[h]}22`,border:`1px solid ${HEALTH_COLORS[h]}55`,borderRadius:20,padding:"3px 12px",marginBottom:10,fontSize:11,color:HEALTH_COLORS[h],fontWeight:600}}>
                {h==="critical"?"🔴 Kritik":h==="warning"?"🟡 Uyarı":h==="info"?"🔵 Bilgi":"🟢 Sağlıklı"}
              </div>
            );})()} {" "}
            <span style={{background:`${KINDS[selected.kind]?.color}22`,border:`1px solid ${KINDS[selected.kind]?.color}55`,borderRadius:6,padding:"2px 10px",fontSize:11,color:KINDS[selected.kind]?.color,fontFamily:"monospace"}}>
              {KINDS[selected.kind]?.tag} {selected.kind}
            </span>

            <div style={{marginTop:12}}>
              {[["Ad",selected.name,"monospace"],["Namespace",selected.namespace],["Durum",selected.status],
                ...(selected.restarts>0?[["Yeniden Başlama",`${selected.restarts} kez`]]:[]),
                ...(selected.cpuPercent!=null?[["CPU Kullanımı",`%${selected.cpuPercent}`,null,selected.cpuPercent>80?"#EF4444":selected.cpuPercent>60?"#F59E0B":"#22C55E"]]:[]),
                ...(selected.memPercent!=null?[["Memory Kullanımı",`%${selected.memPercent}`,null,selected.memPercent>85?"#EF4444":selected.memPercent>70?"#F59E0B":"#22C55E"]]:[]),
              ].map(([l,v,ff,vc])=>(
                <div key={l} style={{marginBottom:9}}>
                  <div style={{fontSize:10,color:"#475569",textTransform:"uppercase",letterSpacing:1,marginBottom:2}}>{l}</div>
                  <div style={{fontSize:13,wordBreak:"break-all",fontFamily:ff||"inherit",color:vc||"#E2E8F0"}}>{v}</div>
                </div>
              ))}
            </div>

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
                          <div style={{fontSize:11,color:"#E2E8F0",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{other.name}</div>
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
