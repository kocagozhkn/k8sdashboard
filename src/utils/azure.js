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

export function envNameSuggestsAzure(name) {
  const n = String(name || "").toLowerCase();
  if (!n) return false;
  if (n.includes("azure")) return true;
  if (n.includes("servicebus") || n.includes("service_bus")) return true;
  if (n.includes("eventhub") || n.includes("event_hub")) return true;
  if (n.includes("keyvault") || n.includes("key_vault")) return true;
  if (n.includes("cosmos")) return true;
  if (n.includes("blob") || (n.includes("storage") && (n.includes("account") || n.includes("conn")))) return true;
  if (n.includes("redis") && n.includes("azure")) return true;
  return false;
}

function refNameSuggestsAzure(refName) {
  return /azure|cosmos|servicebus|eventhub|keyvault|storage|blob|connection|appsettings|key-vault|eh-|sb-|credential|identity|external-secret|csi/i.test(String(refName || ""));
}

export function azureDepsFromEnvFromList(envFromList = []) {
  const deps = [];
  for (const block of envFromList || []) {
    const sn = block.secretRef?.name;
    if (sn && refNameSuggestsAzure(sn)) {
      pushAzureDep(deps, { serviceType: "Azure (Secret bundle)", name: sn, confidence: "inferred", evidence: "envFrom.secretRef" });
    }
    const cm = block.configMapRef?.name;
    if (cm && refNameSuggestsAzure(cm)) {
      pushAzureDep(deps, { serviceType: "Azure (ConfigMap bundle)", name: cm, confidence: "inferred", evidence: "envFrom.configMapRef" });
    }
  }
  return deps;
}

export function azureDepsFromEnv(envList = []) {
  const deps = [];
  for (const env of envList) {
    const key = String(env?.name || "");
    const value = String(env?.value || "");
    const hay = `${key} ${value}`.toLowerCase();
    const vs = env.valueFrom?.secretKeyRef;
    const vc = env.valueFrom?.configMapKeyRef;
    if (vs && (envNameSuggestsAzure(key) || refNameSuggestsAzure(vs.name))) {
      pushAzureDep(deps, { serviceType: "Azure (Secret)", name: vs.key ? `${vs.name}/${vs.key}` : vs.name, confidence: "inferred", evidence: `secretKeyRef:${key || vs.key || "?"}` });
    }
    if (vc && (envNameSuggestsAzure(key) || refNameSuggestsAzure(vc.name))) {
      pushAzureDep(deps, { serviceType: "Azure (ConfigMap)", name: vc.key ? `${vc.name}/${vc.key}` : vc.name, confidence: "inferred", evidence: `configMapKeyRef:${key || vc.key || "?"}` });
    }
    if (!hay.trim()) continue;
    if (hay.includes("vault.azure.net") || hay.includes("keyvault")) pushAzureDep(deps, { serviceType: "Key Vault", name: value.match(/[a-z0-9-]+\.vault\.azure\.net/i)?.[0] || key, confidence: value.includes("vault.azure.net") ? "confirmed" : "inferred", evidence: `env:${key}` });
    if (hay.includes("servicebus.windows.net")) pushAzureDep(deps, { serviceType: "Service Bus", name: value.match(/[a-z0-9-]+\.servicebus\.windows\.net/i)?.[0] || key, confidence: "confirmed", evidence: `env:${key}` });
    if (hay.includes("eventhub") || hay.includes("servicebus.windows.net")) pushAzureDep(deps, { serviceType: "Event Hubs", name: value.match(/[a-z0-9-]+\.servicebus\.windows\.net/i)?.[0] || key, confidence: hay.includes("eventhub") ? "inferred" : "confirmed", evidence: `env:${key}` });
    if (hay.includes("documents.azure.com") || hay.includes("cosmos")) pushAzureDep(deps, { serviceType: "Cosmos DB", name: value.match(/[a-z0-9-]+\.documents\.azure\.com/i)?.[0] || key, confidence: value.includes("documents.azure.com") ? "confirmed" : "inferred", evidence: `env:${key}` });
    if (hay.includes("database.windows.net")) pushAzureDep(deps, { serviceType: "Azure SQL", name: value.match(/[a-z0-9-]+\.database\.windows\.net/i)?.[0] || key, confidence: "confirmed", evidence: `env:${key}` });
    if (hay.includes("blob.core.windows.net") || hay.includes("queue.core.windows.net") || hay.includes("table.core.windows.net") || hay.includes("dfs.core.windows.net")) pushAzureDep(deps, { serviceType: "Storage Account", name: value.match(/[a-z0-9-]+\.(blob|queue|table|dfs)\.core\.windows\.net/i)?.[0] || key, confidence: "confirmed", evidence: `env:${key}` });
    if (hay.includes("redis.cache.windows.net")) pushAzureDep(deps, { serviceType: "Azure Cache for Redis", name: value.match(/[a-z0-9-]+\.redis\.cache\.windows\.net/i)?.[0] || key, confidence: "confirmed", evidence: `env:${key}` });
  }
  return deps;
}

export function azureDepsFromPodSpec(deps, podSpec) {
  if (!podSpec) return;
  for (const c of [...(podSpec.containers || []), ...(podSpec.initContainers || [])]) {
    deps.push(...azureDepsFromEnvFromList(c.envFrom || []));
    deps.push(...azureDepsFromEnv(c.env || []));
  }
  for (const v of podSpec.volumes || []) {
    if (v.csi?.driver?.includes("secrets-store") && (v.csi?.volumeAttributes?.secretProviderClass || "").toLowerCase().includes("azure")) {
      pushAzureDep(deps, { serviceType: "Key Vault", name: v.csi.volumeAttributes.secretProviderClass, confidence: "confirmed", evidence: "csi:secretProviderClass" });
    }
  }
}

