import { describe, it, expect } from "vitest";
import { enrichGraphData, dependencyImpactForNode, pickInitialNamespace } from "../utils/graph.js";

describe("enrichGraphData", () => {
  it("counts pods per node from hosts edges", () => {
    const graph = {
      nodes: [
        { id: "n1", kind: "Node", name: "worker" },
        { id: "p1", kind: "Pod", name: "app-1" },
        { id: "p2", kind: "Pod", name: "app-2" },
      ],
      edges: [
        { source: "n1", target: "p1", type: "hosts" },
        { source: "n1", target: "p2", type: "hosts" },
      ],
    };
    const enriched = enrichGraphData(graph);
    const node = enriched.nodes.find(n => n.id === "n1");
    expect(node.podCount).toBe(2);
  });
});

describe("dependencyImpactForNode", () => {
  it("finds upstream and downstream", () => {
    const nodes = [
      { id: "s1", kind: "Service" },
      { id: "p1", kind: "Pod" },
      { id: "d1", kind: "Deployment" },
    ];
    const edges = [
      { source: "s1", target: "p1", type: "selects" },
      { source: "d1", target: "p1", type: "owns" },
    ];
    const impact = dependencyImpactForNode("p1", nodes, edges);
    expect(impact.directUpstream.map(n => n.id)).toContain("s1");
    expect(impact.directUpstream.map(n => n.id)).toContain("d1");
    expect(impact.directDownstream).toHaveLength(0);
  });

  it("returns null for no selection", () => {
    expect(dependencyImpactForNode(null, [], [])).toBeNull();
  });
});

describe("pickInitialNamespace", () => {
  it("returns default when present", () => {
    expect(pickInitialNamespace([{ namespace: "default" }, { namespace: "kube-system" }])).toBe("default");
  });

  it("returns all when default is absent", () => {
    expect(pickInitialNamespace([{ namespace: "production" }])).toBe("all");
  });

  it("returns all for empty list", () => {
    expect(pickInitialNamespace([])).toBe("all");
  });
});
