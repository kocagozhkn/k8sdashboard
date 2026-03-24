import { useEffect } from "react";
import * as d3 from "d3";
import { KINDS, EDGE_COLORS, HEALTH_COLORS, NW, NH } from "../constants/theme.js";
import { nodeHealthLevel } from "../utils/health.js";
import { formatShortRps } from "../utils/mesh-prometheus.js";

export function useGraph(svgRef, nodes, edges, issues, selectedId, onSelect, opts = {}) {
  const { namespaceLanes = false, maskSecrets = false } = opts;
  useEffect(() => {
    if (!svgRef.current || !nodes?.length) return;
    const el = svgRef.current;
    const W = el.clientWidth || 900;
    const H = el.clientHeight || 650;
    const svg = d3.select(el);
    svg.selectAll("*").remove();
    const defs = svg.append("defs");

    Object.entries(EDGE_COLORS).forEach(([t, c]) =>
      defs.append("marker").attr("id", `arr-${t}`).attr("viewBox", "0 -5 10 10").attr("refX", 34).attr("refY", 0)
        .attr("markerWidth", 5).attr("markerHeight", 5).attr("orient", "auto")
        .append("path").attr("d", "M0,-5L10,0L0,5").attr("fill", c).attr("opacity", 0.8)
    );
    const glow = defs.append("filter").attr("id", "glow");
    glow.append("feGaussianBlur").attr("stdDeviation", "5").attr("result", "blur");
    const fm = glow.append("feMerge");
    fm.append("feMergeNode").attr("in", "blur");
    fm.append("feMergeNode").attr("in", "SourceGraphic");

    const g = svg.append("g");
    const zoom = d3.zoom().scaleExtent([0.05, 6]).on("zoom", e => g.attr("transform", e.transform));
    svg.call(zoom);

    const sN = nodes.map(n => ({ ...n }));
    const nMap = new Map(sN.map(n => [n.id, n]));
    const sE = edges.filter(e => nMap.has(e.source) && nMap.has(e.target)).map(e => ({ ...e }));
    const showName = d => (maskSecrets && d.kind === "Secret" ? "••••" : d.name);

    const sim = d3.forceSimulation(sN)
      .force("link", d3.forceLink(sE).id(d => d.id).distance(namespaceLanes ? 200 : 230).strength(0.4))
      .force("charge", d3.forceManyBody().strength(-850))
      .force("collide", d3.forceCollide(105));

    if (namespaceLanes && sN.length) {
      const nss = [...new Set(sN.map(n => n.namespace))].sort();
      const nlen = Math.max(nss.length, 1);
      sim.force("center", d3.forceCenter(W / 2, H / 2).strength(0.02))
        .force("x", d3.forceX(W / 2).strength(0.06))
        .force("y", d3.forceY(d => { const i = Math.max(0, nss.indexOf(d.namespace)); return ((i + 0.5) / nlen) * H; }).strength(0.26));
    } else {
      sim.force("center", d3.forceCenter(W / 2, H / 2))
        .force("x", d3.forceX(W / 2).strength(0.04))
        .force("y", d3.forceY(H / 2).strength(0.04));
    }

    const linkG = g.append("g");
    const link = linkG.selectAll("line").data(sE).join("line")
      .attr("stroke", d => EDGE_COLORS[d.type] || "#555")
      .attr("stroke-width", d => { const sh = nodeHealthLevel(d.source, issues), th = nodeHealthLevel(d.target, issues); return (sh === "critical" || th === "critical") ? 2.5 : 1.5; })
      .attr("stroke-opacity", d => { const sh = nodeHealthLevel(d.source, issues), th = nodeHealthLevel(d.target, issues); return (sh === "critical" || th === "critical") ? 0.75 : 0.35; })
      .attr("stroke-dasharray", d => { const sh = nodeHealthLevel(d.source, issues), th = nodeHealthLevel(d.target, issues); return (sh === "critical" || th === "critical") ? "7,3" : null; })
      .attr("marker-end", d => `url(#arr-${d.type})`);

    const linkLbl = linkG.selectAll("text").data(sE.filter(e => e.label || e.trafficLabel)).join("text")
      .attr("text-anchor", "middle").attr("fill", d => d.trafficLabel && !d.label ? "#22D3EE" : "#A855F7").attr("font-size", "9px").attr("font-family", "monospace")
      .text(d => (d.label && d.trafficLabel) ? `${d.label} · ${d.trafficLabel}` : (d.label || d.trafficLabel || ""));

    const nodeG = g.append("g");
    const node = nodeG.selectAll("g").data(sN).join("g").style("cursor", "pointer")
      .call(d3.drag()
        .on("start", (ev, d) => { if (!ev.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
        .on("drag", (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
        .on("end", (ev, d) => { if (!ev.active) sim.alphaTarget(0); d.fx = null; d.fy = null; })
      )
      .on("click", (ev, d) => { ev.stopPropagation(); onSelect(d.id === selectedId ? null : d); });

    // Glow ring
    node.append("rect")
      .attr("x", -NW / 2 - 6).attr("y", -NH / 2 - 6).attr("width", NW + 12).attr("height", NH + 12).attr("rx", 14)
      .attr("fill", "none")
      .attr("stroke", d => { const h = nodeHealthLevel(d.id, issues); return d.id === selectedId ? (KINDS[d.kind]?.color || "#fff") : h === "ok" ? "transparent" : HEALTH_COLORS[h]; })
      .attr("stroke-width", 2).attr("stroke-opacity", 0.7)
      .attr("filter", d => { const h = nodeHealthLevel(d.id, issues); return (h !== "ok" || d.id === selectedId) ? "url(#glow)" : "none"; });

    // Card
    node.append("rect")
      .attr("x", -NW / 2).attr("y", -NH / 2).attr("width", NW).attr("height", NH).attr("rx", 10)
      .attr("fill", "#0F172A")
      .attr("stroke", d => { const h = nodeHealthLevel(d.id, issues); return h !== "ok" ? HEALTH_COLORS[h] : KINDS[d.kind]?.color || "#334"; })
      .attr("stroke-width", d => { const h = nodeHealthLevel(d.id, issues); return h !== "ok" ? 2 : 1.2; });

    // Header tint
    node.append("rect").attr("x", -NW / 2).attr("y", -NH / 2).attr("width", NW).attr("height", 26).attr("rx", 10)
      .attr("fill", d => { const h = nodeHealthLevel(d.id, issues); return h !== "ok" ? HEALTH_COLORS[h] : KINDS[d.kind]?.color || "#555"; }).attr("opacity", 0.14);
    node.append("rect").attr("x", -NW / 2).attr("y", -NH / 2 + 16).attr("width", NW).attr("height", 10)
      .attr("fill", d => { const h = nodeHealthLevel(d.id, issues); return h !== "ok" ? HEALTH_COLORS[h] : KINDS[d.kind]?.color || "#555"; }).attr("opacity", 0.14);

    // Kind tag
    node.append("text").attr("x", -NW / 2 + 10).attr("y", -NH / 2 + 17)
      .attr("fill", d => KINDS[d.kind]?.color || "#94A3B8").attr("font-size", "10px").attr("font-weight", "bold").attr("font-family", "monospace")
      .text(d => KINDS[d.kind]?.tag || d.kind.slice(0, 3).toUpperCase());

    // Health icon
    node.append("text").attr("x", NW / 2 - 22).attr("y", -NH / 2 + 17).attr("font-size", "12px").attr("text-anchor", "middle")
      .text(d => { const h = nodeHealthLevel(d.id, issues); return h === "critical" ? "🔴" : h === "warning" ? "🟡" : h === "info" ? "🔵" : "🟢"; });

    // Name
    node.append("text").attr("y", 5).attr("text-anchor", "middle")
      .attr("fill", "#E2E8F0").attr("font-size", "12px").attr("font-weight", "600")
      .text(d => { const n = showName(d); return n.length > 21 ? n.slice(0, 20) + "…" : n; });

    // Status + metrics
    node.append("text").attr("y", NH / 2 - 8).attr("text-anchor", "middle")
      .attr("font-size", "10px").attr("font-family", "monospace")
      .attr("fill", d => {
        const s = (d.status || "").toLowerCase();
        if (/run|ready|active|bound/.test(s)) return "#22C55E";
        if (/pend|wait/.test(s)) return "#F59E0B";
        if (/crash|oom|error|evict/.test(s)) return "#EF4444";
        return "#64748B";
      })
      .text(d => {
        const s = d.status || "";
        const sl = s.length > 14 ? s.slice(0, 13) + "…" : s;
        const parts = [sl];
        if (d.cpuPercent != null) parts.push(`CPU:${d.cpuPercent}%`);
        else if (d.metricsCpuMilli != null) parts.push(`CPU:${d.metricsCpuMilli}m`);
        if (d.memPercent != null) parts.push(`MEM:${d.memPercent}%`);
        if (d.trafficInRps != null) parts.push(`↓${formatShortRps(d.trafficInRps)}rps`);
        if (d.trafficOutRps != null) parts.push(`↑${formatShortRps(d.trafficOutRps)}rps`);
        if (d.trafficErrRatio > 0.02) parts.push(`${(d.trafficErrRatio * 100).toFixed(0)}%err`);
        const line = parts.join("  ");
        return line.length > 38 ? line.slice(0, 37) + "…" : line;
      });

    // Restart badge
    node.filter(d => d.restarts >= 3).append("rect")
      .attr("x", NW / 2 - 40).attr("y", -NH / 2 + 22).attr("width", 37).attr("height", 16).attr("rx", 4)
      .attr("fill", d => d.restarts >= 10 ? "#7F1D1D" : "#451A03");
    node.filter(d => d.restarts >= 3).append("text")
      .attr("x", NW / 2 - 21).attr("y", -NH / 2 + 33).attr("text-anchor", "middle")
      .attr("fill", d => d.restarts >= 10 ? "#FCA5A5" : "#FCD34D").attr("font-size", "9px").attr("font-weight", "bold").attr("font-family", "monospace")
      .text(d => `↺${d.restarts}`);

    // Namespace label
    node.append("text").attr("y", NH / 2 + 13).attr("text-anchor", "middle")
      .attr("fill", "#334155").attr("font-size", "9px").text(d => d.namespace);

    svg.on("click", () => onSelect(null));
    sim.on("tick", () => {
      link.attr("x1", d => d.source.x).attr("y1", d => d.source.y).attr("x2", d => d.target.x).attr("y2", d => d.target.y);
      linkLbl.attr("x", d => (d.source.x + d.target.x) / 2).attr("y", d => (d.source.y + d.target.y) / 2 - 5);
      node.attr("transform", d => `translate(${d.x},${d.y})`);
    });
    sim.on("end", () => {
      const b = g.node().getBBox();
      if (!b.width) return;
      const pad = 60;
      const sc = Math.min((W - pad * 2) / b.width, (H - pad * 2) / b.height, 1);
      svg.transition().duration(800).call(zoom.transform,
        d3.zoomIdentity.translate(W / 2 - sc * (b.x + b.width / 2), H / 2 - sc * (b.y + b.height / 2)).scale(sc));
    });
    return () => sim.stop();
  }, [nodes, edges, issues, selectedId, namespaceLanes, maskSecrets]);
}
