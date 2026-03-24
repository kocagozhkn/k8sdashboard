import { Component } from "react";

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          background: "#020817", minHeight: "100vh", color: "#E2E8F0",
          fontFamily: "system-ui, sans-serif", display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center", gap: 16, padding: 24,
        }}>
          <div style={{ fontSize: 48 }}>&#x26A0;&#xFE0F;</div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: "#EF4444" }}>
            Beklenmeyen bir hata olu\u015ftu
          </h2>
          <pre style={{
            background: "#0F172A", border: "1px solid #1E293B", borderRadius: 8,
            padding: 16, fontSize: 12, color: "#FCA5A5", maxWidth: 600,
            overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word",
          }}>
            {this.state.error?.message || String(this.state.error)}
          </pre>
          <button
            onClick={() => { this.setState({ hasError: false, error: null }); }}
            style={{
              background: "#3B82F6", border: "none", color: "#fff",
              borderRadius: 8, padding: "10px 24px", cursor: "pointer",
              fontWeight: 600, fontSize: 14,
            }}
          >
            Yeniden Dene
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
