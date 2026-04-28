function toCsvValue(value) {
  const str = value == null ? "" : String(value);
  return `"${str.replace(/"/g, '""')}"`;
}

export function downloadTextFile(filename, contents, mimeType) {
  const blob = new Blob([contents], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function buildTopologySvgString(svgEl) {
  if (!svgEl) return "";
  return new XMLSerializer().serializeToString(svgEl);
}

export function exportTopologySvg(svgEl) {
  if (!svgEl) return;
  const ser = buildTopologySvgString(svgEl);
  downloadTextFile(
    `k8s-topology-${new Date().toISOString().slice(0, 19).replace(/:/g, "")}.svg`,
    ser,
    "image/svg+xml;charset=utf-8",
  );
}

export function buildTableCsv(nodes, issues, nodeHealthLevel, maskSecrets) {
  const rows = nodes.map(n => [
    n.kind,
    maskSecrets && n.kind === "Secret" ? "••••" : n.name,
    n.namespace,
    n.status || "",
    nodeHealthLevel(n.id, issues),
    n.restarts ?? "",
    n.cpuPercent != null ? `${n.cpuPercent}` : "",
    n.memPercent != null ? `${n.memPercent}` : "",
  ].map(toCsvValue).join(","));
  return [
    "kind,name,namespace,status,health,restarts,cpu_percent,memory_percent",
    ...rows,
  ].join("\n");
}

export function exportTableCsv(nodes, issues, nodeHealthLevel, maskSecrets) {
  const csv = buildTableCsv(nodes, issues, nodeHealthLevel, maskSecrets);
  downloadTextFile(
    `k8s-topology-${new Date().toISOString().slice(0, 19).replace(/:/g, "")}.csv`,
    csv,
    "text/csv;charset=utf-8",
  );
}
