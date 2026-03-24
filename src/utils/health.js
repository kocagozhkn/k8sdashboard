export function analyzeHealth(nodes, edges) {
  const issues = [];
  for (const n of nodes) {
    const s = (n.status || "").toLowerCase();
    const r = n.restarts || 0;
    const cpu = n.cpuPercent || 0;
    const mem = n.memPercent || 0;

    if (n.kind === "Pod") {
      if (s === "oomkilled")        issues.push({ id: n.id, level: "critical", code: "OOMKilled",      msg: `${n.name} bellek yetersizliğinden öldürüldü`,     fix: "Memory limit artırın veya memory leak araştırın" });
      if (s === "crashloopbackoff") issues.push({ id: n.id, level: "critical", code: "CrashLoop",      msg: `${n.name} sürekli çöküyor`,                        fix: "kubectl logs ile uygulama loglarını inceleyin" });
      if (s === "error")            issues.push({ id: n.id, level: "critical", code: "Error",          msg: `${n.name} hata durumunda`,                         fix: "kubectl describe pod ile detay bakın" });
      if (s === "evicted")          issues.push({ id: n.id, level: "critical", code: "Evicted",        msg: `${n.name} node'dan tahliye edildi`,                fix: "Node kaynakları yetersiz, yeni node ekleyin" });
      if (s === "pending")          issues.push({ id: n.id, level: "warning",  code: "Pending",        msg: `${n.name} schedule edilemiyor`,                    fix: "Node resource, taint veya affinity kurallarını kontrol edin" });
      if (s === "terminating")      issues.push({ id: n.id, level: "warning",  code: "Terminating",    msg: `${n.name} uzun süredir sonlandırılıyor`,           fix: "Finalizer takılmış olabilir, force delete deneyin" });
      if (r >= 10)                  issues.push({ id: n.id, level: "critical", code: "HighRestarts",   msg: `${n.name} ${r} kez yeniden başladı`,              fix: "Liveness probe ve uygulama loglarını kontrol edin" });
      else if (r >= 3)             issues.push({ id: n.id, level: "warning",  code: "Restarts",       msg: `${n.name} ${r} kez yeniden başladı`,              fix: "Pod loglarına bakın" });
      if (cpu > 90)                 issues.push({ id: n.id, level: "critical", code: "HighCPU",        msg: `${n.name} CPU %${cpu} kullanıyor`,                fix: "CPU limit artırın veya HPA ile scale edin" });
      else if (cpu > 70)           issues.push({ id: n.id, level: "warning",  code: "ElevatedCPU",    msg: `${n.name} CPU %${cpu} kullanıyor`,                fix: "CPU kullanımını izlemeye devam edin" });
      if (mem > 90)                 issues.push({ id: n.id, level: "critical", code: "HighMemory",     msg: `${n.name} Memory %${mem} kullanıyor`,             fix: "Memory limit artırın veya memory leak araştırın" });
      else if (mem > 75)           issues.push({ id: n.id, level: "warning",  code: "ElevatedMemory", msg: `${n.name} Memory %${mem} kullanıyor`,             fix: "Bellek tüketimini izleyin" });
    }

    if (n.kind === "Node") {
      if (n.nodeReady === false) issues.push({ id: n.id, level: "critical", code: "NodeNotReady", msg: `${n.name} hazır değil`, fix: "kubectl describe node ile condition ve kubelet durumunu inceleyin" });
      if (n.nodePressure?.some(p => p.status)) issues.push({ id: n.id, level: "warning", code: "NodePressure", msg: `${n.name} kaynak baskısı altında (${n.nodePressure.filter(p => p.status).map(p => p.type).join(", ")})`, fix: "CPU, memory ve disk kullanımını azaltın veya node kapasitesini artırın" });
      if ((n.podCount || 0) >= 40) issues.push({ id: n.id, level: "warning", code: "BusyNode", msg: `${n.name} üzerinde ${n.podCount} pod çalışıyor`, fix: "Pod dağılımını dengeleyin veya node havuzunu genişletin" });
    }

    if (["Deployment", "StatefulSet", "DaemonSet"].includes(n.kind)) {
      const p = (n.status || "").split("/");
      if (p.length === 2) {
        const ready = parseInt(p[0]);
        const desired = parseInt(p[1]);
        if (!isNaN(ready) && !isNaN(desired)) {
          if (desired > 0 && ready === 0)  issues.push({ id: n.id, level: "critical", code: "NotReady",    msg: `${n.name}: hiç pod hazır değil (0/${desired})`,     fix: "kubectl describe deployment ile event'lere bakın" });
          else if (ready < desired)        issues.push({ id: n.id, level: "warning",  code: "PartialReady", msg: `${n.name}: ${ready}/${desired} pod hazır`,         fix: "Kısmi hazır — pod event'lerini kontrol edin" });
        }
      }
    }

    if (n.kind === "PersistentVolumeClaim") {
      if (s === "pending") issues.push({ id: n.id, level: "critical", code: "PVCPending", msg: `${n.name} PVC bağlanmadı`,        fix: "StorageClass ve PV kullanılabilirliğini kontrol edin" });
      if (s === "lost")    issues.push({ id: n.id, level: "critical", code: "PVCLost",    msg: `${n.name} PVC kaybedildi`,        fix: "Altındaki PV silinmiş olabilir" });
    }

    const out = edges.filter(e => e.source === n.id).length;
    if (out >= 8) issues.push({ id: n.id, level: "warning", code: "HighFanOut", msg: `${n.name} çok fazla bağlantı (${out})`, fix: "Bu servis bottleneck olabilir, load balancing stratejisini gözden geçirin" });

    const linked = edges.some(e => e.source === n.id || e.target === n.id);
    if (!linked && ["Service", "Deployment", "StatefulSet"].includes(n.kind))
      issues.push({ id: n.id, level: "info", code: "Orphan", msg: `${n.name} hiçbir kaynakla bağlı değil`, fix: "Kullanılmayan kaynak olabilir, temizlemeyi düşünün" });
  }
  return issues;
}

export function nodeHealthLevel(id, issues) {
  if (issues.some(i => i.id === id && i.level === "critical")) return "critical";
  if (issues.some(i => i.id === id && i.level === "warning"))  return "warning";
  if (issues.some(i => i.id === id && i.level === "info"))     return "info";
  return "ok";
}
