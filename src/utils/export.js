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

export function exportTopologySvg(svgEl) {
  if (!svgEl) return;
  const ser = new XMLSerializer().serializeToString(svgEl);
  downloadTextFile(
    `k8s-topology-${new Date().toISOString().slice(0, 19).replace(/:/g, "")}.svg`,
    ser,
    "image/svg+xml;charset=utf-8",
  );
}

export function exportTableCsv(nodes, issues, nodeHealthLevel, maskSecrets) {
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
  const csv = [
    "kind,name,namespace,status,health,restarts,cpu_percent,memory_percent",
    ...rows,
  ].join("\n");
  downloadTextFile(
    `k8s-topology-${new Date().toISOString().slice(0, 19).replace(/:/g, "")}.csv`,
    csv,
    "text/csv;charset=utf-8",
  );
}
