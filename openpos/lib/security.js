'use strict';
// ---------------------------------------------------------------------------
// security.js — evidence, sessions and the locks (Phase 28).
//
// The rule this file exists to enforce: **anything financially important
// leaves a trail**. Not "is logged somewhere" — reconciled. `trailCheck` does
// not ask whether we remember writing an audit row; it counts the things that
// actually happened in the window (voids, adjustments, refunds, discounts,
// staff changes…) and checks each one has an audit row to answer for it.
// ---------------------------------------------------------------------------

const crypto = require('crypto');

const DEFAULTS = {
  // lock_by_ip: every till in a Kenyan shop often shares ONE public address,
  // so locking by IP can lock out the whole shop for one person's mistake.
  // It is on by default and is the owner's to switch off.
  lockout: { max_fails: 5, lock_minutes: 5, lock_by_ip: true },
  session_hours: 12,
  secure_cookies: false,       // on when the shop fronts the till with HTTPS
  https: { enabled: false, cert: '', key: '', port: 443 },
  backup: { encrypt: false, passphrase_set: false },
  require_reason_on_adjust: true,
  branch_scope_enforced: true
};

function settings(d, dbm) {
  const cur = (dbm.getSetting(d, 'security', null) || {});
  return {
    ...DEFAULTS,
    ...cur,
    lockout: { ...DEFAULTS.lockout, ...(cur.lockout || {}) },
    https: { ...DEFAULTS.https, ...(cur.https || {}) },
    backup: { ...DEFAULTS.backup, ...(cur.backup || {}) }
  };
}

function saveSettings(d, dbm, patch) {
  const cur = settings(d, dbm);
  const next = {
    ...cur,
    ...patch,
    lockout: { ...cur.lockout, ...(patch.lockout || {}) },
    https: { ...cur.https, ...(patch.https || {}) },
    backup: { ...cur.backup, ...(patch.backup || {}) }
  };
  dbm.setSetting(d, 'security', next);
  return next;
}

// ---- login history ---------------------------------------------------------

