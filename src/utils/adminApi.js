async function jsonFetch(url, opts = {}) {
  const r = await fetch(url, {
    ...opts,
    credentials: "include",
    headers: { Accept: "application/json", ...(opts.headers || {}) },
    cache: "no-store",
  });
  if (r.ok) return await r.json();
  let msg = `HTTP ${r.status}`;
  try {
    const j = await r.json();
    if (j?.message) msg = j.message;
  } catch { /* */ }
  throw new Error(msg);
}

export async function adminListUsers() {
  return await jsonFetch("/api/admin/users");
}

export async function adminSetUserRole(id, role) {
  return await jsonFetch(`/api/admin/users/${encodeURIComponent(String(id))}/role`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role }),
  });
}

export async function adminDisableUser(id, disabled) {
  return await jsonFetch(`/api/admin/users/${encodeURIComponent(String(id))}/disable`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ disabled: Boolean(disabled) }),
  });
}

export async function adminResetPassword(id, password) {
  return await jsonFetch(`/api/admin/users/${encodeURIComponent(String(id))}/reset-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
}

export async function adminListAudit(limit = 200) {
  return await jsonFetch(`/api/audit?limit=${encodeURIComponent(String(limit))}`);
}

