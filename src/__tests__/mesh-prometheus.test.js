import { describe, it, expect } from "vitest";
import { formatShortRps, accumulateIstioRows, accumulateLinkerdRows, accumulateCiliumRows } from "../utils/mesh-prometheus.js";

describe("formatShortRps", () => {
  it("formats zero", () => expect(formatShortRps(0)).toBe("0.00"));
  it("formats small", () => expect(formatShortRps(0.5)).toBe("0.50"));
  it("formats medium", () => expect(formatShortRps(42)).toBe("42.0"));
  it("formats hundreds", () => expect(formatShortRps(150)).toBe("150"));
  it("formats thousands", () => expect(formatShortRps(2500)).toBe("2.5k"));
  it("formats large", () => expect(formatShortRps(15000)).toBe("15k"));
  it("handles null", () => expect(formatShortRps(null)).toBe("0"));
  it("handles NaN", () => expect(formatShortRps(NaN)).toBe("0"));
});

describe("accumulateIstioRows", () => {
  it("accumulates inbound RPS for service", () => {
    const rpsRows = [{
      metric: { source_workload: "frontend", source_workload_namespace: "default", destination_service_name: "api-svc", destination_service_namespace: "default" },
      value: [1234567890, "42.5"],
    }];
    const result = accumulateIstioRows(rpsRows, []);
    expect(result.mesh).toBe("istio");
    expect(result.serviceInbound.get("default/api-svc")).toBeCloseTo(42.5);
    expect(result.workloadOutbound.get("default/frontend")).toBeCloseTo(42.5);
  });

  it("handles empty rows", () => {
    const result = accumulateIstioRows([], []);
    expect(result.serviceInbound.size).toBe(0);
  });
});

describe("accumulateLinkerdRows", () => {
  it("accumulates linkerd metrics", () => {
    const rpsRows = [{
      metric: { deployment: "web", namespace: "prod", dst_service: "api.prod.svc.cluster.local" },
      value: [0, "10"],
    }];
    const result = accumulateLinkerdRows(rpsRows, []);
    expect(result.mesh).toBe("linkerd");
    expect(result.serviceInbound.get("prod/api")).toBe(10);
  });
});

describe("accumulateCiliumRows", () => {
  it("accumulates cilium metrics", () => {
    const rpsRows = [{
      metric: { source_workload: "web", source_namespace: "prod", destination_workload: "api", destination_namespace: "prod" },
      value: [0, "25"],
    }];
    const result = accumulateCiliumRows(rpsRows, []);
    expect(result.mesh).toBe("cilium");
    expect(result.serviceInbound.get("prod/api")).toBe(25);
  });
});
