import { KINDS, EDGE_COLORS, EDGE_LEGEND_TR, HEALTH_COLORS } from "../constants/theme.js";
import { nodeHealthLevel } from "../utils/health.js";

export function Sidebar({
  filtered, issues, nameFilter, setNameFilter, healthFilter, setHealthFilter,
  nsFilter, nsSelectValue, setNsFilter, namespaces, typeFilters, toggleKind,
  selectAllKinds, clearAllKinds, kindCounts, searchInputRef,
}) {
  const critCount = issues.filter(i => i.level === "critical").length;
  const warnCount = issues.filter(i => i.level === "warning").length;

  return (
    <div style={{ width: 208, background: "#0A1628", borderRight: "1px solid #1E293B", display: "flex", flexDirection: "column", overflow: "hidden", flexShrink: 0 }}>
      <div style={{ padding: "12px 14px 10px", borderBottom: "1px solid #1E293B" }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>K8s Topology</div>
        <div style={{ fontSize: 11, color: "#475569", marginTop: 2 }}>{filtered.nodes.length} kaynak &middot; {filtered.edges.length} ba\u011flant\u0131</div>
      </div>

      {/* Health summary */}
      <div style={{ padding: "8px 10px", borderBottom: "1px solid #1E293B", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5 }}>
        {[
          { l: "T\u00fcm\u00fc", c: "#94A3B8", n: filtered.nodes.length },
          { l: "\ud83d\udd34 Kritik", c: "#EF4444", n: critCount },
          { l: "\ud83d\udfe1 Uyar\u0131", c: "#F59E0B", n: warnCount },
          { l: "\ud83d\udfe2 Sa\u011fl\u0131kl\u0131", c: "#22C55E", n: filtered.nodes.filter(n => nodeHealthLevel(n.id, issues) === "ok").length },
        ].map(({ l, c, n: count }) => (
          <div key={l} style={{ background: "#0F172A", border: `1px solid ${c}33`, borderRadius: 7, padding: "5px 8px", textAlign: "center" }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: c }}>{count}</div>
            <div style={{ fontSize: 9, color: "#64748B" }}>{l}</div>
          </div>
        ))}
      </div>

      {/* Filter */}
      <div style={{ padding: "8px 14px", borderBottom: "1px solid #1E293B" }}>
        <div style={{ fontSize: 10, color: "#475569", marginBottom: 6, textTransform: "uppercase", letterSpacing: 1 }}>Filtre</div>
        <input
          ref={searchInputRef}
          type="search"
          value={nameFilter}
          onChange={e => setNameFilter(e.target.value)}
          placeholder="\u0130sim, ns veya id\u2026  ( / ile ara)"
          style={{ width: "100%", boxSizing: "border-box", background: "#020817", border: "1px solid #1E293B", borderRadius: 6, color: "#E2E8F0", fontSize: 11, padding: "6px 8px", outline: "none", marginBottom: 8 }}
        />
        <div style={{ fontSize: 9, color: "#475569", marginBottom: 4 }}>Sa\u011fl\u0131k</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {[
            { k: "all", l: "T\u00fcm\u00fc", c: "#64748B" },
            { k: "critical", l: "Kritik", c: "#EF4444" },
            { k: "warning", l: "Uyar\u0131", c: "#F59E0B" },
            { k: "info", l: "Bilgi", c: "#60A5FA" },
            { k: "ok", l: "OK", c: "#22C55E" },
          ].map(({ k, l, c }) => (
            <button key={k} type="button" onClick={() => setHealthFilter(k)} style={{
              border: `1px solid ${healthFilter === k ? c : "#334155"}`,
              background: healthFilter === k ? `${c}22` : "#0F172A",
              color: healthFilter === k ? c : "#94A3B8",
              borderRadius: 6, padding: "3px 8px", fontSize: 10, cursor: "pointer",
              fontWeight: healthFilter === k ? 700 : 500,
            }}>{l}</button>
          ))}
        </div>
      </div>

      {/* NS */}
      <div style={{ padding: "8px 14px", borderBottom: "1px solid #1E293B" }}>
        <label htmlFor="ns-filter-select" style={{ display: "block", fontSize: 10, color: "#475569", marginBottom: 6, textTransform: "uppercase", letterSpacing: 1 }}>Namespace</label>
        <select id="ns-filter-select" value={nsSelectValue} onChange={e => setNsFilter(e.target.value)} style={{
          width: "100%", boxSizing: "border-box", background: "#020817", border: "1px solid #1E293B",
          borderRadius: 6, color: "#E2E8F0", fontSize: 12, padding: "6px 8px", outline: "none", cursor: "pointer", appearance: "auto",
        }}>
          <option value="all">T\u00fcm namespace'ler</option>
          {namespaces.map(ns => <option key={ns} value={ns}>{ns}</option>)}
        </select>
      </div>

      {/* Kinds */}
      <div style={{ padding: "8px 14px", flex: 1, overflowY: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, marginBottom: 6 }}>
          <span style={{ fontSize: 10, color: "#475569", textTransform: "uppercase", letterSpacing: 1 }}>T\u00fcrler</span>
          <div style={{ display: "flex", gap: 4 }}>
            <button type="button" onClick={selectAllKinds} style={{ background: "#0F172A", border: "1px solid #334155", color: "#94A3B8", borderRadius: 4, padding: "2px 6px", fontSize: 9, cursor: "pointer" }}>T\u00fcm\u00fc</button>
            <button type="button" onClick={clearAllKinds} style={{ background: "#0F172A", border: "1px solid #334155", color: "#94A3B8", borderRadius: 4, padding: "2px 6px", fontSize: 9, cursor: "pointer" }}>Temizle</button>
          </div>
        </div>
        {Object.entries(KINDS).map(([k, v]) => (
          <div key={k} onClick={() => toggleKind(k)} style={{ display: "flex", alignItems: "center", gap: 7, padding: "3px 6px", borderRadius: 6, cursor: "pointer", marginBottom: 2, opacity: typeFilters.has(k) ? 1 : 0.28 }}>
            <div style={{ width: 9, height: 9, borderRadius: 2, background: v.color, flexShrink: 0 }} />
            <span style={{ fontSize: 11, color: "#94A3B8", flex: 1 }}>{k}</span>
            {kindCounts[k] && <span style={{ fontSize: 10, color: v.color, fontWeight: 600 }}>{kindCounts[k]}</span>}
          </div>
        ))}
      </div>

      {/* Edge legend */}
      <div style={{ padding: "8px 14px", borderTop: "1px solid #1E293B" }}>
        {Object.entries(EDGE_COLORS).map(([t, c]) => (
          <div key={t} style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 3 }}>
            <div style={{ width: 18, height: 2, background: c, borderRadius: 1 }} />
            <span style={{ fontSize: 10, color: "#64748B" }}>{EDGE_LEGEND_TR[t] || t}</span>
          </div>
        ))}
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 3 }}>
          <div style={{ width: 18, height: 2, background: "#22D3EE", borderRadius: 1 }} />
          <span style={{ fontSize: 10, color: "#64748B" }}>Mesh RPS (Prometheus)</span>
        </div>
      </div>
    </div>
  );
}
