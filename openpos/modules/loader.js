'use strict';
// ---------------------------------------------------------------------------
// loader.js — the industry module framework (Phase 18, ARCHITECTURE.md §4).
//
// The core never knows it is a pharmacy or a wine shop. A module is a plain
// object that declares contributions; the loader activates modules for a
// business's trade and the core reaches them through ONE generic door:
//
//   productFields           extra product/variant attributes (attribute_defs)
//   checkout.validateLine   block or annotate a cart line      [gate]
//   checkout.beforeCommit   last look before a sale commits     [gate]
//   stock.rule              block a stock move                  [gate]
//   reports                 definitions the core renders generically
//   permissions             extra grantable permissions + role defaults
//   ui                      browser panels the shell mounts by name
//   template                sample data for onboarding
//
// Rules (R-M):
//   R-M1 a module never touches the payment engine, the ledger core or audit.
//   R-M2 behaviour comes from product/variant flags + module config — a module
//        is configuration and hooks, never a fork.
//   R-M3 a new industry = a new file in this directory. No core edits.
//
// Gate hooks fail CLOSED (a broken module blocks rather than silently lets a
// rule through) but the failure is reported as the module's, never the core's.
// Collect hooks fail OPEN (a broken module is skipped, the core keeps working).
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const MODULE_DIR = __dirname;

// hook name -> 'gate' | 'collect'
const HOOKS = {
  productFields: 'collect',
  'checkout.validateLine': 'gate',
  'checkout.beforeCommit': 'gate',
  'stock.rule': 'gate',
  reports: 'collect',
  commands: 'collect',
  permissions: 'collect',
  ui: 'collect',
  template: 'collect',
  // Phase 34: what a trade's receipt must say that no other trade's does.
  receipt: 'collect'
};

const HOOK_NAMES = Object.keys(HOOKS);

/** An error a module throws to block an operation with a business-readable message. */
function block(status, message, extra) {
  const e = new Error(message);
  e.status = Number(status) || 400;
  e.moduleError = true;
  if (extra) Object.assign(e, extra);
  return e;
}

// ---- registration -----------------------------------------------------------

let registered = [];   // [{ def, file }]
let stamp = 0;         // bumped whenever the module set changes (cache invalidation)

function reset() {
  registered = [];
  stamp++;
}

/**
 * Validate and register one module definition (or an array of them).
 * A module must declare at least an id and one hook contribution.
 */
function register(def, file) {
  const list = Array.isArray(def) ? def : [def];
  const out = [];
  for (const raw of list) {
    const m = normalize(raw, file);
    const at = registered.findIndex((r) => r.def.id === m.id);
    if (at >= 0) registered[at] = { def: m, file: file || null };
    else registered.push({ def: m, file: file || null });
    out.push(m);
  }
  stamp++;
  return out;
}

