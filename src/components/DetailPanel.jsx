import { KINDS, EDGE_COLORS, HEALTH_COLORS, KUBECTL_PLURAL } from "../constants/theme.js";
import { nodeHealthLevel } from "../utils/health.js";
import { formatCpuRequestMilli, formatMemoryMi } from "../utils/kubectl.js";
import { formatShortRps } from "../utils/mesh-prometheus.js";
import { LogViewer } from "./LogViewer.jsx";

export function DetailPanel({
  selected, detailNode, issues, filtered, graphWithTraffic,
  dependencyImpact, selectedEvents, rolloutNodes, selectedAzureDeps,
  maskSecrets, setSelected,
  podLogContainer, setPodLogContainer, podLogLoading, podLogErr, podLogText, onPodLogRefresh,
}) {
  if (!selected) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#334155", fontSize: 13, padding: 20, textAlign: "center", gap: 8 }}>
        <div style={{ fontSize: 36 }}>&#x1F446;</div>
        <div>Bir node'a tıklayın</div>
        <div style={{ fontSize: 11, color: "#1E293B" }}>Detayları, metrikleri ve sorunlarını görün</div>
      </div>
    );
  }

  const copyText = async (t) => { try { await navigator.clipboard.writeText(t); } catch { /* */ } };
  const plural = KUBECTL_PLURAL[selected.kind] || `${selected.kind.toLowerCase()}s`;
  const getL = `kubectl get ${plural} ${selected.name} -n ${selected.namespace}`;
  const descL = `kubectl describe ${plural} ${selected.name} -n ${selected.namespace}`;
  const h = nodeHealthLevel(selected.id, issues);
  const showName = (n) => maskSecrets && n.kind === "Secret" ? "••••" : n.name;

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{
        flex: selected.kind === "Pod" ? "0 1 auto" : 1,
        maxHeight: selected.kind === "Pod" ? "46%" : undefined,
        minHeight: 0, overflowY: "auto", padding: 14, boxSizing: "border-box",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <span style={{ fontWeight: 700, fontSize: 13 }}>Detay</span>
          <button onClick={() => setSelected(null)} style={{ background: "transparent", border: "none", color: "#64748B", cursor: "pointer", fontSize: 18, lineHeight: 1 }}>&times;</button>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
          <button type="button" onClick={() => copyText(getL)} style={{ background: "#14532D", border: "1px solid #166534", color: "#BBF7D0", borderRadius: 6, padding: "4px 8px", fontSize: 10, cursor: "pointer" }}>get kopyala</button>
          <button type="button" onClick={() => copyText(descL)} style={{ background: "#0F172A", border: "1px solid #334155", color: "#CBD5E1", borderRadius: 6, padding: "4px 8px", fontSize: 10, cursor: "pointer" }}>describe kopyala</button>
        </div>

        <div style={{ display: "inline-flex", alignItems: "center", gap: 6, background: `${HEALTH_COLORS[h]}22`, border: `1px solid ${HEALTH_COLORS[h]}55`, borderRadius: 20, padding: "3px 12px", marginBottom: 10, fontSize: 11, color: HEALTH_COLORS[h], fontWeight: 600 }}>
          {h === "critical" ? "🔴 Kritik" : h === "warning" ? "🟡 Uyarı" : h === "info" ? "🔵 Bilgi" : "🟢 Sağlıklı"}
        </div>{" "}
        <span style={{ background: `${KINDS[selected.kind]?.color}22`, border: `1px solid ${KINDS[selected.kind]?.color}55`, borderRadius: 6, padding: "2px 10px", fontSize: 11, color: KINDS[selected.kind]?.color, fontFamily: "monospace" }}>
          {KINDS[selected.kind]?.tag} {selected.kind}
        </span>

        {/* Mesh traffic */}
        {detailNode && (detailNode.trafficInRps != null || detailNode.trafficOutRps != null) && (
          <div style={{ marginTop: 10, padding: "8px 10px", background: "#042f2e", border: "1px solid #134e4a", borderRadius: 8 }}>
            <div style={{ fontSize: 10, color: "#5eead4", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>Mesh trafiği (5m rate)</div>
            {detailNode.trafficInRps != null && (
              <div style={{ fontSize: 12, color: "#ccfbf1", marginBottom: 4 }}>
                ↓ Gelen: <b>{formatShortRps(detailNode.trafficInRps)}</b> rps
                {detailNode.trafficErrRatio > 0.005 && <span style={{ color: "#fca5a5" }}> &middot; ~{(detailNode.trafficErrRatio * 100).toFixed(1)}% 5xx</span>}
              </div>
            )}
            {detailNode.trafficOutRps != null && (
              <div style={{ fontSize: 12, color: "#ccfbf1" }}>↑ Giden: <b>{formatShortRps(detailNode.trafficOutRps)}</b> rps</div>
            )}
          </div>
        )}

        {/* Dependency impact */}
        {dependencyImpact && (
          <div style={{ marginTop: 10, padding: "8px 10px", background: "#111827", border: "1px solid #1F2937", borderRadius: 8 }}>
            <div style={{ fontSize: 10, color: "#93C5FD", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>Bağımlılık etkisi</div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", fontSize: 11, marginBottom: 6 }}>
              <span style={{ color: "#CBD5E1" }}>Doğrudan upstream: <b>{dependencyImpact.directUpstream.length}</b></span>
              <span style={{ color: "#CBD5E1" }}>Doğrudan downstream: <b>{dependencyImpact.directDownstream.length}</b></span>
              <span style={{ color: "#FCA5A5" }}>Etkilenebilecek kaynak: <b>{dependencyImpact.impactedWorkloads.length}</b></span>
            </div>
            <div style={{ fontSize: 10, color: "#94A3B8", lineHeight: 1.45 }}>
              {dependencyImpact.directUpstream.slice(0, 3).map(n => <div key={`up-${n.id}`}>&uarr; {n.kind} {n.namespace}/{showName(n)}</div>)}
              {dependencyImpact.directDownstream.slice(0, 4).map(n => <div key={`dn-${n.id}`}>&darr; {n.kind} {n.namespace}/{showName(n)}</div>)}
            </div>
          </div>
        )}

        {/* Detail fields */}
        <div style={{ marginTop: 12 }}>
          {[
            ["Ad", showName(selected), "monospace"],
            ["Namespace", selected.namespace],
            ["Durum", selected.status],
            ...(selected.kind === "Node" && selected.nodeRoles?.length ? [["Rol", selected.nodeRoles.join(", ")]] : []),
            ...(selected.kind === "Node" && selected.nodeVersion ? [["Kubelet", selected.nodeVersion]] : []),
            ...(selected.kind === "Pod" && selected.nodeName ? [["Node", selected.nodeName]] : []),
            ...(selected.kind === "Node" && selected.podCount != null ? [["Pod sayısı", String(selected.podCount)]] : []),
            ...(selected.restarts > 0 ? [["Yeniden Başlama", `${selected.restarts} kez`]] : []),
            ...(selected.cpuPercent != null ? [["CPU Kullanımı", `%${selected.cpuPercent}`, null, selected.cpuPercent > 80 ? "#EF4444" : selected.cpuPercent > 60 ? "#F59E0B" : "#22C55E"]] : []),
            ...(selected.metricsCpuMilli != null && selected.cpuPercent == null ? [["CPU (metrics)", `${selected.metricsCpuMilli}m`, null, "#94A3B8"]] : []),
            ...(selected.memPercent != null ? [["Memory Kullanımı", `%${selected.memPercent}`, null, selected.memPercent > 85 ? "#EF4444" : selected.memPercent > 70 ? "#F59E0B" : "#22C55E"]] : []),
          ].map(([l, v, ff, vc]) => (
            <div key={l} style={{ marginBottom: 9 }}>
              <div style={{ fontSize: 10, color: "#475569", textTransform: "uppercase", letterSpacing: 1, marginBottom: 2 }}>{l}</div>
              <div style={{ fontSize: 13, wordBreak: "break-all", fontFamily: ff || "inherit", color: vc || "#E2E8F0" }}>{v}</div>
            </div>
          ))}
        </div>

        {/* Pod images */}
        {selected.kind === "Pod" && selected.podImageInfo && (
          <div style={{ marginTop: 10, marginBottom: 4 }}>
            <div style={{ fontSize: 10, color: "#475569", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>Container imajları</div>
            <div style={{ fontSize: 11, fontFamily: "ui-monospace,monospace", color: "#CBD5E1", whiteSpace: "pre-wrap", wordBreak: "break-all", lineHeight: 1.45 }}>{selected.podImageInfo}</div>
          </div>
        )}

        {/* Node conditions */}
        {selected.kind === "Node" && selected.nodePressure?.length > 0 && (
          <div style={{ marginTop: 10, marginBottom: 4 }}>
            <div style={{ fontSize: 10, color: "#475569", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>Node condition</div>
            <div style={{ fontSize: 11, color: "#CBD5E1", lineHeight: 1.45 }}>
              {selected.nodePressure.map(p => <div key={p.type} style={{ color: p.status ? "#FCD34D" : "#64748B" }}>{p.type}: {p.status ? "aktif" : "yok"}</div>)}
            </div>
          </div>
        )}

        {/* Azure service info */}
        {selected.kind === "AzureService" && (
          <div style={{ marginTop: 10, marginBottom: 4 }}>
            <div style={{ fontSize: 10, color: "#475569", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>Azure servis bilgisi</div>
            <div style={{ fontSize: 11, color: "#CBD5E1", lineHeight: 1.5 }}>
              <div>Tür: {selected.azureServiceType || "Azure Service"}</div>
              {selected.azureRawName && <div>Kaynak: {selected.azureRawName}</div>}
              <div>Güven: <span style={{ color: selected.azureConfidence === "confirmed" ? "#86EFAC" : "#FCD34D" }}>{selected.azureConfidence === "confirmed" ? "Confirmed" : "Inferred"}</span></div>
              <div>Kanıt: {selected.azureEvidence || "metadata"}</div>
            </div>
          </div>
        )}

        {/* Azure deps */}
        {selectedAzureDeps.length > 0 && selected.kind !== "AzureService" && (
          <div style={{ marginTop: 10, marginBottom: 4 }}>
            <div style={{ fontSize: 10, color: "#475569", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>Azure Dependencies</div>
            <div style={{ fontSize: 11, lineHeight: 1.45 }}>
              {selectedAzureDeps.map(dep => (
                <div key={dep.id} onClick={() => setSelected(dep)} style={{ cursor: "pointer", padding: "4px 0", borderBottom: "1px solid #0F172A" }}>
                  <span style={{ color: "#60A5FA" }}>{dep.azureServiceType || "Azure Service"}</span>
                  <span style={{ color: "#CBD5E1" }}> &middot; {dep.name}</span>
                  <span style={{ color: dep.azureConfidence === "confirmed" ? "#86EFAC" : "#FCD34D" }}> &middot; {dep.azureConfidence === "confirmed" ? "Confirmed" : "Inferred"}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Resources */}
        {selected.resources && (
          <div style={{ marginTop: 10, marginBottom: 4 }}>
            <div style={{ fontSize: 10, color: "#475569", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>İstek / limit</div>
            <div style={{ fontSize: 11, color: "#CBD5E1", lineHeight: 1.5 }}>
              {selected.resources.reqCpuMilli != null && <div>CPU istek: {formatCpuRequestMilli(selected.resources.reqCpuMilli)}</div>}
              {selected.resources.limCpuMilli != null && <div>CPU limit: {formatCpuRequestMilli(selected.resources.limCpuMilli)}</div>}
              {selected.resources.reqMemMi != null && <div>Memory istek: {formatMemoryMi(selected.resources.reqMemMi)}</div>}
              {selected.resources.limMemMi != null && <div>Memory limit: {formatMemoryMi(selected.resources.limMemMi)}</div>}
              {selected.metricsCpuMilli != null && selected.resources.reqCpuMilli != null && (
                <div style={{ color: selected.metricsCpuMilli > selected.resources.reqCpuMilli ? "#FCD34D" : "#86EFAC" }}>
                  Canlı CPU / istek: {selected.metricsCpuMilli}m / {selected.resources.reqCpuMilli}m
                </div>
              )}
            </div>
          </div>
        )}

        {/* Rollout */}
        {selected.rollout && (
          <div style={{ marginTop: 10, marginBottom: 4 }}>
            <div style={{ fontSize: 10, color: "#475569", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>Rollout</div>
            <div style={{ fontSize: 11, color: "#CBD5E1", lineHeight: 1.5 }}>
              {selected.rollout.revision && <div>Revizyon: {selected.rollout.revision}</div>}
              {selected.rollout.changeCause && <div>Change cause: {selected.rollout.changeCause}</div>}
              {selected.rollout.owners?.length > 0 && <div>Sahip: {selected.rollout.owners.join(", ")}</div>}
              {rolloutNodes.length > 0 && (
                <div style={{ marginTop: 4, color: "#93C5FD" }}>
                  İlgili {selected.kind === "Deployment" ? "ReplicaSet" : "Pod"}: {rolloutNodes.slice(0, 4).map(n => n.name).join(", ")}{rolloutNodes.length > 4 ? " …" : ""}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Resource events */}
        {selectedEvents.length > 0 && (
          <div style={{ marginTop: 10, marginBottom: 4 }}>
            <div style={{ fontSize: 10, color: "#475569", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>Kaynağa özel event</div>
            <div style={{ maxHeight: 120, overflowY: "auto", fontSize: 10, lineHeight: 1.45 }}>
              {selectedEvents.slice(0, 6).map(ev => (
                <div key={`sel-ev-${ev.id}`} style={{ padding: "4px 0", borderBottom: "1px solid #0F172A" }}>
                  <div style={{ color: ev.type === "Warning" ? "#F59E0B" : "#94A3B8" }}>{ev.reason || "—"} <span style={{ color: "#475569" }}>{ev.last ? new Date(ev.last).toLocaleTimeString() : ""}</span></div>
                  <div style={{ color: "#CBD5E1" }}>{ev.msg}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Node issues */}
        {issues.filter(i => i.id === selected.id).length > 0 && (
          <div style={{ marginTop: 8, marginBottom: 12 }}>
            <div style={{ fontSize: 10, color: "#475569", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>Sorunlar</div>
            {issues.filter(i => i.id === selected.id).map(issue => (
              <div key={issue.code} style={{ background: `${HEALTH_COLORS[issue.level]}11`, border: `1px solid ${HEALTH_COLORS[issue.level]}33`, borderRadius: 7, padding: "7px 9px", marginBottom: 5 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: HEALTH_COLORS[issue.level], fontFamily: "monospace", marginBottom: 3 }}>{issue.code}</div>
                <div style={{ fontSize: 11, color: "#CBD5E1", marginBottom: 4 }}>{issue.msg}</div>
                <div style={{ fontSize: 10, color: "#64748B" }}>💡 {issue.fix}</div>
              </div>
            ))}
          </div>
        )}

        {/* Connections */}
        {(() => {
          const conns = filtered.edges.filter(e => e.source === selected.id || e.target === selected.id);
          if (!conns.length) return null;
          return (
            <div>
              <div style={{ fontSize: 10, color: "#475569", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>Bağlantılar ({conns.length})</div>
              {conns.slice(0, 14).map(e => {
                const isOut = e.source === selected.id;
                const otherId = isOut ? e.target : e.source;
                const other = filtered.nodes.find(n => n.id === otherId);
                if (!other) return null;
                const oh = nodeHealthLevel(other.id, issues);
                return (
                  <div key={e.id} onClick={() => setSelected(other)}
                    style={{
                      display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", borderRadius: 7, cursor: "pointer", marginBottom: 2,
                      background: oh === "critical" ? "#1C0505" : oh === "warning" ? "#1C1005" : "#0F172A",
                      border: `1px solid ${oh !== "ok" ? HEALTH_COLORS[oh] + "44" : "transparent"}`,
                    }}>
                    <span style={{ color: EDGE_COLORS[e.type] || "#A855F7", fontSize: 11 }}>{isOut ? "→" : "←"}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 11, color: "#E2E8F0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{showName(other)}</div>
                      <div style={{ fontSize: 9, color: "#475569" }}>{e.type}{e.label ? ` · ${e.label}` : ""}</div>
                    </div>
                    <span style={{ fontSize: 9, color: KINDS[other.kind]?.color, fontFamily: "monospace" }}>{KINDS[other.kind]?.tag}</span>
                    {oh !== "ok" && <span style={{ fontSize: 10 }}>{oh === "critical" ? "🔴" : "🟡"}</span>}
                  </div>
                );
              })}
            </div>
          );
        })()}
      </div>

      <LogViewer
        selected={selected}
        podLogContainer={podLogContainer}
        setPodLogContainer={setPodLogContainer}
        podLogLoading={podLogLoading}
        podLogErr={podLogErr}
        podLogText={podLogText}
        onRefresh={onPodLogRefresh}
      />
    </div>
  );
}
