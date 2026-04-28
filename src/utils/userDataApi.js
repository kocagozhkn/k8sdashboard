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

export async function listSavedViews() {
  return await jsonFetch("/api/views");
}

export async function saveView(name, data) {
  return await jsonFetch("/api/views", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, data }),
  });
}

export async function deleteView(viewId) {
  return await jsonFetch(`/api/views/${encodeURIComponent(String(viewId))}`, {
    method: "DELETE",
  });
}

export async function listSnapshots() {
  return await jsonFetch("/api/snapshots");
}

export async function createSnapshot(title, data) {
  return await jsonFetch("/api/snapshots", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, data }),
  });
}

export async function shareSnapshot(snapshotId) {
  return await jsonFetch(`/api/snapshots/${encodeURIComponent(String(snapshotId))}/share`, {
    method: "POST",
  });
}

export async function getSharedSnapshot(shareId) {
  return await jsonFetch(`/api/share/${encodeURIComponent(String(shareId))}`);
}

