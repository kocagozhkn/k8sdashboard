import { describe, it, expect } from "vitest";
import { makeSnapshot, compareGraphToSnapshot } from "../utils/snapshot.js";

describe("makeSnapshot", () => {
  it("creates snapshot from graph", () => {
    const graph = { nodes: [{ id: "p1", kind: "Pod", namespace: "default", name: "app", status: "Running" }] };
    const snap = makeSnapshot(graph);
    expect(snap.total).toBe(1);
    expect(snap.entries[0].id).toBe("p1");
    expect(snap.id).toMatch(/^snap-/);
    expect(snap.createdAt).toBeTruthy();
  });
});

describe("compareGraphToSnapshot", () => {
  it("detects added and removed nodes", () => {
    const snapshot = { entries: [{ id: "p1", kind: "Pod", namespace: "default", name: "old", status: "Running" }] };
    const graph = { nodes: [{ id: "p2", kind: "Pod", namespace: "default", name: "new", status: "Running" }] };
    const diff = compareGraphToSnapshot(graph, snapshot);
    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(1);
    expect(diff.changed).toHaveLength(0);
  });

  it("detects status changes", () => {
    const snapshot = { entries: [{ id: "p1", kind: "Pod", namespace: "default", name: "app", status: "Running" }] };
    const graph = { nodes: [{ id: "p1", kind: "Pod", namespace: "default", name: "app", status: "CrashLoopBackOff" }] };
    const diff = compareGraphToSnapshot(graph, snapshot);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].before.status).toBe("Running");
    expect(diff.changed[0].after.status).toBe("CrashLoopBackOff");
  });

  it("returns null for missing inputs", () => {
    expect(compareGraphToSnapshot(null, null)).toBeNull();
  });
});
