import yaml from "js-yaml";

const LS_KEY = "k8s-topology-kubeconfig";

export function loadKubeconfigFromStorage() {
  try {
    return localStorage.getItem(LS_KEY) || "";
  } catch {
    return "";
  }
}

export function saveKubeconfigToStorage(text) {
  try {
    localStorage.setItem(LS_KEY, text);
  } catch {
    /* private mode */
  }
}

export function clearKubeconfigStorage() {
  try {
    localStorage.removeItem(LS_KEY);
  } catch {
    /* */
  }
}

export function parseKubeconfigYaml(text) {
  const t = (text || "").trim();
  if (!t) throw new Error("kubeconfig boş");
  const doc = yaml.load(t);
  if (!doc || typeof doc !== "object") throw new Error("Geçersiz YAML");
  if (doc.kind !== "Config" && doc.apiVersion !== "v1" && !doc.contexts && !doc.clusters) {
    /* bazı dosyalar kind olmadan da olabilir */
    if (!doc.contexts && !doc.clusters) throw new Error("Kubernetes kubeconfig gibi görünmüyor (contexts/clusters yok)");
  }
  return doc;
}

export function listKubeconfigContexts(doc) {
  const clusters = new Map((doc.clusters || []).map((c) => [c.name, c.cluster]));
  const users = new Map((doc.users || []).map((u) => [u.name, u.user]));
  return (doc.contexts || []).map((ctx) => {
    const c = ctx.context || {};
    const cluster = clusters.get(c.cluster);
    const user = users.get(c.user) || {};
    return {
      name: ctx.name,
      clusterName: c.cluster,
      userName: c.user,
      server: (cluster?.server || "").replace(/\/$/, ""),
      hasToken: Boolean(user.token),
      hasExec: Boolean(user.exec),
      hasClientCert: Boolean(user["client-certificate-data"] && user["client-key-data"]),
    };
  });
}

export function resolveKubeconfigContext(doc, contextName) {
  const ctx = (doc.contexts || []).find((c) => c.name === contextName);
  if (!ctx?.context) return null;
  const cn = ctx.context.cluster;
  const un = ctx.context.user;
  const cluster = (doc.clusters || []).find((c) => c.name === cn)?.cluster;
  const user = (doc.users || []).find((u) => u.name === un)?.user;
  if (!cluster?.server) return null;
  return {
    server: String(cluster.server).replace(/\/$/, ""),
    token: user?.token ? String(user.token) : "",
    exec: user?.exec || null,
    clientCertificateData: user?.["client-certificate-data"] || "",
    clientKeyData: user?.["client-key-data"] || "",
  };
}
