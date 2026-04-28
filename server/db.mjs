import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function hasColumn(db, table, col) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some(r => r.name === col);
}

/**
 * @param {string} filePath
 * @returns {import("node:sqlite").DatabaseSync}
 */
export function openAuthDb(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL DEFAULT (datetime('now')),
      user_id INTEGER,
      action TEXT NOT NULL,
      meta_json TEXT NOT NULL DEFAULT '{}',
      ip TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);

    CREATE TABLE IF NOT EXISTS saved_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, name),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_views_user ON saved_views(user_id);

    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      data_json TEXT NOT NULL,
      share_id TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_snap_user ON snapshots(user_id);
    CREATE INDEX IF NOT EXISTS idx_snap_created ON snapshots(created_at);
  `);

  // Migrations for older installs
  if (!hasColumn(db, "users", "role")) {
    db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'viewer'");
  }
  if (!hasColumn(db, "users", "disabled")) {
    db.exec("ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0");
  }
  return db;
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function userCount(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function findUserByUsername(db, username) {
  const u = String(username || "").trim().toLowerCase();
  if (!u) return undefined;
  return db.prepare("SELECT id, username, password_hash, role, disabled FROM users WHERE username = ?").get(u);
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function findUserById(db, id) {
  const n = Number(id);
  if (!Number.isFinite(n)) return undefined;
  return db.prepare("SELECT id, username, role, disabled FROM users WHERE id = ?").get(n);
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function insertUser(db, username, passwordHash, role) {
  const u = String(username || "").trim().toLowerCase();
  const rl = role === "admin" ? "admin" : "viewer";
  const stmt = db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)");
  const r = stmt.run(u, passwordHash, rl);
  return { id: String(r.lastInsertRowid), username: u, role: rl, disabled: 0 };
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function listUsers(db, limit = 500) {
  const lim = Math.max(1, Math.min(2000, Number(limit) || 500));
  return db.prepare(
    "SELECT id, username, role, disabled, created_at AS createdAt FROM users ORDER BY id ASC LIMIT ?",
  ).all(lim);
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function setUserRole(db, userId, role) {
  const uid = Number(userId);
  const rl = role === "admin" ? "admin" : "viewer";
  db.prepare("UPDATE users SET role=? WHERE id=?").run(rl, uid);
  return findUserById(db, uid);
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function setUserDisabled(db, userId, disabled) {
  const uid = Number(userId);
  const dis = disabled ? 1 : 0;
  db.prepare("UPDATE users SET disabled=? WHERE id=?").run(dis, uid);
  return findUserById(db, uid);
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function setUserPasswordHash(db, userId, passwordHash) {
  const uid = Number(userId);
  db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(String(passwordHash), uid);
  return findUserById(db, uid);
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function writeAudit(db, { userId, action, meta, ip }) {
  const metaJson = meta ? JSON.stringify(meta) : "{}";
  db.prepare("INSERT INTO audit_log (user_id, action, meta_json, ip) VALUES (?, ?, ?, ?)").run(
    userId != null ? Number(userId) : null,
    String(action),
    metaJson,
    ip ? String(ip) : null,
  );
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function listAudit(db, limit = 200) {
  const lim = Math.max(1, Math.min(500, Number(limit) || 200));
  return db.prepare(
    "SELECT id, at, user_id AS userId, action, meta_json AS metaJson, ip FROM audit_log ORDER BY id DESC LIMIT ?",
  ).all(lim);
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function upsertView(db, userId, name, data) {
  const nm = String(name || "").trim();
  const dataJson = JSON.stringify(data || {});
  const uid = Number(userId);
  db.prepare(
    `INSERT INTO saved_views (user_id, name, data_json, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, name) DO UPDATE SET data_json=excluded.data_json, updated_at=datetime('now')`,
  ).run(uid, nm, dataJson);
  return db.prepare(
    "SELECT id, name, data_json AS dataJson, created_at AS createdAt, updated_at AS updatedAt FROM saved_views WHERE user_id=? AND name=?",
  ).get(uid, nm);
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function listViews(db, userId) {
  const uid = Number(userId);
  return db.prepare(
    "SELECT id, name, data_json AS dataJson, created_at AS createdAt, updated_at AS updatedAt FROM saved_views WHERE user_id=? ORDER BY updated_at DESC",
  ).all(uid);
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function deleteView(db, userId, viewId) {
  const uid = Number(userId);
  const vid = Number(viewId);
  return db.prepare("DELETE FROM saved_views WHERE user_id=? AND id=?").run(uid, vid).changes;
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function createSnapshot(db, userId, title, data, shareId = null) {
  const uid = Number(userId);
  const ttl = String(title || "").trim() || "Snapshot";
  const dataJson = JSON.stringify(data || {});
  const r = db.prepare("INSERT INTO snapshots (user_id, title, data_json, share_id) VALUES (?, ?, ?, ?)").run(
    uid,
    ttl,
    dataJson,
    shareId,
  );
  return db.prepare(
    "SELECT id, title, created_at AS createdAt, share_id AS shareId FROM snapshots WHERE id=? AND user_id=?",
  ).get(Number(r.lastInsertRowid), uid);
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function listSnapshots(db, userId, limit = 50) {
  const uid = Number(userId);
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  return db.prepare(
    "SELECT id, title, created_at AS createdAt, share_id AS shareId FROM snapshots WHERE user_id=? ORDER BY id DESC LIMIT ?",
  ).all(uid, lim);
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function getSnapshot(db, userId, snapId) {
  const uid = Number(userId);
  const sid = Number(snapId);
  return db.prepare(
    "SELECT id, title, data_json AS dataJson, created_at AS createdAt, share_id AS shareId FROM snapshots WHERE user_id=? AND id=?",
  ).get(uid, sid);
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function getSharedSnapshot(db, shareId) {
  const s = String(shareId || "").trim();
  if (!s) return undefined;
  return db.prepare(
    "SELECT id, title, data_json AS dataJson, created_at AS createdAt FROM snapshots WHERE share_id=?",
  ).get(s);
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function setSnapshotShareId(db, userId, snapId, shareId) {
  const uid = Number(userId);
  const sid = Number(snapId);
  const sh = String(shareId || "").trim() || null;
  db.prepare("UPDATE snapshots SET share_id=? WHERE user_id=? AND id=?").run(sh, uid, sid);
  return db.prepare(
    "SELECT id, title, created_at AS createdAt, share_id AS shareId FROM snapshots WHERE user_id=? AND id=?",
  ).get(uid, sid);
}
