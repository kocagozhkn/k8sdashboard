import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import session from "express-session";
import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import { createProxyMiddleware } from "http-proxy-middleware";
import bcrypt from "bcryptjs";
import { openAuthDb, userCount, findUserByUsername, findUserById, insertUser } from "./db.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");

const PORT = Number(process.env.PORT || 3333, 10);
const STATIC_DIR = process.env.STATIC_DIR?.trim() || "";
const AUTH_DISABLED = process.env.AUTH_DISABLED === "1";
const sqliteRaw = (process.env.SQLITE_PATH || "data/auth.db").trim();
const SQLITE_PATH = path.isAbsolute(sqliteRaw) ? sqliteRaw : path.join(rootDir, sqliteRaw);
const ALLOW_SIGNUP = process.env.ALLOW_SIGNUP !== "0" && process.env.ALLOW_SIGNUP !== "false";
const SESSION_SECRET =
  (process.env.SESSION_SECRET || "").trim() ||
  (AUTH_DISABLED ? "no-auth-session" : "dev-only-set-SESSION_SECRET-in-production");
const K8S_PROXY_TARGET = (process.env.K8S_PROXY_TARGET || "http://127.0.0.1:8001").replace(/\/$/, "");
const PROMETHEUS_UPSTREAM = (process.env.PROMETHEUS_UPSTREAM || "127.0.0.1:9090").replace(/^https?:\/\//, "");
const PROMETHEUS_TARGET = `http://${PROMETHEUS_UPSTREAM}`;
const TRUST_PROXY = process.env.TRUST_PROXY === "1" || process.env.NODE_ENV === "production";
const COOKIE_SECURE = process.env.COOKIE_SECURE === "1";

const USERNAME_RE = /^[a-z0-9_]{3,32}$/;
const BCRYPT_ROUNDS = 10;

/** @type {import("node:sqlite").DatabaseSync | null} */
let db = null;
if (!AUTH_DISABLED) {
  db = openAuthDb(SQLITE_PATH);
}

function signupPolicy() {
  if (AUTH_DISABLED || !db) return { allowSignup: false, hasUsers: true, defaultTab: "login" };
  const n = userCount(db);
  if (n === 0) return { allowSignup: true, hasUsers: false, defaultTab: "signup" };
  return {
    allowSignup: ALLOW_SIGNUP,
    hasUsers: true,
    defaultTab: "login",
  };
}

function authMePayload(req) {
  if (AUTH_DISABLED || !db) {
    return { required: false, authenticated: true, hasUsers: true, allowSignup: false, defaultTab: "login" };
  }
  const pol = signupPolicy();
  return {
    required: true,
    authenticated: Boolean(req.user),
    hasUsers: pol.hasUsers,
    allowSignup: pol.allowSignup,
    defaultTab: pol.defaultTab,
  };
}

const app = express();
if (TRUST_PROXY) app.set("trust proxy", 1);

app.use(express.json());

app.use(
  session({
    name: "k8s-topology.sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: COOKIE_SECURE,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  }),
);

passport.serializeUser((user, done) => {
  if (!user?.id) return done(null, false);
  return done(null, user.id);
});
passport.deserializeUser((id, done) => {
  if (!db) return done(null, false);
  try {
    const row = findUserById(db, id);
    if (!row) return done(null, false);
    return done(null, { id: String(row.id), username: row.username });
  } catch (e) {
    return done(e);
  }
});

if (db) {
  passport.use(
    new LocalStrategy({ usernameField: "username", passwordField: "password" }, (username, password, done) => {
      try {
        const row = findUserByUsername(db, username);
        if (!row || !bcrypt.compareSync(password, row.password_hash)) {
          return done(null, false, { message: "Kullanıcı adı veya parola hatalı" });
        }
        return done(null, { id: String(row.id), username: row.username });
      } catch (e) {
        return done(e);
      }
    }),
  );
}

app.use(passport.initialize());
app.use(passport.session());

app.get("/api/auth/me", (req, res) => {
  res.json(authMePayload(req));
});

app.post("/api/auth/signup", (req, res, next) => {
  if (AUTH_DISABLED || !db) return res.status(400).json({ message: "Kayıt kapalı" });
  const pol = signupPolicy();
  if (!pol.allowSignup) return res.status(403).json({ message: "Yeni kayıt kapalı" });

  const username = String(req.body?.username || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const confirm = String(req.body?.confirmPassword ?? req.body?.password_confirm ?? "");

  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ message: "Kullanıcı adı 3–32 karakter; küçük harf, rakam ve _" });
  }
  if (password.length < 8) return res.status(400).json({ message: "Parola en az 8 karakter olmalı" });
  if (password !== confirm) return res.status(400).json({ message: "Parolalar eşleşmiyor" });

  try {
    const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
    const user = insertUser(db, username, hash);
    req.login(user, err => {
      if (err) return next(err);
      return res.json({ ok: true, username: user.username });
    });
  } catch (e) {
    const code = e && (e.code || e.cause?.code);
    if (code === "SQLITE_CONSTRAINT_UNIQUE" || String(e?.message || "").includes("UNIQUE")) {
      return res.status(409).json({ message: "Bu kullanıcı adı alınmış" });
    }
    return next(e);
  }
});

app.post("/api/auth/login", (req, res, next) => {
  if (AUTH_DISABLED || !db) return res.status(400).json({ message: "Kimlik doğrulama kapalı" });
  passport.authenticate("local", (err, user, info) => {
    if (err) return next(err);
    if (!user) return res.status(401).json({ message: info?.message || "Yetkisiz" });
    req.logIn(user, e => {
      if (e) return next(e);
      return res.json({ ok: true });
    });
  })(req, res, next);
});

app.post("/api/auth/logout", (req, res, next) => {
  req.logout(err => {
    if (err) return next(err);
    if (!req.session) return res.json({ ok: true });
    req.session.destroy(e2 => {
      if (e2) return next(e2);
      res.clearCookie("k8s-topology.sid", { path: "/" });
      res.json({ ok: true });
    });
  });
});

app.use(
  "/k8s-api",
  createProxyMiddleware({
    target: K8S_PROXY_TARGET,
    changeOrigin: true,
    pathRewrite: { "^/k8s-api": "" },
    ws: true,
  }),
);

app.use(
  "/prometheus",
  createProxyMiddleware({
    target: PROMETHEUS_TARGET,
    changeOrigin: true,
    pathRewrite: { "^/prometheus": "" },
  }),
);

if (STATIC_DIR) {
  const abs = path.isAbsolute(STATIC_DIR) ? STATIC_DIR : path.join(rootDir, STATIC_DIR);
  app.use(express.static(abs));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/") || req.path.startsWith("/k8s-api") || req.path.startsWith("/prometheus")) {
      return next();
    }
    res.sendFile(path.join(abs, "index.html"), err => (err ? next(err) : undefined));
  });
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ message: err.message || "Sunucu hatası" });
});

app.listen(PORT, () => {
  console.log(`[k8s-topology] http://127.0.0.1:${PORT}${STATIC_DIR ? " (static + proxy)" : " (API + proxy only)"}`);
  if (AUTH_DISABLED) console.log("[k8s-topology] AUTH_DISABLED=1 (giriş yok)");
  else console.log(`[k8s-topology] SQLite auth: ${SQLITE_PATH}`);
});
