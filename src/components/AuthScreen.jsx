import { useState, useEffect } from "react";

export function AuthScreen({ defaultTab, allowSignup, hasUsers, error, onLogin, onSignup }) {
  const showLogin = hasUsers;
  const showSignup = allowSignup;
  const [mode, setMode] = useState(() => {
    if (showSignup && !showLogin) return "signup";
    if (defaultTab === "signup" && showSignup) return "signup";
    return "login";
  });

  useEffect(() => {
    if (showSignup && !showLogin) setMode("signup");
    else if (defaultTab === "signup" && showSignup) setMode("signup");
    else if (showLogin) setMode("login");
  }, [defaultTab, showSignup, showLogin]);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  const inputStyle = {
    width: "100%",
    boxSizing: "border-box",
    background: "#020817",
    border: "1px solid #334155",
    borderRadius: 8,
    color: "#E2E8F0",
    fontSize: 15,
    padding: "12px 14px",
    outline: "none",
    marginBottom: 14,
  };

  return (
    <div
      style={{
        background: "#020817",
        minHeight: "100vh",
        color: "#E2E8F0",
        fontFamily: "system-ui,sans-serif",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 400,
          background: "#0F172A",
          border: "1px solid #1E293B",
          borderRadius: 14,
          padding: "28px 24px",
          boxSizing: "border-box",
        }}
      >
        <div style={{ fontSize: 11, color: "#6366F1", letterSpacing: 2, textTransform: "uppercase", marginBottom: 8 }}>Korumalı erişim</div>
        <h1
          style={{
            fontSize: 22,
            fontWeight: 800,
            margin: "0 0 8px",
            background: "linear-gradient(135deg,#3B82F6,#A855F7)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
          }}
        >
          K8s Topology
        </h1>
        <p style={{ fontSize: 13, color: "#64748B", marginBottom: 18 }}>
          {showLogin && showSignup ? "Giriş yapın veya hesap oluşturun." : showSignup && !showLogin ? "İlk kullanıcı hesabını oluşturun." : "Giriş yapın."}
        </p>

        {showLogin && showSignup ? (
          <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
            <button
              type="button"
              onClick={() => setMode("login")}
              style={{
                flex: 1,
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid #334155",
                background: mode === "login" ? "#1E3A5F" : "#0F172A",
                color: mode === "login" ? "#93C5FD" : "#64748B",
                fontWeight: 600,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              Giriş
            </button>
            <button
              type="button"
              onClick={() => setMode("signup")}
              style={{
                flex: 1,
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid #334155",
                background: mode === "signup" ? "#1E3A5F" : "#0F172A",
                color: mode === "signup" ? "#93C5FD" : "#64748B",
                fontWeight: 600,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              Kayıt
            </button>
          </div>
        ) : null}

        {mode === "login" && showLogin ? (
          <form
            onSubmit={async e => {
              e.preventDefault();
              await Promise.resolve(onLogin(username, password));
            }}
          >
            <label style={{ fontSize: 12, color: "#94A3B8", display: "block", marginBottom: 8 }}>Kullanıcı adı</label>
            <input
              type="text"
              autoComplete="username"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="ornek_kullanici"
              style={inputStyle}
            />
            <label style={{ fontSize: 12, color: "#94A3B8", display: "block", marginBottom: 8 }}>Parola</label>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              style={inputStyle}
            />
            {error ? (
              <div style={{ color: "#FCA5A5", fontSize: 13, marginBottom: 14, background: "#450A0A", padding: "10px 12px", borderRadius: 8 }}>{error}</div>
            ) : null}
            <button
              type="submit"
              style={{
                width: "100%",
                background: "#6366F1",
                border: "none",
                color: "#fff",
                borderRadius: 8,
                padding: "12px 16px",
                fontWeight: 700,
                fontSize: 14,
                cursor: "pointer",
              }}
            >
              Giriş
            </button>
          </form>
        ) : null}

        {mode === "signup" && showSignup ? (
          <form
            onSubmit={async e => {
              e.preventDefault();
              await Promise.resolve(onSignup(username, password, confirm));
            }}
          >
            <label style={{ fontSize: 12, color: "#94A3B8", display: "block", marginBottom: 8 }}>Kullanıcı adı</label>
            <input
              type="text"
              autoComplete="username"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="3–32 karakter (a-z, 0-9, _)"
              style={inputStyle}
            />
            <label style={{ fontSize: 12, color: "#94A3B8", display: "block", marginBottom: 8 }}>Parola</label>
            <input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="En az 8 karakter"
              style={inputStyle}
            />
            <label style={{ fontSize: 12, color: "#94A3B8", display: "block", marginBottom: 8 }}>Parola tekrar</label>
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              placeholder="••••••••"
              style={inputStyle}
            />
            {error ? (
              <div style={{ color: "#FCA5A5", fontSize: 13, marginBottom: 14, background: "#450A0A", padding: "10px 12px", borderRadius: 8 }}>{error}</div>
            ) : null}
            <button
              type="submit"
              style={{
                width: "100%",
                background: "#7C3AED",
                border: "none",
                color: "#fff",
                borderRadius: 8,
                padding: "12px 16px",
                fontWeight: 700,
                fontSize: 14,
                cursor: "pointer",
              }}
            >
              Hesap oluştur
            </button>
          </form>
        ) : null}
      </div>
    </div>
  );
}
