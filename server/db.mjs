import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * @param {string} filePath
 * @returns {import("node:sqlite").DatabaseSync}
 */
export function openAuthDb(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
  `);
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
  return db.prepare("SELECT id, username, password_hash FROM users WHERE username = ?").get(u);
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function findUserById(db, id) {
  const n = Number(id);
  if (!Number.isFinite(n)) return undefined;
  return db.prepare("SELECT id, username FROM users WHERE id = ?").get(n);
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function insertUser(db, username, passwordHash) {
  const u = String(username || "").trim().toLowerCase();
  const stmt = db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)");
  const r = stmt.run(u, passwordHash);
  return { id: String(r.lastInsertRowid), username: u };
}