export function azureDepsFromItem(item) {
  const deps = [];
  const ann = item.metadata?.annotations || {};
  const labels = item.metadata?.labels || {};
  const kind = item.kind;

  if (kind === "Pod") azureDepsFromPodSpec(deps, item.spec);
  if (["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job"].includes(kind)) azureDepsFromPodSpec(deps, item.spec?.template?.spec);
  if (kind === "CronJob") azureDepsFromPodSpec(deps, item.spec?.jobTemplate?.spec?.template?.spec);

  const tplMeta = ["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job"].includes(kind) ? item.spec?.template?.metadata : null;
  const cjTplMeta = kind === "CronJob" ? item.spec?.jobTemplate?.spec?.template?.metadata : null;
  const wlLabels = { ...labels, ...(tplMeta?.labels || {}), ...(cjTplMeta?.labels || {}) };
  const wlAnn = { ...ann, ...(tplMeta?.annotations || {}), ...(cjTplMeta?.annotations || {}) };

  if (wlLabels["azure.workload.identity/use"] === "true" || wlAnn["azure.workload.identity/client-id"] || wlLabels["aadpodidbinding"]) {
    pushAzureDep(deps, {
      serviceType: "Managed Identity",
      name: wlAnn["azure.workload.identity/client-id"] || wlLabels["aadpodidbinding"] || "workload-identity",
      confidence: "confirmed",
      evidence: wlAnn["azure.workload.identity/client-id"] ? "annotation:azure.workload.identity/client-id" : "label:aadpodidbinding",
    });
  }

  if (kind === "PersistentVolumeClaim") {
    const sc = item.spec?.storageClassName || "";
    if (/azurefile/i.test(sc)) pushAzureDep(deps, { serviceType: "Azure Files", name: sc, confidence: "confirmed", evidence: "storageClassName" });
    if (/managed-csi|disk|azuredisk/i.test(sc)) pushAzureDep(deps, { serviceType: "Azure Disk", name: sc, confidence: "confirmed", evidence: "storageClassName" });
  }

  if (kind === "Service") {
    if (Object.keys(ann).some(k => k.includes("azure-load-balancer"))) {
      pushAzureDep(deps, { serviceType: "Azure Load Balancer", name: item.metadata?.name || "load-balancer", confidence: "confirmed", evidence: "service annotations" });
    }
  }

  if (kind === "Ingress") {
    if (Object.keys(ann).some(k => /appgw|application-gateway/i.test(k))) {
      pushAzureDep(deps, { serviceType: "Application Gateway", name: item.metadata?.name || "application-gateway", confidence: "confirmed", evidence: "ingress annotations" });
    }
  }

  const dedup = new Map();
  for (const dep of deps) {
    const key = `${dep.serviceType}|${dep.name}`;
    if (!dedup.has(key)) dedup.set(key, dep);
  }
  return [...dedup.values()];
}

export function buildAzureDependencyGraph(rawItems) {
  const azureNodes = [];
  const azureEdges = [];
  const seenNodes = new Set();
  let eid = 0;
  for (const item of rawItems) {
    const deps = azureDepsFromItem(item);
    for (const dep of deps) {
      const azureId = `azureservice-azure-${dep.serviceType.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${dep.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
      if (!seenNodes.has(azureId)) {
        seenNodes.add(azureId);
        azureNodes.push({
          id: azureId, kind: "AzureService", name: dep.serviceType, namespace: "azure",
          azureRawName: dep.name,
          status: dep.confidence === "confirmed" ? "Confirmed" : "Inferred",
          azureServiceType: dep.serviceType, azureConfidence: dep.confidence, azureEvidence: dep.evidence,
        });
      }
      azureEdges.push({ id: `azure-e${eid++}`, source: item._id, target: azureId, type: "azure" });
    }
  }
  return { nodes: azureNodes, edges: azureEdges };
}

export function augmentAzureEdgesToPods(rawItems, edges) {
  const mkRef = (kind, ns, name) => `${kind}|${ns || "default"}|${name}`;
  const byKey = new Map();
  for (const it of rawItems) {
    const k = it.kind;
    const ns = it.metadata?.namespace || "default";
    const nm = it.metadata?.name;
    if (k && nm) byKey.set(mkRef(k, ns, nm), it);
  }
  function ownerChainItems(startItem) {
    const out = [];
    let cur = startItem;
    const seen = new Set();
    while (cur && cur._id && !seen.has(cur._id)) {
      seen.add(cur._id);
      out.push(cur);
      const refs = cur.metadata?.ownerReferences || [];
      if (!refs.length) break;
      const o = refs[0];
      const ns = cur.metadata?.namespace || "default";
      cur = byKey.get(mkRef(o.kind, ns, o.name)) || null;
    }
    return out;
  }

  const azureEdges = edges.filter(e => e.type === "azure");
  if (!azureEdges.length) return edges;

  const seenPair = new Set(edges.map(e => `${e.source}|${e.target}|${e.type}`));
  const extra = [];
  let seq = 0;
  for (const pod of rawItems) {
    if (pod.kind !== "Pod") continue;
    const chainIds = new Set(ownerChainItems(pod).map(c => c._id));
    for (const ae of azureEdges) {
      if (ae.source === pod._id) continue;
      if (!chainIds.has(ae.source)) continue;
      const key = `${pod._id}|${ae.target}|azure`;
      if (seenPair.has(key)) continue;
      seenPair.add(key);
      extra.push({ id: `azure-pod-${seq++}`, source: pod._id, target: ae.target, type: "azure" });
    }
  }
  return extra.length ? [...edges, ...extra] : edges;
}
