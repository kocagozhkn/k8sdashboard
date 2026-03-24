import { describe, it, expect } from "vitest";
import { analyzeHealth, nodeHealthLevel } from "../utils/health.js";

describe("analyzeHealth", () => {
  it("detects OOMKilled pod", () => {
    const nodes = [{ id: "p1", kind: "Pod", name: "test", status: "OOMKilled", restarts: 0 }];
    const issues = analyzeHealth(nodes, []);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("OOMKilled");
    expect(issues[0].level).toBe("critical");
  });

  it("detects CrashLoopBackOff pod", () => {
    const nodes = [{ id: "p1", kind: "Pod", name: "crash", status: "CrashLoopBackOff", restarts: 15 }];
    const issues = analyzeHealth(nodes, []);
    const codes = issues.map(i => i.code);
    expect(codes).toContain("CrashLoop");
    expect(codes).toContain("HighRestarts");
  });

  it("detects high CPU warning and critical", () => {
    const nodes = [
      { id: "p1", kind: "Pod", name: "a", status: "Running", cpuPercent: 75, restarts: 0 },
      { id: "p2", kind: "Pod", name: "b", status: "Running", cpuPercent: 95, restarts: 0 },
    ];
    const issues = analyzeHealth(nodes, []);
    expect(issues.find(i => i.id === "p1").code).toBe("ElevatedCPU");
    expect(issues.find(i => i.id === "p2").code).toBe("HighCPU");
  });

  it("detects Pending PVC", () => {
    const nodes = [{ id: "pvc1", kind: "PersistentVolumeClaim", name: "data", status: "Pending" }];
    const issues = analyzeHealth(nodes, []);
    expect(issues[0].code).toBe("PVCPending");
  });

  it("detects NotReady deployment", () => {
    const nodes = [{ id: "d1", kind: "Deployment", name: "api", status: "0/3" }];
    const issues = analyzeHealth(nodes, []);
    expect(issues[0].code).toBe("NotReady");
    expect(issues[0].level).toBe("critical");
  });

  it("detects partial ready deployment", () => {
    const nodes = [{ id: "d1", kind: "Deployment", name: "api", status: "2/3" }];
    const issues = analyzeHealth(nodes, []);
    expect(issues[0].code).toBe("PartialReady");
    expect(issues[0].level).toBe("warning");
  });

  it("detects orphan service", () => {
    const nodes = [{ id: "s1", kind: "Service", name: "legacy", status: "Active" }];
    const issues = analyzeHealth(nodes, []);
    expect(issues[0].code).toBe("Orphan");
  });

  it("detects high fan-out bottleneck", () => {
    const nodes = [{ id: "s1", kind: "Service", name: "gateway", status: "Active" }];
    const edges = Array.from({ length: 9 }, (_, i) => ({ source: "s1", target: `p${i}` }));
    const issues = analyzeHealth(nodes, edges);
    expect(issues.some(i => i.code === "HighFanOut")).toBe(true);
  });

  it("detects NodeNotReady", () => {
    const nodes = [{ id: "n1", kind: "Node", name: "worker-1", nodeReady: false }];
    const issues = analyzeHealth(nodes, []);
    expect(issues[0].code).toBe("NodeNotReady");
  });

  it("returns no issues for healthy pod", () => {
    const nodes = [{ id: "p1", kind: "Pod", name: "ok", status: "Running", cpuPercent: 20, memPercent: 30, restarts: 0 }];
    const edges = [{ source: "s1", target: "p1" }];
    const issues = analyzeHealth(nodes, edges);
    expect(issues).toHaveLength(0);
  });
});

describe("nodeHealthLevel", () => {
  it("returns critical when critical issues exist", () => {
    const issues = [{ id: "p1", level: "critical", code: "X" }];
    expect(nodeHealthLevel("p1", issues)).toBe("critical");
  });

  it("returns ok when no issues", () => {
    expect(nodeHealthLevel("p1", [])).toBe("ok");
  });

  it("returns warning over info", () => {
    const issues = [
      { id: "p1", level: "info", code: "A" },
      { id: "p1", level: "warning", code: "B" },
    ];
    expect(nodeHealthLevel("p1", issues)).toBe("warning");
  });
});