function normalize(raw, file) {
  if (!raw || typeof raw !== 'object') throw new Error('module must be an object');
  const id = String(raw.id || '').trim();
  if (!/^[a-z][a-z0-9_]{1,30}$/.test(id)) {
    throw new Error(`module id must be lowercase [a-z0-9_], 2-31 chars: "${id}"`);
  }
  const trades = Array.isArray(raw.trades) && raw.trades.length ? raw.trades.map(String) : ['*'];
  const provides = HOOK_NAMES.filter((h) => {
    if (h === 'checkout.validateLine' || h === 'checkout.beforeCommit') return raw.checkout && typeof raw.checkout[h.split('.')[1]] === 'function';
    if (h === 'stock.rule') return raw.stock && typeof raw.stock.rule === 'function';
    const v = raw[h === 'productFields' ? 'productFields' : h];
    return Array.isArray(v) ? v.length > 0 : (h === 'template' ? !!v : false);
  });
  if (!provides.length) throw new Error(`module "${id}" declares no hooks`);

  const m = {
    id,
    name: String(raw.name || id),
    nameSw: String(raw.nameSw || raw.name || id),
    description: String(raw.description || ''),
    descriptionSw: String(raw.descriptionSw || raw.description || ''),
    version: Number(raw.version) || 1,
    trades,
    trade: raw.trade || null,                       // the trade this module introduces (if any)
    capabilities: Array.isArray(raw.capabilities) ? raw.capabilities : [],
    schema: typeof raw.schema === 'string' && raw.schema.trim() ? raw.schema : null,
    // Additive columns on existing tables: [{ table, column, def }]. A module may
    // only ADD (never drop, retype or rewrite) — enforced by addColIfMissing.
    columns: Array.isArray(raw.columns) ? raw.columns.map((c) => ({
      table: String(c.table || ''),
      column: String(c.column || ''),
      def: String(c.def || 'TEXT')
    })).filter((c) => /^[a-z_][a-z0-9_]*$/i.test(c.table) && /^[a-z_][a-z0-9_]*$/i.test(c.column)) : [],
    permissions: Array.isArray(raw.permissions) ? raw.permissions.map((p) => ({
      perm: String(p.perm || ''),
      label: String(p.label || p.perm || ''),
      labelSw: String(p.labelSw || p.label || p.perm || ''),
      roles: Array.isArray(p.roles) ? p.roles : []
    })).filter((p) => p.perm) : [],
    productFields: Array.isArray(raw.productFields) ? raw.productFields.map((f) => ({
      key: String(f.key || ''),
      label: String(f.label || f.key || ''),
      labelSw: String(f.labelSw || f.label || f.key || ''),
      type: ['text', 'number', 'select', 'boolean'].includes(f.type) ? f.type : 'text',
      options: String(f.options || ''),
      appliesTo: f.appliesTo === 'product' ? 'product' : 'variant'
    })).filter((f) => f.key) : [],
    commands: Array.isArray(raw.commands) ? raw.commands.map((c) => ({
      id: String(c.id || ''),
      title: String(c.title || c.id || ''),
      titleSw: String(c.titleSw || c.title || c.id || ''),
      perm: String(c.perm || 'products.manage'),
      params: Array.isArray(c.params) ? c.params.map((p) => ({
        name: String(p.name || ''),
        label: String(p.label || p.name || ''),
        type: ['text', 'number', 'date', 'select', 'boolean'].includes(p.type) ? p.type : 'text',
        required: !!p.required
      })).filter((p) => p.name) : [],
      run: typeof c.run === 'function' ? c.run : null
    })).filter((c) => c.id && c.run) : [],
    reports: Array.isArray(raw.reports) ? raw.reports.map((r) => ({
      id: String(r.id || ''),
      title: String(r.title || r.id || ''),
      titleSw: String(r.titleSw || r.title || r.id || ''),
      perm: String(r.perm || 'reports.view'),
      columns: Array.isArray(r.columns) ? r.columns : [],
      run: typeof r.run === 'function' ? r.run : null
    })).filter((r) => r.id && r.run) : [],
    ui: Array.isArray(raw.ui) ? raw.ui.map((u) => ({
      id: String(u.id || ''),
      mount: String(u.mount || 'manager'),
      script: String(u.script || ''),
      label: String(u.label || ''),
      labelSw: String(u.labelSw || u.label || ''),
      i18n: u.i18n && typeof u.i18n === 'object' ? u.i18n : {}
    })).filter((u) => u.id && u.script) : [],
    template: raw.template && typeof raw.template === 'object' ? raw.template : null,
    checkout: {
      validateLine: (raw.checkout && typeof raw.checkout.validateLine === 'function') ? raw.checkout.validateLine : null,
      beforeCommit: (raw.checkout && typeof raw.checkout.beforeCommit === 'function') ? raw.checkout.beforeCommit : null
    },
    stock: { rule: (raw.stock && typeof raw.stock.rule === 'function') ? raw.stock.rule : null },
    // Phase 34: lines this trade's receipt must carry ({ en, sw }). Data only —
    // the module owns its own wording; the core just prints what it is given.
    receipt: Array.isArray(raw.receipt) ? raw.receipt.map((r) => ({
      en: String(r.en || '').trim(), sw: String(r.sw || r.en || '').trim()
    })).filter((r) => r.en) : [],
    activate: typeof raw.activate === 'function' ? raw.activate : null,
    file: file || null
  };
  return m;
}

/** Load every module file in a directory (default: this one). loader.js is skipped. */
function discover(dir) {
  const base = dir || MODULE_DIR;
  let files = [];
  try {
    // _kit.js and friends are shared helpers, not modules.
    files = fs.readdirSync(base).filter((f) => f.endsWith('.js') && f !== 'loader.js' && !f.startsWith('_'));
  } catch (_) {
    return [];
  }
  const found = [];
  for (const f of files.sort()) {
    const full = path.join(base, f);
    try {
      found.push(...register(require(full), full));
    } catch (e) {
      console.error(`[modules] ${f} failed to load: ${e.message}`);
    }
  }
  return found;
}

function all() {
  return registered.map((r) => r.def);
}

function get(id) {
  const r = registered.find((x) => x.def.id === id);
  return r ? r.def : null;
}

function provides(id) {
  const m = get(id);
  if (!m) return [];
  return HOOK_NAMES.filter((h) => {
    if (h.startsWith('checkout.')) return !!m.checkout[h.split('.')[1]];
    if (h === 'stock.rule') return !!m.stock.rule;
    if (h === 'template') return !!m.template;
    return (m[h] || []).length > 0;
  });
}

function forTrade(trade) {
  return all().filter((m) => m.trades.includes('*') || m.trades.includes(String(trade || '')));
}

// ---- activation (data, not deployment — R-C3) -------------------------------

