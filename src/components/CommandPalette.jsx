import { useEffect, useMemo, useRef } from "react";

export function CommandPalette({ open, query, setQuery, items, onClose, onSelect }) {
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  const filtered = useMemo(() => {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return items;
    return items.filter(it => (it.searchText || "").includes(q));
  }, [items, query]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose?.();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(2,6,23,.72)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: 72,
        zIndex: 50,
      }}
    >
      <div style={{ width: "min(720px, calc(100vw - 24px))", background: "#0B1222", border: "1px solid #1E293B", borderRadius: 14, overflow: "hidden" }}>
        <div style={{ padding: 12, borderBottom: "1px solid #1E293B", display: "flex", gap: 10, alignItems: "center" }}>
          <div style={{ color: "#64748B", fontSize: 12, fontWeight: 700, letterSpacing: 0.4 }}>⌘K</div>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Komut veya kaynak ara…"
            onKeyDown={e => {
              if (e.key === "Escape") onClose?.();
              if (e.key === "Enter" && filtered[0]) onSelect?.(filtered[0]);
            }}
            style={{
              flex: 1,
              background: "#020817",
              border: "1px solid #334155",
              borderRadius: 10,
              color: "#E2E8F0",
              padding: "10px 12px",
              fontSize: 14,
              outline: "none",
            }}
          />
          <button
            type="button"
            onClick={() => onClose?.()}
            style={{ background: "#0F172A", border: "1px solid #1E293B", color: "#94A3B8", borderRadius: 10, padding: "10px 12px", cursor: "pointer", fontSize: 12 }}
          >
            Esc
          </button>
        </div>

        <div style={{ maxHeight: "min(560px, calc(100vh - 180px))", overflow: "auto" }}>
          {filtered.length === 0 ? (
            <div style={{ padding: 14, color: "#64748B", fontSize: 13 }}>Sonuç yok</div>
          ) : (
            filtered.slice(0, 20).map(it => (
              <div
                key={it.key}
                onClick={() => onSelect?.(it)}
                style={{
                  padding: "10px 12px",
                  borderTop: "1px solid #0F172A",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                  <div style={{ color: "#E2E8F0", fontSize: 13, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.title}</div>
                  {it.subtitle ? <div style={{ color: "#64748B", fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.subtitle}</div> : null}
                </div>
                {it.hint ? <div style={{ color: "#475569", fontSize: 11, flexShrink: 0 }}>{it.hint}</div> : null}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