function recordLogin(d, { userId = null, name = '', ok, reason = '', ip = '', agent = '' }) {
  const id = d
    .prepare('INSERT INTO login_events (user_id, name, ok, reason, ip, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(userId, String(name || '').slice(0, 80), ok ? 1 : 0, String(reason || '').slice(0, 120), String(ip || '').slice(0, 60), String(agent || '').slice(0, 200), new Date().toISOString())
    .lastInsertRowid;
  return id;
}

function loginEvents(d, { limit = 100, ok = null, userId = null, since = null } = {}) {
  const where = [];
  const args = [];
  if (ok !== null) { where.push('ok = ?'); args.push(ok ? 1 : 0); }
  if (userId) { where.push('user_id = ?'); args.push(userId); }
  if (since) { where.push('created_at >= ?'); args.push(since); }
  return d
    .prepare(`SELECT * FROM login_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`)
    .all(...args, Math.min(Number(limit) || 100, 1000));
}

function failedLogins(d, { since = null } = {}) {
  return loginEvents(d, { limit: 200, ok: false, since });
}

/** The names being hammered right now — a shop should be able to see them. */
function lockState(d) {
  const rows = d.prepare('SELECT * FROM login_locks ORDER BY locked_until DESC').all();
  const now = Date.now();
  return rows.map((r) => ({
    key: r.key,
    kind: String(r.key).split(':')[0] || 'key',
    who: String(r.key).split(':').slice(1).join(':'),
    fails: r.fails,
    locked_for_ms: r.locked_until > now ? r.locked_until - now : 0
  }));
}

// ---- the trail -------------------------------------------------------------

/**
 * Financially important actions, grouped. `source` reconciles against the
 * tables themselves where one exists; `patterns` covers the rest by name.
 */
const CLASSES = [
  { id: 'sales', label: 'Sales taken', patterns: ['^sale/(create|pay|confirm)'] },
  { id: 'price_override', label: 'Price overrides', patterns: ['^sale/price', '^sale/override'] },
  { id: 'discount', label: 'Discounts & offers', patterns: ['^sale/discount', '^promo', '^coupon'] },
  { id: 'refund', label: 'Refunds & returns', patterns: ['^return/', '^sale/refund', '^payment/refund'] },
  { id: 'void', label: 'Voids & deletions', patterns: ['^sale/void', '^product/delete', '^customer/delete', '^user/delete'] },
  { id: 'stock', label: 'Stock adjustments', patterns: ['^stock/(adjust|count|move)'] },
  { id: 'cash', label: 'Cash: shifts, drops, payouts', patterns: ['^shift/', '^petty/', '^expense/', '^cash/'] },
  { id: 'credit', label: 'Customer credit (deni)', patterns: ['^credit/', '^deni/'] },
  { id: 'payments', label: 'Payments & M-Pesa', patterns: ['^payment/'] },
  { id: 'staff', label: 'Staff, roles & permissions', patterns: ['^staff/', '^user/', '^role/'] },
  { id: 'settings', label: 'Settings & tax config', patterns: ['^settings/'] },
  { id: 'modules', label: 'Industry modules & capabilities', patterns: ['^module/', '^capab'] },
  { id: 'devices', label: 'Devices & printing', patterns: ['^devices/'] },
  { id: 'orders', label: 'Orders from other doors', patterns: ['^order/', '^store/', '^message/'] },
  { id: 'auth', label: 'Sign-ins & lockouts', patterns: ['^auth/'] }
];

/**
 * RECONCILIATIONS: count what really happened, then look for its evidence.
 * A scenario fails when the books say it happened and the audit says nothing.
 */
const RECONCILIATIONS = [
  { id: 'sale_voided', label: 'a sale was voided', cls: 'void',
    expected: (d, w) => d.prepare(`SELECT COUNT(*) AS n FROM sales WHERE status = 'voided' AND ts >= ? AND ts <= ?`).get(w.from, w.to).n,
    patterns: ['^sale/void'] },
  { id: 'stock_adjusted', label: 'stock was adjusted by hand', cls: 'stock',
    expected: (d, w) => d.prepare(`SELECT COUNT(*) AS n FROM stock_moves WHERE type = 'adjust' AND ts >= ? AND ts <= ?`).get(w.from, w.to).n,
    patterns: ['^stock/adjust'] },
  { id: 'payment_refunded', label: 'money was handed back', cls: 'refund',
    expected: (d, w) => d.prepare(`SELECT COUNT(*) AS n FROM payments WHERE refunded > 0 AND updated_at >= ? AND updated_at <= ?`).get(w.from, w.to).n,
    patterns: ['^payment/refund', '^sale/return', '^return/'] },
  { id: 'discount_given', label: 'a sale was discounted', cls: 'discount',
    expected: (d, w) => d.prepare(`SELECT COUNT(*) AS n FROM sales WHERE discount > 0 AND ts >= ? AND ts <= ?`).get(w.from, w.to).n,
    patterns: ['^sale/create', '^sale/discount'] },
  { id: 'credit_sold', label: 'goods left on credit (deni)', cls: 'credit',
    expected: (d, w) => d.prepare(`SELECT COUNT(*) AS n FROM customer_ledger WHERE type = 'credit_sale' AND ts >= ? AND ts <= ?`).get(w.from, w.to).n,
    patterns: ['^credit/', '^deni/'] },
  { id: 'staff_changed', label: 'a staff member was added or changed', cls: 'staff',
    expected: (d, w) => d.prepare(`SELECT COUNT(*) AS n FROM users WHERE ts >= ? AND ts <= ?`).get(w.from, w.to).n,
    patterns: ['^staff/', '^user/'] },
  { id: 'shift_closed', label: 'a shift was closed', cls: 'cash',
    expected: (d, w) => d.prepare(`SELECT COUNT(*) AS n FROM shifts WHERE closed_at IS NOT NULL AND closed_at >= ? AND closed_at <= ?`).get(w.from, w.to).n,
    patterns: ['^shift/close'] },
  { id: 'settings_changed', label: 'a setting was changed', cls: 'settings',
    expected: (d, w) => d.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'settings/%' AND ts >= ? AND ts <= ?`).get(w.from, w.to).n,
    patterns: ['^settings/'] },
  { id: 'module_toggled', label: 'an industry module was switched on or off', cls: 'modules',
    expected: (d, w) => d.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'module/%' AND ts >= ? AND ts <= ?`).get(w.from, w.to).n,
    patterns: ['^module/'] },
  { id: 'order_inbound', label: 'an order arrived by message or web', cls: 'orders',
    expected: (d, w) => d.prepare(`SELECT COUNT(*) AS n FROM sales WHERE channel IN ('web','whatsapp') AND ts >= ? AND ts <= ?`).get(w.from, w.to).n,
    patterns: ['^order/', '^store/'] }
];

/**
 * Matching happens here, not in SQL: node:sqlite ships no REGEXP, and an
 * audit query whose WHERE clause silently matches nothing is worse than one
 * that is obviously ours.
 */
function auditRowsIn(d, w) {
  return d.prepare('SELECT action, ts, user_id FROM audit_log WHERE ts >= ? AND ts <= ?').all(w.from, w.to);
}

function auditCount(rows, patterns) {
  const re = patterns.map((p) => new RegExp(p));
  let n = 0;
  for (const r of rows) if (re.some((x) => x.test(r.action || ''))) n++;
  return n;
}

/**
 * The 50-scenario question: name everything that would matter to an owner,
 * then say which of those have evidence in this window.
 */