function ensureTable(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS modules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER NOT NULL DEFAULT 1,
      module_id TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1,
      config TEXT NOT NULL DEFAULT '{}',
      activated_at TEXT,
      activated_by INTEGER,
      deactivated_at TEXT,
      UNIQUE(business_id, module_id)
    );
  `);
}

function rowOf(d, id) {
  ensureTable(d);
  return d.prepare('SELECT * FROM modules WHERE business_id = 1 AND module_id = ?').get(id) || null;
}

const tableReady = new WeakSet();

function activeIds(d) {
  if (!registered.length) return [];
  if (!tableReady.has(d)) { ensureTable(d); tableReady.add(d); }
  return d.prepare('SELECT module_id FROM modules WHERE business_id = 1 AND active = 1').all().map((r) => r.module_id);
}

function isActive(d, id) {
  const r = rowOf(d, id);
  return !!(r && r.active);
}

/** True when no module at all is registered — the core's fast path. */
function isEmpty() {
  return registered.length === 0;
}

/**
 * Activate a module: run its schema + activate(db) once, record it, audit it.
 * Idempotent — activating twice is a no-op (the row is upserted, the schema is
 * CREATE TABLE IF NOT EXISTS).
 */
function activate(d, id, { userId = null, config = null, audit } = {}) {
  const m = get(id);
  if (!m) throw block(404, `unknown module: ${id}`);
  ensureTable(d);
  const existing = rowOf(d, id);
  const run = () => {
    // Columns first: a module's schema may index a column it added.
    for (const c of m.columns) addColIfMissing(d, c.table, c.column, c.def);
    if (m.schema) d.exec(m.schema);
    if (m.activate) m.activate(d, { userId });
    const now = new Date().toISOString();
    d.prepare(`
      INSERT INTO modules (business_id, module_id, version, active, config, activated_at, activated_by, deactivated_at)
      VALUES (1, ?, ?, 1, ?, ?, ?, NULL)
      ON CONFLICT(business_id, module_id) DO UPDATE SET
        active = 1, version = excluded.version, activated_at = excluded.activated_at,
        activated_by = excluded.activated_by, deactivated_at = NULL
        ${config ? ', config = excluded.config' : ''}
    `).run(m.id, m.version, JSON.stringify(config || safeJson(existing && existing.config) || {}), now, userId);
  };
  if (d.transaction) d.transaction(run)(); else run();
  if (audit) {
    audit({ userId, action: 'module/activate', entity: 'module', entityId: m.id, detail: { version: m.version, name: m.name } });
  }
  stamp++;
  return m;
}

function deactivate(d, id, { userId = null, audit } = {}) {
  const m = get(id);
  if (!m) throw block(404, `unknown module: ${id}`);
  ensureTable(d);
  const now = new Date().toISOString();
  const run = () => d.prepare(`
    INSERT INTO modules (business_id, module_id, version, active, config, activated_at, activated_by, deactivated_at)
    VALUES (1, ?, ?, 0, '{}', NULL, NULL, ?)
    ON CONFLICT(business_id, module_id) DO UPDATE SET active = 0, deactivated_at = excluded.deactivated_at
  `).run(m.id, m.version, now);
  if (d.transaction) d.transaction(run)(); else run();
  if (audit) audit({ userId, action: 'module/deactivate', entity: 'module', entityId: m.id, detail: { name: m.name } });
  stamp++;
  return m;
}

/**
 * Trade-driven activation: every module that declares this trade is turned on.
 * A module the owner switched on by hand for another trade is left alone.
 */
function syncForTrade(d, trade, opts = {}) {
  const activated = [];
  for (const m of forTrade(trade)) {
    const row = rowOf(d, m.id);
    if (row && row.active) continue;          // already on
    if (row && !row.active && !opts.force) continue; // owner switched it off — respect that
    activate(d, m.id, opts);
    activated.push(m.id);
  }
  return activated;
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

/** Add a column if it is missing. Additive only — never alters an existing one. */
function addColIfMissing(d, table, column, def) {
  const exists = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!exists) return false;
  const has = d.prepare(`PRAGMA table_info('${String(table).replace(/'/g, "''")}')`).all().some((c) => c.name === column);
  if (has) return false;
  d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  return true;
}

// ---- the active registry ----------------------------------------------------

const cache = new WeakMap();   // db -> { stamp, key, registry }

/**
 * The registry of modules active for this business. Cheap to call: the DB is
 * read once and the result is cached until a module is (de)activated.
 */
