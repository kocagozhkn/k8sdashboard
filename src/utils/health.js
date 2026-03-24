export function analyzeHealth(nodes, edges) {
  const issues = [];
  for (const n of nodes) {
    const s = (n.status || "").toLowerCase();
    const r = n.restarts || 0;
    const cpu = n.cpuPercent || 0;
    const mem = n.memPercent || 0;

    if (n.kind === "Pod") {
      if (s === "oomkilled")        issues.push({ id: n.id, level: "critical", code: "OOMKilled",      msg: `${n.name} bellek yetersizli\u011finden \u00f6ld\u00fcr\u00fcld\u00fc`,     fix: "Memory limit art\u0131r\u0131n veya memory leak ara\u015ft\u0131r\u0131n" });
      if (s === "crashloopbackoff") issues.push({ id: n.id, level: "critical", code: "CrashLoop",      msg: `${n.name} s\u00fcrekli \u00e7\u00f6k\u00fcyor`,                        fix: "kubectl logs ile uygulama loglar\u0131n\u0131 inceleyin" });
      if (s === "error")            issues.push({ id: n.id, level: "critical", code: "Error",          msg: `${n.name} hata durumunda`,                         fix: "kubectl describe pod ile detay bak\u0131n" });
      if (s === "evicted")          issues.push({ id: n.id, level: "critical", code: "Evicted",        msg: `${n.name} node'dan tahliye edildi`,                fix: "Node kaynaklar\u0131 yetersiz, yeni node ekleyin" });
      if (s === "pending")          issues.push({ id: n.id, level: "warning",  code: "Pending",        msg: `${n.name} schedule edilemiyor`,                    fix: "Node resource, taint veya affinity kurallar\u0131n\u0131 kontrol edin" });
      if (s === "terminating")      issues.push({ id: n.id, level: "warning",  code: "Terminating",    msg: `${n.name} uzun s\u00fcredir sonland\u0131r\u0131l\u0131yor`,           fix: "Finalizer tak\u0131lm\u0131\u015f olabilir, force delete deneyin" });
      if (r >= 10)                  issues.push({ id: n.id, level: "critical", code: "HighRestarts",   msg: `${n.name} ${r} kez yeniden ba\u015flad\u0131`,              fix: "Liveness probe ve uygulama loglar\u0131n\u0131 kontrol edin" });
      else if (r >= 3)             issues.push({ id: n.id, level: "warning",  code: "Restarts",       msg: `${n.name} ${r} kez yeniden ba\u015flad\u0131`,              fix: "Pod loglar\u0131na bak\u0131n" });
      if (cpu > 90)                 issues.push({ id: n.id, level: "critical", code: "HighCPU",        msg: `${n.name} CPU %${cpu} kullan\u0131yor`,                fix: "CPU limit art\u0131r\u0131n veya HPA ile scale edin" });
      else if (cpu > 70)           issues.push({ id: n.id, level: "warning",  code: "ElevatedCPU",    msg: `${n.name} CPU %${cpu} kullan\u0131yor`,                fix: "CPU kullan\u0131m\u0131n\u0131 izlemeye devam edin" });
      if (mem > 90)                 issues.push({ id: n.id, level: "critical", code: "HighMemory",     msg: `${n.name} Memory %${mem} kullan\u0131yor`,             fix: "Memory limit art\u0131r\u0131n veya memory leak ara\u015ft\u0131r\u0131n" });
      else if (mem > 75)           issues.push({ id: n.id, level: "warning",  code: "ElevatedMemory", msg: `${n.name} Memory %${mem} kullan\u0131yor`,             fix: "Bellek t\u00fcketimini izleyin" });
    }

    if (n.kind === "Node") {
      if (n.nodeReady === false) issues.push({ id: n.id, level: "critical", code: "NodeNotReady", msg: `${n.name} haz\u0131r de\u011fil`, fix: "kubectl describe node ile condition ve kubelet durumunu inceleyin" });
      if (n.nodePressure?.some(p => p.status)) issues.push({ id: n.id, level: "warning", code: "NodePressure", msg: `${n.name} kaynak bask\u0131s\u0131 alt\u0131nda (${n.nodePressure.filter(p => p.status).map(p => p.type).join(", ")})`, fix: "CPU, memory ve disk kullan\u0131m\u0131n\u0131 azalt\u0131n veya node kapasitesini art\u0131r\u0131n" });
      if ((n.podCount || 0) >= 40) issues.push({ id: n.id, level: "warning", code: "BusyNode", msg: `${n.name} \u00fczerinde ${n.podCount} pod \u00e7al\u0131\u015f\u0131yor`, fix: "Pod da\u011f\u0131l\u0131m\u0131n\u0131 dengeleyin veya node havuzunu geni\u015fletin" });
    }

    if (["Deployment", "StatefulSet", "DaemonSet"].includes(n.kind)) {
      const p = (n.status || "").split("/");
      if (p.length === 2) {
        const ready = parseInt(p[0]);
        const desired = parseInt(p[1]);
        if (!isNaN(ready) && !isNaN(desired)) {
          if (desired > 0 && ready === 0)  issues.push({ id: n.id, level: "critical", code: "NotReady",    msg: `${n.name}: hi\u00e7 pod haz\u0131r de\u011fil (0/${desired})`,     fix: "kubectl describe deployment ile event'lere bak\u0131n" });
          else if (ready < desired)        issues.push({ id: n.id, level: "warning",  code: "PartialReady", msg: `${n.name}: ${ready}/${desired} pod haz\u0131r`,         fix: "K\u0131smi haz\u0131r \u2014 pod event'lerini kontrol edin" });
        }
      }
    }

    if (n.kind === "PersistentVolumeClaim") {
      if (s === "pending") issues.push({ id: n.id, level: "critical", code: "PVCPending", msg: `${n.name} PVC ba\u011flanmad\u0131`,        fix: "StorageClass ve PV kullan\u0131labilirli\u011fini kontrol edin" });
      if (s === "lost")    issues.push({ id: n.id, level: "critical", code: "PVCLost",    msg: `${n.name} PVC kaybedildi`,        fix: "Alt\u0131ndaki PV silinmi\u015f olabilir" });
    }

    const out = edges.filter(e => e.source === n.id).length;
    if (out >= 8) issues.push({ id: n.id, level: "warning", code: "HighFanOut", msg: `${n.name} \u00e7ok fazla ba\u011flant\u0131 (${out})`, fix: "Bu servis bottleneck olabilir, load balancing stratejisini g\u00f6zden ge\u00e7irin" });

    const linked = edges.some(e => e.source === n.id || e.target === n.id);
    if (!linked && ["Service", "Deployment", "StatefulSet"].includes(n.kind))
      issues.push({ id: n.id, level: "info", code: "Orphan", msg: `${n.name} hi\u00e7bir kaynakla ba\u011fl\u0131 de\u011fil`, fix: "Kullan\u0131lmayan kaynak olabilir, temizlemeyi d\u00fc\u015f\u00fcn\u00fcn" });
  }
  return issues;
}

export function nodeHealthLevel(id, issues) {
  if (issues.some(i => i.id === id && i.level === "critical")) return "critical";
  if (issues.some(i => i.id === id && i.level === "warning"))  return "warning";
  if (issues.some(i => i.id === id && i.level === "info"))     return "info";
  return "ok";
}
