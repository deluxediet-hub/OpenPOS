'use strict';
// ---------------------------------------------------------------------------
// auth.js — PIN auth (scrypt), DB-backed sessions, login rate limit + lockout
// ---------------------------------------------------------------------------
const crypto = require('crypto');

const SESSION_HOURS = 12;
const MAX_FAILS = 5; // per (staff name) and per IP
const LOCK_MS = 5 * 60 * 1000;

function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 32).toString('hex');
}

function verifyPin(pin, salt, expectedHash) {
  const h = hashPin(pin, salt);
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(expectedHash, 'hex'));
}

// ---- lockout bookkeeping (survives restarts) --------------------------------
function lockKey(kind, id) {
  return `${kind}:${String(id).toLowerCase()}`;
}

function isLocked(db, kind, id) {
  const row = db.prepare('SELECT * FROM login_locks WHERE key = ?').get(lockKey(kind, id));
  if (!row) return null;
  if (row.locked_until > 0) {
    if (row.locked_until > Date.now()) return row.locked_until - Date.now();
    // lock expired — clear it and the stale count
    db.prepare('DELETE FROM login_locks WHERE key = ?').run(lockKey(kind, id));
  }
  return null; // plain failure count, not locked
}

function recordFail(db, kind, id) {
  const key = lockKey(kind, id);
  const row = db.prepare('SELECT * FROM login_locks WHERE key = ?').get(key);
  const fails = (row ? row.fails : 0) + 1;
  const locked_until = fails >= MAX_FAILS ? Date.now() + LOCK_MS : 0;
  db.prepare(
    `INSERT INTO login_locks (key, fails, locked_until) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET fails = ?, locked_until = ?`
  ).run(key, fails, locked_until, fails, locked_until);
  return { fails, locked: locked_until > 0 };
}

function clearFails(db, kind, id) {
  db.prepare('DELETE FROM login_locks WHERE key = ?').run(lockKey(kind, id));
}

// ---- sessions (DB-backed so restarts don't log staff out mid-shift) --------
function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare(
    'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(token, userId, new Date(now).toISOString(), new Date(now + SESSION_HOURS * 3600e3).toISOString());
  return token;
}

function userFromToken(db, token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.name, u.role, u.branch_id, u.location_id, u.register_id, u.active, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token = ?`
    )
    .get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  if (!row.active) return null;
  return {
    id: row.id, name: row.name, role: row.role,
    branchId: row.branch_id, locationId: row.location_id, registerId: row.register_id
  };
}

function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function pruneSessions(db) {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
}

// ---- http helpers -----------------------------------------------------------
function clientIp(req) {
  const f = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return f || req.socket.remoteAddress || 'unknown';
}

function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx > -1 && part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

function sessionCookie(token, maxAgeMs) {
  return `openpos_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(maxAgeMs / 1000)}`;
}

function sessionPath(db) {
  return (req, res, next) => {
    const user = userFromToken(db, getCookie(req, 'openpos_session'));
    if (!user) return res.status(401).json({ error: 'unauthenticated' });
    req.user = user;
    next();
  };
}

function requireRole(db, ...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  };
}

module.exports = {
  SESSION_HOURS, MAX_FAILS, LOCK_MS,
  hashPin, verifyPin, isLocked, recordFail, clearFails,
  createSession, userFromToken, destroySession, pruneSessions,
  clientIp, getCookie, sessionCookie, sessionPath, requireRole
};
