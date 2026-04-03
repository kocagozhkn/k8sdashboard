import { useEffect } from "react";
import * as d3 from "d3";
import { KINDS, EDGE_COLORS, HEALTH_COLORS } from "../constants/theme.js";
import { KIND_ICON, faceColor, shadeHex } from "../constants/icons.js";
import { nodeHealthLevel } from "../utils/health.js";
import { formatShortRps } from "../utils/mesh-prometheus.js";

/* Architectural tiers — top-to-bottom flow */
const KIND_TIER = {
  AzureService: 0,
  Ingress: 1,
  Service: 2,
  Deployment: 3, StatefulSet: 3, DaemonSet: 3, CronJob: 3, Job: 3,
  ReplicaSet: 4,
  Pod: 5,
  HorizontalPodAutoscaler: 3,
  PodDisruptionBudget: 3,
  NetworkPolicy: 2,
  ConfigMap: 6, Secret: 6, PersistentVolumeClaim: 6,
  Node: 7,
};
const TIER_COUNT = 8;

/* Default fallback icon (small box) */
const fallbackIcon = KIND_ICON.Pod;

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

    Object.entries(EDGE_COLORS).forEach(([t, c]) => {
      const refX = t === "azure" ? 10 : 24;
      defs.append("marker").attr("id", `arr-${t}`).attr("viewBox", "0 -5 10 10").attr("refX", refX).attr("refY", 0)
        .attr("markerWidth", 5).attr("markerHeight", 5).attr("orient", "auto")
        .append("path").attr("d", "M0,-5L10,0L0,5").attr("fill", c).attr("opacity", 0.8);
    });
    const glow = defs.append("filter").attr("id", "glow");
    glow.append("feGaussianBlur").attr("stdDeviation", "5").attr("result", "blur");
    const fm = glow.append("feMerge");
    fm.append("feMergeNode").attr("in", "blur");
    fm.append("feMergeNode").attr("in", "SourceGraphic");

    // Drop shadow for icons
    const shadow = defs.append("filter").attr("id", "iconShadow").attr("x", "-30%").attr("y", "-30%").attr("width", "160%").attr("height", "160%");
    shadow.append("feDropShadow").attr("dx", 2).attr("dy", 4).attr("stdDeviation", 3).attr("flood-color", "rgba(0,0,0,0.4)");

    const g = svg.append("g");
    const zoom = d3.zoom().scaleExtent([0.05, 6]).on("zoom", e => g.attr("transform", e.transform));
    svg.call(zoom);

    const sN = nodes.map(n => ({ ...n }));
    const nMap = new Map(sN.map(n => [n.id, n]));
    const sE = edges.filter(e => nMap.has(e.source) && nMap.has(e.target)).map(e => ({ ...e }));
    const showName = d => (maskSecrets && d.kind === "Secret" ? "••••" : d.name);

    const azureEdges = sE.filter(e => e.type === "azure");
    const nonAzureEdges = sE.filter(e => e.type !== "azure");
    const azureIds = new Set(sN.filter(n => n.kind === "AzureService").map(n => n.id));
    const azureList = sN.filter(n => azureIds.has(n.id));
    const AZURE_COL_X = 92;
    const MAIN_SHIFT_X = azureList.length > 0 ? 130 : 0;

    const tierPad = 64;
    const usableH = Math.max(H, TIER_COUNT * 96);
    const tierY = tier => tierPad + ((tier + 0.5) / TIER_COUNT) * (usableH - tierPad * 2);

    const nss = [...new Set(sN.map(n => n.namespace))].sort();
    const nNs = Math.max(nss.length, 1);
    const laneY = ns => {
      const i = Math.max(0, nss.indexOf(ns));
      return tierPad + ((i + 0.5) / nNs) * (H - tierPad * 2);
    };

    const tierBuckets = {};
    sN.forEach(n => {
      if (azureIds.has(n.id)) return;
      const t = KIND_TIER[n.kind] ?? 5;
      (tierBuckets[t] = tierBuckets[t] || []).push(n);
    });

    for (const [tier, bucket] of Object.entries(tierBuckets)) {
      const t = Number(tier);
      const ncol = Math.max(bucket.length, 1);
      const availW = W - MAIN_SHIFT_X - 80;
      const spacing = Math.min(210, Math.max(88, availW / ncol));
      const startX = MAIN_SHIFT_X + (W - MAIN_SHIFT_X) / 2 - ((ncol - 1) * spacing) / 2;
      bucket.forEach((n, i) => {
        n.x = startX + i * spacing;
        n.y = namespaceLanes ? laneY(n.namespace) : tierY(t);
      });
    }

    const rowsAz = Math.max(azureList.length, 1);
    const slotAz = Math.min(88, Math.max(56, (H - tierPad * 2) / Math.min(rowsAz, 14)));
    azureList.forEach((n, i) => {
      n.x = AZURE_COL_X;
      n.y = tierPad + (i + 0.5) * slotAz;
    });

    const linkDistance = e => {
      if (e.type === "azure") return Math.min(260, 140 + W * 0.12);
      if (e.type === "hosts") return 95;
      if (e.type === "selects" || e.type === "owns") return 105;
      if (e.type === "routes") return 115;
      return 128;
    };

    const chargeStr = -(280 + Math.min(sN.length * 12, 2600));

    const sim = d3.forceSimulation(sN)
      .velocityDecay(0.38)
      .alphaDecay(0.028)
      .force("link", d3.forceLink(sE).id(d => d.id).distance(linkDistance).strength(0.2))
      .force("charge", d3.forceManyBody().strength(chargeStr))
      .force("collide", d3.forceCollide(78));

    if (namespaceLanes) {
      sim
        .force("y", d3.forceY(d => laneY(d.namespace)).strength(0.48))
        .force("x", d3.forceX(d => (azureIds.has(d.id) ? AZURE_COL_X + 40 : MAIN_SHIFT_X + (W - MAIN_SHIFT_X) / 2)).strength(d => (azureIds.has(d.id) ? 0.32 : 0.07)));
    } else {
      sim
        .force("y", d3.forceY(d => (azureIds.has(d.id) ? d.y : tierY(KIND_TIER[d.kind] ?? 5))).strength(d => (azureIds.has(d.id) ? 0.25 : 0.68)))
        .force("x", d3.forceX(d => (azureIds.has(d.id) ? AZURE_COL_X : d.x)).strength(d => (azureIds.has(d.id) ? 0.42 : 0.11)));
    }

    // ── Links ──
    const linkG = g.append("g");
    const link = linkG.selectAll("line").data(nonAzureEdges).join("line")
      .attr("stroke", d => EDGE_COLORS[d.type] || "#555")
      .attr("stroke-width", d => { const sh = nodeHealthLevel(d.source, issues), th = nodeHealthLevel(d.target, issues); return (sh === "critical" || th === "critical") ? 2.5 : 1.5; })
      .attr("stroke-opacity", d => { const sh = nodeHealthLevel(d.source, issues), th = nodeHealthLevel(d.target, issues); return (sh === "critical" || th === "critical") ? 0.75 : 0.35; })
      .attr("stroke-dasharray", d => { const sh = nodeHealthLevel(d.source, issues), th = nodeHealthLevel(d.target, issues); return (sh === "critical" || th === "critical") ? "7,3" : null; })
      .attr("marker-end", d => `url(#arr-${d.type})`);

    const azureLinkG = g.append("g");
    const azureLink = azureLinkG.selectAll("path").data(azureEdges).join("path")
      .attr("fill", "none")
      .attr("stroke", EDGE_COLORS.azure)
      .attr("stroke-width", 1.8)
      .attr("stroke-opacity", 0.55)
      .attr("marker-end", "url(#arr-azure)");

    const allLabelEdges = sE.filter(e => e.label || e.trafficLabel);
    const linkLbl = linkG.selectAll("text").data(allLabelEdges).join("text")
      .attr("text-anchor", "middle").attr("fill", d => d.type === "azure" ? "#60A5FA" : (d.trafficLabel && !d.label ? "#22D3EE" : "#A855F7")).attr("font-size", "9px").attr("font-family", "monospace")
      .text(d => (d.label && d.trafficLabel) ? `${d.label} · ${d.trafficLabel}` : (d.label || d.trafficLabel || ""));

    // ── Nodes ──
    const nodeG = g.append("g");
    const node = nodeG.selectAll("g").data(sN).join("g").style("cursor", "pointer")
      .call(d3.drag()
        .on("start", (ev, d) => { if (!ev.active) sim.alphaTarget(0.35).restart(); d.fx = d.x; d.fy = d.y; })
        .on("drag", (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
        .on("end", (ev, d) => {
          if (!ev.active) sim.alphaTarget(0);
          d.fx = null;
          d.fy = null;
        })
      )
      .on("click", (ev, d) => { ev.stopPropagation(); onSelect(d.id === selectedId ? null : d); });

    const iconColor = d => KINDS[d.kind]?.color || "#94A3B8";

    // Glow ring (health / selection)
    node.append("circle")
      .attr("r", 34)
      .attr("fill", "none")
      .attr("stroke", d => {
        const h = nodeHealthLevel(d.id, issues);
        return d.id === selectedId ? iconColor(d) : h === "ok" ? "transparent" : HEALTH_COLORS[h];
      })
      .attr("stroke-width", 2).attr("stroke-opacity", 0.7)
      .attr("filter", d => {
        const h = nodeHealthLevel(d.id, issues);
        return (h !== "ok" || d.id === selectedId) ? "url(#glow)" : "none";
      });

    // Isometric 3D icon shapes
    node.each(function (d) {
      const sel = d3.select(this);
      const color = iconColor(d);
      const shapes = KIND_ICON[d.kind] || fallbackIcon;
      const iconG = sel.append("g").attr("filter", "url(#iconShadow)");

      shapes.forEach(s => {
        const fc = faceColor(s.face, color);
        const op = s.opacity || 1;

        if (s.t === "path") {
          if (s.noFill) {
            iconG.append("path").attr("d", s.d)
              .attr("fill", "none").attr("stroke", fc).attr("stroke-width", 1).attr("opacity", op * 0.3);
          } else {
            iconG.append("path").attr("d", s.d)
              .attr("fill", fc).attr("stroke", shadeHex(color, 0.25)).attr("stroke-width", 0.5).attr("opacity", op);
          }
        } else if (s.t === "line") {
          iconG.append("line")
            .attr("x1", s.x1).attr("y1", s.y1).attr("x2", s.x2).attr("y2", s.y2)
            .attr("stroke", s.face === "accent" ? color : "rgba(255,255,255,0.2)")
            .attr("stroke-width", s.strokeWidth || 1)
            .attr("stroke-linecap", "round");
        } else if (s.t === "circle") {
          iconG.append("circle")
            .attr("cx", s.cx).attr("cy", s.cy).attr("r", s.r)
            .attr("fill", fc);
        }
      });
    });

    // Health dot (top-right of icon)
    node.append("circle")
      .attr("cx", 22).attr("cy", -30)
      .attr("r", 5)
      .attr("fill", d => {
        const h = nodeHealthLevel(d.id, issues);
        return h === "critical" ? "#EF4444" : h === "warning" ? "#F59E0B" : h === "info" ? "#60A5FA" : "#22C55E";
      })
      .attr("stroke", "#0F172A").attr("stroke-width", 1.5);

    // Kind tag (above icon)
    node.append("text")
      .attr("y", -40).attr("text-anchor", "middle")
      .attr("fill", d => KINDS[d.kind]?.color || "#94A3B8")
      .attr("font-size", "9px").attr("font-weight", "bold").attr("font-family", "monospace")
      .text(d => KINDS[d.kind]?.tag || d.kind.slice(0, 3).toUpperCase());

    // Name (below icon)
    node.append("text")
      .attr("y", 30).attr("text-anchor", "middle")
      .attr("fill", "#E2E8F0").attr("font-size", "11px").attr("font-weight", "600")
      .text(d => { const n = showName(d); return n.length > 21 ? n.slice(0, 20) + "…" : n; });

    // Status + metrics
    node.append("text")
      .attr("y", 42).attr("text-anchor", "middle")
      .attr("font-size", "9px").attr("font-family", "monospace")
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
      .attr("x", 16).attr("y", -24).attr("width", 30).attr("height", 14).attr("rx", 4)
      .attr("fill", d => d.restarts >= 10 ? "#7F1D1D" : "#451A03");
    node.filter(d => d.restarts >= 3).append("text")
      .attr("x", 31).attr("y", -14).attr("text-anchor", "middle")
      .attr("fill", d => d.restarts >= 10 ? "#FCA5A5" : "#FCD34D")
      .attr("font-size", "9px").attr("font-weight", "bold").attr("font-family", "monospace")
      .text(d => `↺${d.restarts}`);

    // Namespace label
    node.append("text")
      .attr("y", 52).attr("text-anchor", "middle")
      .attr("fill", "#334155").attr("font-size", "8px")
      .text(d => d.namespace);

    svg.on("click", () => onSelect(null));
    sim.on("tick", () => {
      link.attr("x1", d => d.source.x).attr("y1", d => d.source.y).attr("x2", d => d.target.x).attr("y2", d => d.target.y);
      azureLink.attr("d", d => {
        const sx = d.source.x, sy = d.source.y;
        const tx = d.target.x, ty = d.target.y;
        const midY = sy + (ty - sy) * 0.35;
        return `M${sx},${sy} L${sx},${midY} L${tx},${midY} L${tx},${ty}`;
      });
      linkLbl.attr("x", d => (d.source.x + d.target.x) / 2).attr("y", d => {
        if (d.type === "azure") {
          const midY = d.source.y + (d.target.y - d.source.y) * 0.35;
          return midY - 5;
        }
        return (d.source.y + d.target.y) / 2 - 5;
      });
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
