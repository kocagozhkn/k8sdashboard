export function analyzeHealth(nodes, edges) {
  const issues = [];
  for (const n of nodes) {
    const s = (n.status || "").toLowerCase();
    const r = n.restarts || 0;
    const cpu = n.cpuPercent || 0;
    const mem = n.memPercent || 0;
    const res = n.resources;
    const usedCpuMilli = n.metricsCpuMilli;
    const pol = n.policy;

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

      if (res) {
        if (res.reqCpuMilli == null || res.reqMemMi == null) {
          issues.push({ id: n.id, level: "warning", code: "MissingRequests", msg: `${n.name} resource request tanımsız`, fix: "CPU/Memory requests ekleyin (scheduler stabilitesi için)" });
        }
        if (res.limCpuMilli == null || res.limMemMi == null) {
          issues.push({ id: n.id, level: "info", code: "MissingLimits", msg: `${n.name} resource limit tanımsız`, fix: "CPU/Memory limits ekleyin (noisy neighbor riskini azaltır)" });
        }
        if (usedCpuMilli != null && res.reqCpuMilli != null && res.reqCpuMilli >= 200) {
          const pct = Math.round((usedCpuMilli / Math.max(1, res.reqCpuMilli)) * 100);
          if (pct <= 20) issues.push({ id: n.id, level: "info", code: "OverProvisionCPU", msg: `${n.name} CPU request'ine göre düşük kullanım (~%${pct})`, fix: "Requests düşürüp cluster verimliliğini artırın" });
        }
      }

      if (pol) {
        if (pol.anyPrivileged) issues.push({ id: n.id, level: "critical", code: "Privileged", msg: `${n.name} privileged container içeriyor`, fix: "privileged=false kullanın; capability/minimal izin modeline geçin" });
        if (pol.anyAllowPrivEsc) issues.push({ id: n.id, level: "warning", code: "PrivEsc", msg: `${n.name} allowPrivilegeEscalation=true`, fix: "allowPrivilegeEscalation=false önerilir" });
        if (pol.anyHostPath) issues.push({ id: n.id, level: "warning", code: "HostPath", msg: `${n.name} hostPath volume kullanıyor`, fix: "Mümkünse PVC/ConfigMap/Secret kullanın" });
        if (pol.hostNetwork || pol.hostPID || pol.hostIPC) issues.push({ id: n.id, level: "warning", code: "HostNS", msg: `${n.name} host namespace kullanıyor`, fix: "hostNetwork/hostPID/hostIPC kapatın" });
        if (pol.anyRunAsRoot) issues.push({ id: n.id, level: "info", code: "RunAsRoot", msg: `${n.name} root olarak çalışabilir`, fix: "runAsNonRoot: true ve non-root user kullanın" });
        if (pol.anyReadOnlyFsFalse) issues.push({ id: n.id, level: "info", code: "WritableFS", msg: `${n.name} readOnlyRootFilesystem=false`, fix: "readOnlyRootFilesystem=true önerilir" });
        if (pol.missingProbes) issues.push({ id: n.id, level: "info", code: "MissingProbes", msg: `${n.name} probe tanımsız`, fix: "readiness/liveness (ve gerekirse startup) probe ekleyin" });
      }
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
      if (res) {
        if (res.reqCpuMilli == null || res.reqMemMi == null) {
          issues.push({ id: n.id, level: "warning", code: "MissingRequests", msg: `${n.name} request tanımsız`, fix: "Template container requests ekleyin" });
        }
        if (res.limCpuMilli == null || res.limMemMi == null) {
          issues.push({ id: n.id, level: "info", code: "MissingLimits", msg: `${n.name} limit tanımsız`, fix: "Template container limits ekleyin" });
        }
      }

      if (pol) {
        if (pol.anyPrivileged) issues.push({ id: n.id, level: "critical", code: "Privileged", msg: `${n.name} template privileged container içeriyor`, fix: "privileged=false kullanın" });
        if (pol.anyAllowPrivEsc) issues.push({ id: n.id, level: "warning", code: "PrivEsc", msg: `${n.name} template allowPrivilegeEscalation=true`, fix: "allowPrivilegeEscalation=false önerilir" });
        if (pol.anyHostPath) issues.push({ id: n.id, level: "warning", code: "HostPath", msg: `${n.name} template hostPath volume kullanıyor`, fix: "PVC/ConfigMap/Secret tercih edin" });
        if (pol.hostNetwork || pol.hostPID || pol.hostIPC) issues.push({ id: n.id, level: "warning", code: "HostNS", msg: `${n.name} template host namespace kullanıyor`, fix: "hostNetwork/hostPID/hostIPC kapatın" });
        if (pol.anyRunAsRoot) issues.push({ id: n.id, level: "info", code: "RunAsRoot", msg: `${n.name} template root çalışabilir`, fix: "runAsNonRoot: true kullanın" });
        if (pol.anyReadOnlyFsFalse) issues.push({ id: n.id, level: "info", code: "WritableFS", msg: `${n.name} template readOnlyRootFilesystem=false`, fix: "readOnlyRootFilesystem=true önerilir" });
        if (pol.missingProbes) issues.push({ id: n.id, level: "info", code: "MissingProbes", msg: `${n.name} template probe tanımsız`, fix: "readiness/liveness (ve gerekirse startup) ekleyin" });
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
