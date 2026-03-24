const SNAPSHOT_STORAGE_KEY = "k8s-topology-snapshot-history";

export function loadSnapshotHistory() {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(SNAPSHOT_STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function saveSnapshotHistory(history) {
  try {
    localStorage.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(history.slice(0, 12)));
  } catch { /* */ }
}

export function makeSnapshot(graph) {
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

export function compareGraphToSnapshot(graph, snapshot) {
  if (!graph || !snapshot) return null;
  const current = new Map((graph.nodes || []).map(n => [n.id, n]));
  const baseline = new Map((snapshot.entries || []).map(e => [e.id, e]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [id, n] of current) {
    if (!baseline.has(id)) { added.push(n); continue; }
    const prev = baseline.get(id);
    if ((prev.status || "") !== (n.status || "")) changed.push({ before: prev, after: n });
  }
  for (const [id, oldNode] of baseline) {
    if (!current.has(id)) removed.push(oldNode);
  }
  return { added, removed, changed, snapshot };
}
