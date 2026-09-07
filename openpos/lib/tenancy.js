'use strict';
// ---------------------------------------------------------------------------
// tenancy.js — one shop, one book (Phase 33).
//
// The plan says "tenant isolation live (business_id)". This takes the stronger
// road, and says so: every business gets its OWN DATABASE FILE. Row-level
// isolation can be defeated by one forgotten WHERE clause — and a shop that
// finds another shop's customers in its till will never trust the product
// again. A file boundary cannot be leaked by a missing predicate, and it is
// also the thing that lets a shop own its data: their book is a file they can
// hold, back up and take elsewhere.
//
// Each business runs as its own server process (one till, one book). This file
// is the registry of books, and the door that makes a new one.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const dbm = require('../db');

const DEFAULT_LIMITS = { products: 500, users: 3, branches: 1, locations: 2, registers: 2 };

function dataDir() {
  return process.env.OPENPOS_DATA_DIR || path.dirname(dbm.DB_PATH);
}

function rootDir() {
  const dir = path.join(dataDir(), 'businesses');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function registryPath() {
  return path.join(rootDir(), 'registry.json');
}

function slugOf(name) {
  return String(name || 'shop').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'shop';
}

function readRegistry() {
  const p = registryPath();
  if (!fs.existsSync(p)) return [];
  try {
    const rows = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(rows) ? rows : [];
  } catch (_) {
    // A registry that cannot be read must not be silently overwritten.
    const backup = `${p}.corrupt-${Date.now()}`;
    fs.copyFileSync(p, backup);
    return [];
  }
}

function writeRegistry(rows) {
  const p = registryPath();
  const tmp = `${p}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2));
  fs.renameSync(tmp, p);
  return rows;
}

function list() {
  return readRegistry().map((b) => ({
    ...b,
    db_exists: !!b.db_path && fs.existsSync(b.db_path),
    db_bytes: b.db_path && fs.existsSync(b.db_path) ? fs.statSync(b.db_path).size : 0
  }));
}

function get(id) {
  return list().find((b) => b.id === String(id) || b.slug === String(id)) || null;
}

/**
 * Self-serve registration. The new book is created by running the REAL setup
 * end-to-end against a temporary server on a random port — not by copying a
 * template and hoping the shapes match. Whatever a shop gets on day one from
 * the till, a business created here gets the same way.
 */
async function create({ name, trade = 'duka', owner = {}, sample = false, plan = 'solo' }, createApp) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('the business needs a name');
  if (!String(owner.name || '').trim()) throw new Error('the business needs an owner');
  if (!/^\d{4,8}$/.test(String(owner.pin || ''))) throw new Error('the owner needs a 4-8 digit PIN');

  const rows = readRegistry();
  let slug = slugOf(clean);
  let n = 1;
  while (rows.some((r) => r.slug === slug)) slug = `${slugOf(clean)}-${++n}`;

  const dir = path.join(rootDir(), slug);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'openpos.db');

  // The setup route refuses an initialised book; make sure this one is new.
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  const d = dbm.openPath(dbPath);
  let server = null;
  try {
    const app = createApp(d);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ business: { name: clean, trade }, owner, sample })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `setup failed (${res.status})`);
  } finally {
    if (server) await new Promise((r) => server.close(r));
    try { d.close(); } catch (_) {}
  }

  const now = new Date();
  const free = require('./plans').planOf(plan).price_month === 0;
  const row = {
    id: slug,
    slug,
    name: clean,
    trade,
    db_path: dbPath,
    dir,
    plan,
    status: free ? 'active' : 'trial',
    trial_ends_at: free ? null : new Date(now.getTime() + 30 * 864e5).toISOString(),
    paid_until: null,
    limits: { ...require('./plans').planOf(plan).limits },
    created_at: now.toISOString(),
    updated_at: now.toISOString()
  };
  rows.push(row);
  writeRegistry(rows);
  return row;
}

/** What a business looks like right now — without keeping its book open. */
function inspect(biz) {
  const b = typeof biz === 'string' ? get(biz) : biz;
  if (!b || !fs.existsSync(b.db_path)) return { ...b, open: false };
  const d = dbm.openPath(b.db_path, { migrate: false });
  try {
    const count = (sql) => { try { return d.prepare(sql).get().n; } catch (_) { return 0; } };
    return {
      ...b,
      open: true,
      schema: dbm.schemaInfo(d).version,
      sales: count('SELECT COUNT(*) AS n FROM sales'),
      products: count('SELECT COUNT(*) AS n FROM products'),
      customers: count('SELECT COUNT(*) AS n FROM customers'),
      users: count('SELECT COUNT(*) AS n FROM users'),
      branches: count('SELECT COUNT(*) AS n FROM branches'),
      business_name: (dbm.getSetting(d, 'business', {}) || {}).name || null
    };
  } finally {
    try { d.close(); } catch (_) {}
  }
}

function update(id, patch) {
  const rows = readRegistry();
  const i = rows.findIndex((b) => b.id === String(id) || b.slug === String(id));
  if (i < 0) throw new Error('no such business');
  rows[i] = { ...rows[i], ...patch, updated_at: new Date().toISOString() };
  writeRegistry(rows);
  return rows[i];
}

/**
 * Isolation, stated as a fact rather than a promise: two books are two files,
 * and a row written into one is provably absent from the other.
 */
function isolationCheck(ids) {
  const out = [];
  for (const id of ids) {
    const b = get(id);
    if (!b) continue;
    const d = dbm.openPath(b.db_path, { migrate: false });
    try {
      const marker = `ISO-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const c = d.prepare('INSERT INTO customers (name, phone, created_at) VALUES (?, ?, ?)').run(marker, '0700000000', new Date().toISOString());
      out.push({ business: b.id, file: b.db_path, marker, customer_id: Number(c.lastInsertRowid) });
    } finally {
      try { d.close(); } catch (_) {}
    }
  }
  // Now: does any OTHER book contain someone else's marker?
  const leaks = [];
  for (const a of out) {
    for (const b of out) {
      if (a.business === b.business) continue;
      const d = dbm.openPath(get(b.business).db_path, { migrate: false });
      try {
        const found = d.prepare('SELECT COUNT(*) AS n FROM customers WHERE name = ?').get(a.marker).n;
        if (found) leaks.push({ from: a.business, into: b.business, marker: a.marker });
      } finally { try { d.close(); } catch (_) {} }
    }
    // and each business still has its own marker
    const d = dbm.openPath(get(a.business).db_path, { migrate: false });
    try {
      const mine = d.prepare('SELECT COUNT(*) AS n FROM customers WHERE name = ?').get(a.marker).n;
      if (!mine) leaks.push({ from: a.business, into: a.business, note: 'own marker missing' });
      d.prepare('DELETE FROM customers WHERE name = ?').run(a.marker);
    } finally { try { d.close(); } catch (_) {} }
  }
  return {
    businesses: out.map((o) => o.business),
    files: out.map((o) => o.file),
    leaks,
    isolated: leaks.length === 0,
    sentence: leaks.length
      ? `${leaks.length} leak(s) found — isolation is broken`
      : `${out.length} businesses, ${out.length} separate books, zero data crossing.`
  };
}

module.exports = { list, get, create, inspect, update, isolationCheck, dataDir, rootDir, DEFAULT_LIMITS };
