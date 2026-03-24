export function enrichGraphData(graph) {
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

export function dependencyImpactForNode(selectedId, nodes, edges) {
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
  const directUpstream = (incoming.get(selectedId) || []).map(e => nodeMap.get(e.source)).filter(Boolean);
  const directDownstream = (outgoing.get(selectedId) || []).map(e => nodeMap.get(e.target)).filter(Boolean);
  const upstreamClosure = walk(selectedId, "in");
  const downstreamClosure = walk(selectedId, "out");
  return {
    directUpstream, directDownstream, upstreamClosure, downstreamClosure,
    impactedWorkloads: downstreamClosure.filter(n => ["Pod", "Deployment", "StatefulSet", "DaemonSet", "Service"].includes(n.kind)),
  };
}

export function eventsForSelectedNode(selected, clusterEvents) {
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

export function rolloutRelatedNodes(selected, nodes) {
  if (!selected || !["Deployment", "ReplicaSet"].includes(selected.kind)) return [];
  if (selected.kind === "Deployment") {
    return nodes.filter(n => n.kind === "ReplicaSet" && n.namespace === selected.namespace && n.rollout?.owners?.includes(`Deployment/${selected.name}`));
  }
  return nodes.filter(n => n.kind === "Pod" && n.namespace === selected.namespace && n.labels?.["pod-template-hash"] && selected.labels?.["pod-template-hash"] && n.labels["pod-template-hash"] === selected.labels["pod-template-hash"]);
}

export function pickInitialNamespace(nodes) {
  if (!nodes?.length) return "all";
  return nodes.some(n => n.namespace === "default") ? "default" : "all";
}
