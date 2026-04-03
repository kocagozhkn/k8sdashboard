/**
 * Sunucu oturumu: /api/auth/* (Passport + cookie). SQLite kullanıcılar.
 * Sunucu yoksa (yalnızca Vite) istek düşer → uygulama açık.
 */
const BASE = "/api/auth";

/**
 * @returns {Promise<{ required: boolean, authenticated: boolean, hasUsers: boolean, allowSignup: boolean, defaultTab: string }>}
 */
export async function loadAuthStatus() {
  try {
    const r = await fetch(`${BASE}/me`, { credentials: "include", cache: "no-store" });
    if (!r.ok) {
      return { required: false, authenticated: true, hasUsers: true, allowSignup: false, defaultTab: "login" };
    }
    const j = await r.json();
    return {
      required: Boolean(j.required),
      authenticated: Boolean(j.authenticated),
      hasUsers: Boolean(j.hasUsers),
      allowSignup: Boolean(j.allowSignup),
      defaultTab: j.defaultTab === "signup" ? "signup" : "login",
    };
  } catch {
    return { required: false, authenticated: true, hasUsers: true, allowSignup: false, defaultTab: "login" };
  }
}

/**
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function loginWithCredentials(username, password) {
  try {
    const r = await fetch(`${BASE}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "include",
      body: JSON.stringify({ username: String(username || "").trim(), password }),
    });
    if (r.ok) return { ok: true };
    let msg = "Giriş başarısız";
    try {
      const j = await r.json();
      if (j.message) msg = j.message;
    } catch { /* */ }
    return { ok: false, error: msg };
  } catch (e) {
    return { ok: false, error: e.message || "Bağlantı hatası" };
  }
}

/**
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function signupAccount(username, password, confirmPassword) {
  try {
    const r = await fetch(`${BASE}/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "include",
      body: JSON.stringify({
        username: String(username || "").trim(),
        password,
        confirmPassword,
      }),
    });
    if (r.ok) return { ok: true };
    let msg = "Kayıt başarısız";
    try {
      const j = await r.json();
      if (j.message) msg = j.message;
    } catch { /* */ }
    return { ok: false, error: msg };
  } catch (e) {
    return { ok: false, error: e.message || "Bağlantı hatası" };
  }
}

export async function logoutAuth() {
  try {
    await fetch(`${BASE}/logout`, { method: "POST", credentials: "include" });
  } catch { /* */ }
}