function active(d, { trade } = {}) {
  const t = trade !== undefined ? trade : defaultTrade(d);
  const ids = activeIds(d).filter((id) => !!get(id));
  const key = `${t}|${ids.join(',')}`;
  const hit = cache.get(d);
  if (hit && hit.stamp === stamp && hit.key === key) return hit.registry;
  // A trade's modules are active even if the row is missing (fresh installs,
  // databases created before this framework existed).
  const defs = all().filter((m) => ids.includes(m.id) || (t && (m.trades.includes('*') || m.trades.includes(String(t)))));
  const seen = new Set();
  const registry = new Registry(defs.filter((m) => !seen.has(m.id) && seen.add(m.id)), { trade: t });
  cache.set(d, { stamp, key, registry });
  return registry;
}

function defaultTrade(d) {
  try {
    const row = d.prepare("SELECT value FROM settings WHERE key = 'business'").get();
    if (row && row.value) return (JSON.parse(row.value) || {}).trade || null;
  } catch (_) {}
  return null;
}

/** Forget the cached registry for a database (after out-of-band changes). */
function invalidate(d) {
  cache.delete(d);
}

class Registry {
  constructor(defs, { trade } = {}) {
    this.modules = defs;
    this.trade = trade || null;
    this.ids = defs.map((m) => m.id);
  }

  has(hook) {
    if (hook.startsWith('checkout.')) return this.modules.some((m) => !!m.checkout[hook.split('.')[1]]);
    if (hook === 'stock.rule') return this.modules.some((m) => !!m.stock.rule);
    if (hook === 'template') return this.modules.some((m) => !!m.template);
    return this.modules.some((m) => (m[hook] || []).length > 0);
  }

  /**
   * Run a gating hook across every active module. A module blocks by throwing
   * `block(status, message)`. Unexpected failures are contained and reported as
   * the module's own failure — the core never claims a module's rule passed.
   */
  gate(hook, ctx = {}) {
    ctx.moduleErrors = ctx.moduleErrors || [];
    ctx.results = ctx.results || {};
    for (const m of this.modules) {
      const fn = hook.startsWith('checkout.') ? m.checkout[hook.split('.')[1]] : (hook === 'stock.rule' ? m.stock.rule : null);
      if (!fn) continue;
      try {
        // A hook may return per-line data the core stores opaquely (e.g. a
        // prescription reference). The core never looks inside it.
        const returned = fn(ctx);
        if (returned !== undefined && returned !== null) ctx.results[m.id] = returned;
      } catch (e) {
        const failure = { module: m.id, hook, message: e.message };
        ctx.moduleErrors.push(failure);
        if (e && e.moduleError) throw e;
        throw block(500, `module "${m.id}" failed the ${hook} check — ${e.message}`, { module: m.id, cause: e });
      }
    }
    return ctx;
  }

  /** Additive hook: a broken module is skipped, the core keeps working. */
  collect(hook, ctx = {}) {
    ctx.moduleErrors = ctx.moduleErrors || [];
    const out = [];
    for (const m of this.modules) {
      const v = m[hook];
      if (v === undefined || v === null) continue;
      if (hook === 'template') {
        if (!v) continue;
        out.push({ module: m.id, ...v });
        continue;
      }
      if (!Array.isArray(v) || !v.length) continue;
      out.push(...v.map((item) => ({ ...item, module: m.id })));
    }
    return out;
  }

  productFields() { return this.collect('productFields'); }
  permissions() { return this.collect('permissions'); }
  ui() { return this.collect('ui'); }
  reports() { return this.collect('reports').map((r) => ({ ...r, module: r.module })); }
  template() { return this.collect('template'); }

  /**
   * Receipt lines the active trades ask for, in the language of the shop.
   * The core never names a trade: it prints whatever the modules hand it.
   */
  receiptLines(lang = 'en') {
    return this.collect('receipt')
      .map((r) => r[lang] || r.en)
      .filter((x) => typeof x === 'string' && x.trim());
  }

  commands() { return this.collect('commands'); }
  command(id) { return this.commands().find((c) => c.id === String(id)) || null; }
  report(id) { return this.reports().find((r) => r.id === String(id)) || null; }
  field(key) { return this.productFields().find((f) => f.key === key) || null; }
  knowsPermission(perm) { return this.permissions().some((p) => p.perm === perm); }

  /** Permissions a role gets by default from active modules. */
  rolePermissions(role) {
    return this.permissions().filter((p) => p.roles.includes(role)).map((p) => p.perm);
  }

  describe() {
    return this.modules.map((m) => ({
      id: m.id, name: m.name, nameSw: m.nameSw, version: m.version,
      description: m.description, descriptionSw: m.descriptionSw,
      provides: provides(m.id), file: m.file ? path.relative(MODULE_DIR, m.file) : null
    }));
  }
}

module.exports = {
  block, HOOKS, HOOK_NAMES,
  reset, register, discover, all, get, forTrade, provides,
  ensureTable, activeIds, isActive, rowOf, isEmpty, activate, deactivate, syncForTrade, invalidate, addColIfMissing,
  active, Registry, MODULE_DIR
};
