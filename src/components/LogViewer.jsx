export function LogViewer({ selected, podLogContainer, setPodLogContainer, podLogLoading, podLogErr, podLogText, onRefresh }) {
  if (!selected || selected.kind !== "Pod") return null;

  return (
    <div style={{
      flex: 1, minHeight: 96, display: "flex", flexDirection: "column",
      borderTop: "1px solid #1E293B", padding: "10px 14px 12px", boxSizing: "border-box", overflow: "hidden",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, flexShrink: 0 }}>
        <div style={{ fontSize: 10, color: "#475569", textTransform: "uppercase", letterSpacing: 1 }}>Pod loglar\u0131</div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          {selected.podContainers?.length > 1 && (
            <select value={podLogContainer} onChange={e => setPodLogContainer(e.target.value)} style={{ background: "#020817", border: "1px solid #1E293B", borderRadius: 6, color: "#E2E8F0", fontSize: 11, padding: "4px 8px", cursor: "pointer" }}>
              {selected.podContainers.map(nm => <option key={nm} value={nm}>{nm}</option>)}
            </select>
          )}
          <button type="button" onClick={onRefresh} style={{ background: "#1E3A5F", border: "1px solid #3B82F6", color: "#93C5FD", borderRadius: 6, padding: "4px 10px", fontSize: 10, cursor: "pointer" }}>Yenile</button>
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: "scroll", overflowX: "auto", WebkitOverflowScrolling: "touch", marginTop: 8 }}>
        {podLogLoading && <div style={{ fontSize: 11, color: "#64748B", padding: "4px 0" }}>Y\u00fckleniyor\u2026</div>}
        {podLogErr && !podLogLoading && <div style={{ fontSize: 11, color: "#F87171", wordBreak: "break-word", padding: "4px 0" }}>{podLogErr}</div>}
        {!podLogLoading && podLogText && (
          <pre style={{ margin: 0, fontSize: 10, lineHeight: 1.35, background: "#020817", border: "1px solid #1E293B", borderRadius: 8, padding: 10, color: "#E2E8F0", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{podLogText}</pre>
        )}
        {!podLogLoading && !podLogErr && !podLogText && selected.sampleLog === undefined && <div style={{ fontSize: 11, color: "#64748B", padding: "4px 0" }}>Log bo\u015f veya hen\u00fcz y\u00fcklenmedi.</div>}
      </div>
    </div>
  );
}