function trailCheck(d, { from = null, to = null } = {}) {
  const to0 = to || new Date().toISOString();
  const from0 = from || new Date(Date.now() - 30 * 864e5).toISOString();
  const w = { from: from0, to: to0 };

  const rows = auditRowsIn(d, w);
  const classes = CLASSES.map((c) => {
    const re = c.patterns.map((p) => new RegExp(p));
    const hits = rows.filter((r) => re.some((x) => x.test(r.action || '')));
    return {
      ...c, events: hits.length,
      last_at: hits.length ? hits[hits.length - 1].ts : null
    };
  });

  const checks = RECONCILIATIONS.map((r) => {
    let expected = 0;
    try { expected = Number(r.expected(d, w) || 0); } catch (_) { expected = 0; }
    const trailed = auditCount(rows, r.patterns);
    return {
      id: r.id, label: r.label, cls: r.cls,
      expected, trailed,
      ok: trailed >= expected,
      gap: Math.max(0, expected - trailed)
    };
  });

  const anon = rows.filter((r) => !r.user_id).length;
  const financial = classes.filter((c) => ['void', 'refund', 'stock', 'cash', 'credit', 'discount', 'price_override', 'staff', 'settings'].includes(c.id));

  return {
    window: { from: w.from, to: w.to },
    classes,
    checks,
    untrailed: checks.filter((c) => !c.ok),
    anonymous_rows: anon,
    financial_classes_trailed: financial.filter((c) => c.events > 0).length,
    financial_classes_total: financial.length,
    ok: checks.every((c) => c.ok)
  };
}

// ---- sessions --------------------------------------------------------------

function sessions(d, { userId = null } = {}) {
  const rows = userId
    ? d.prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at DESC').all(userId)
    : d.prepare('SELECT * FROM sessions ORDER BY created_at DESC').all();
  const users = Object.fromEntries(d.prepare('SELECT id, name, role FROM users').all().map((u) => [u.id, u]));
  const now = Date.now();
  return rows.map((s) => ({
    token_hint: String(s.token).slice(0, 6) + '…',
    user_id: s.user_id,
    user: (users[s.user_id] || {}).name || `#${s.user_id}`,
    role: (users[s.user_id] || {}).role || '',
    created_at: s.created_at,
    expires_at: s.expires_at,
    expired: new Date(s.expires_at).getTime() < now
  }));
}

function revokeSession(d, tokenPrefix) {
  const rows = d.prepare('SELECT token FROM sessions').all();
  const hit = rows.filter((r) => String(r.token).startsWith(String(tokenPrefix)));
  for (const r of hit) d.prepare('DELETE FROM sessions WHERE token = ?').run(r.token);
  return hit.length;
}

// ---- permission re-audit ---------------------------------------------------

/**
 * Who can do what, and where that came from. A shop owner should be able to
 * see every hand on the till and every permission it holds.
 */
function permissionAudit(d, permissionList) {
  const users = d.prepare('SELECT * FROM users ORDER BY id').all();
  const table = d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_permissions'").get();
  const rows = table ? d.prepare('SELECT * FROM user_permissions').all() : [];
  const overrides = {};
  for (const p of rows) (overrides[p.user_id] = overrides[p.user_id] || []).push(p.permission || p.perm || '');
  return users.map((u) => ({
    id: u.id, name: u.name, role: u.role, active: !!u.active,
    last_login_at: u.last_login_at || null,
    branch_id: u.branch_id || null,
    overrides: overrides[u.id] || []
  }));
}

// ---- backup encryption -----------------------------------------------------

/** AES-256-GCM. A backup on a borrowed laptop should be useless to a thief. */
function encrypt(bytes, passphrase) {
  if (!passphrase) return Buffer.from(bytes);
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(passphrase), salt, 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(Buffer.from(bytes)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from('OPBK1'), salt, iv, tag, body]);
}

function decrypt(buf, passphrase) {
  const b = Buffer.from(buf);
  if (b.slice(0, 5).toString() !== 'OPBK1') return b;
  if (!passphrase) throw new Error('this backup is encrypted — the passphrase is needed');
  const salt = b.slice(5, 21);
  const iv = b.slice(21, 33);
  const tag = b.slice(33, 49);
  const body = b.slice(49);
  const key = crypto.scryptSync(String(passphrase), salt, 32);
  try {
    const dec = crypto.createDecipheriv('aes-256-gcm', key, iv);
    dec.setAuthTag(tag);
    return Buffer.concat([dec.update(body), dec.final()]);
  } catch (_) {
    throw new Error('wrong passphrase — this backup cannot be opened');
  }
}

module.exports = {
  DEFAULTS, settings, saveSettings,
  recordLogin, loginEvents, failedLogins, lockState,
  CLASSES, RECONCILIATIONS, trailCheck,
  sessions, revokeSession, permissionAudit,
  encrypt, decrypt
};
