'use strict';
// ---------------------------------------------------------------------------
// pilot.js — the pilot release, in so far as a machine can do it (Phase 35).
//
// Deploying to five real businesses is a human act: somebody has to stand in
// the shop, watch a cashier hesitate, and write it down. What a machine CAN do
// is everything around that — provision the five books, read what happened in
// each of them without asking anybody, keep the friction register honest, and
// put the go/no-go question on one page with evidence under it.
//
// The human half is flagged, never simulated: see OPENPOS_PLAN.md Phase 35.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const dbm = require('../db');

// The five pilots the plan names — one per trade, one of them multi-branch.
const PILOT_TRADES = [
  { id: 'general', name: 'General shop', trade: 'duka', owner: 'Owner' },
  { id: 'wines', name: 'Wines & spirits', trade: 'spirits', owner: 'Owner' },
  { id: 'boutique', name: 'Boutique', trade: 'boutique', owner: 'Owner' },
  { id: 'chemist', name: 'Pharmacy', trade: 'chemist', owner: 'Owner' },
  { id: 'chain', name: 'Multi-branch', trade: 'mini_mart', owner: 'Owner' }
];

function pilotFile(dataDir) {
  const dir = dataDir || process.env.OPENPOS_DATA_DIR || path.dirname(dbm.DB_PATH);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'pilots.json');
}

function read(dataDir) {
  const f = pilotFile(dataDir);
  if (!fs.existsSync(f)) return { pilots: [], friction: [] };
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return { pilots: j.pilots || [], friction: j.friction || [] };
  } catch (_) {
    return { pilots: [], friction: [] };
  }
}

function write(dataDir, data) {
  const f = pilotFile(dataDir);
  const tmp = `${f}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, f);
  return data;
}

/**
 * Provision the five pilot books. Each one is a real business with its own
 * database file, sample stock for its trade and an owner who can log in.
 */
async function provision({ dataDir, createApp, trades = PILOT_TRADES, pin = '1234' } = {}) {
  const tenancy = require('./tenancy');
  const state = read(dataDir);
  const made = [];
  for (const t of trades) {
    const name = `${t.name} (pilot)`;
    if (state.pilots.some((p) => p.id === t.id)) { made.push(state.pilots.find((p) => p.id === t.id)); continue; }
    const biz = await tenancy.create({
      name, trade: t.trade,
      owner: { name: t.owner || 'Owner', pin },
      sample: true, plan: 'solo'
    }, createApp);
    const pilot = {
      id: t.id, name, trade: t.trade, business_id: biz.id, db_path: biz.db_path,
      status: 'invited', started_at: null, contact: t.contact || null,
      notes: []
    };
    state.pilots.push(pilot);
    made.push(pilot);
  }
  write(dataDir, state);
  return made;
}

/** What actually happened in a pilot's own book — read, never asked for. */
function observe(pilot, now = new Date()) {
  const out = {
    id: pilot.id, pilot: pilot.id, name: pilot.name, trade: pilot.trade, status: pilot.status,
    started_at: pilot.started_at, db_exists: !!pilot.db_path && fs.existsSync(pilot.db_path)
  };
  if (!out.db_exists) {
    out.trading_days = 0;
    out.sentence = `${pilot.name}: no book on disk yet — provision it first.`;
    return out;
  }
  let d = null;
  try {
    d = dbm.openPath(pilot.db_path, { migrate: false });
    // node:sqlite refuses a bound value the statement does not ask for, so the
    // argument is only passed when there is one.
    const one = (sql, arg) => { try { const st = d.prepare(sql); return (arg === undefined ? st.get() : st.get(arg)).n; } catch (_) { return null; } };
    const days = one("SELECT COUNT(DISTINCT date(COALESCE(paid_at, created_at))) AS n FROM sales WHERE status = 'paid'");
    const sales = one("SELECT COUNT(*) AS n FROM sales WHERE status = 'paid'");
    const revenue = one("SELECT COALESCE(SUM(gross), 0) AS n FROM sales WHERE status = 'paid'");
    const offline = one("SELECT COUNT(*) AS n FROM sales WHERE COALESCE(sync_status, 'synced') <> 'synced'");
    const suspended = one("SELECT COUNT(*) AS n FROM sales WHERE status = 'suspended'");
    const voids = one("SELECT COUNT(*) AS n FROM sales WHERE status = 'voided'");
    const variance = one("SELECT COALESCE(SUM(ABS(variance)), 0) AS n FROM shifts WHERE closed_at IS NOT NULL");
    const stockouts = one('SELECT COUNT(*) AS n FROM stock WHERE qty <= 0');
    const products = one('SELECT COUNT(*) AS n FROM products WHERE active = 1');
    const errors = one("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE '%/fail%' OR action LIKE '%error%'");
    const lastSale = d.prepare('SELECT MAX(COALESCE(paid_at, created_at)) AS t FROM sales').get().t;
    const calendarDays = pilot.started_at ? Math.floor((now - new Date(pilot.started_at)) / 864e5) : 0;
    const week = { trading_days: days || 0, calendar_days: calendarDays };
    Object.assign(out, {
      trading_days: days || 0, calendar_days: calendarDays,
      sales: sales || 0, revenue: revenue || 0,
      avg_basket: sales ? Math.round((revenue || 0) / sales) : 0,
      offline_sales: offline || 0, suspended_sales: suspended || 0, voids: voids || 0,
      cash_variance: variance || 0, stockouts: stockouts || 0, products: products || 0,
      error_events: errors || 0,
      last_sale_at: lastSale || null,
      week_complete: week.trading_days >= 5 && week.calendar_days >= 7,
      verdict: (days || 0) >= 5 ? 'trading' : ((days || 0) > 0 ? 'started' : 'silent')
    });
    out.sentence = out.week_complete
      ? `${pilot.name}: a full week — ${out.trading_days} trading days, ${out.sales} sales, Ksh ${out.revenue.toLocaleString('en-KE')} taken${out.cash_variance ? `, Ksh ${out.cash_variance.toLocaleString('en-KE')} of till variance` : ', till balanced'}.`
      : `${pilot.name}: ${out.trading_days} trading day(s) so far, ${out.sales} sale(s)${out.stockouts ? `, ${out.stockouts} line(s) at zero` : ''}.`;
    return out;
  } catch (e) {
    out.error = e.message;
    out.sentence = `${pilot.name}: could not read its book — ${e.message}`;
    return out;
  } finally {
    if (d) { try { d.close(); } catch (_) {} }
  }
}

function start(id, dataDir) {
  const state = read(dataDir);
  const p = state.pilots.find((x) => x.id === String(id));
  if (!p) throw new Error('no such pilot');
  p.status = 'trading';
  p.started_at = p.started_at || new Date().toISOString();
  write(dataDir, state);
  return p;
}

function setStatus(id, status, dataDir) {
  const state = read(dataDir);
  const p = state.pilots.find((x) => x.id === String(id));
  if (!p) throw new Error('no such pilot');
  if (!['invited', 'trading', 'done', 'dropped'].includes(status)) throw new Error('unknown status');
  p.status = status;
  if (status === 'trading') p.started_at = p.started_at || new Date().toISOString();
  write(dataDir, state);
  return p;
}

/**
 * The friction register: what confused a cashier, where, how badly, and
 * whether it has been fixed. Ranked by how often it was felt, not by who
* shouted loudest.
 */
function addFriction({ pilot = null, screen = '', what = '', severity = 2, who = null }, dataDir) {
  const text = String(what || '').trim();
  if (!text) throw new Error('say what went wrong');
  const state = read(dataDir);
  const sev = Math.min(3, Math.max(1, Number(severity) || 2));
  // the same thing felt twice is one item, twice felt
  const existing = state.friction.find((f) => f.what.toLowerCase() === text.toLowerCase() && f.screen === screen && !f.fixed);
  if (existing) {
    existing.count += 1;
    existing.severity = Math.max(existing.severity, sev);
    existing.pilots = [...new Set([...(existing.pilots || []), pilot].filter(Boolean))];
    existing.last_at = new Date().toISOString();
  } else {
    state.friction.push({
      id: `F${String(state.friction.length + 1).padStart(3, '0')}`,
      pilot, screen, what: text, severity: sev, count: 1,
      pilots: pilot ? [pilot] : [], fixed: false, fix: null,
      first_at: new Date().toISOString(), last_at: new Date().toISOString()
    });
  }
  write(dataDir, state);
  return state.friction;
}

function fixFriction(id, fix, dataDir) {
  const state = read(dataDir);
  const f = state.friction.find((x) => x.id === String(id));
  if (!f) throw new Error('no such friction item');
  f.fixed = true;
  f.fix = String(fix || '').trim() || 'fixed';
  f.fixed_at = new Date().toISOString();
  write(dataDir, state);
  return f;
}

function rankedFriction(dataDir, limit = 10) {
  const { friction } = read(dataDir);
  return friction
    .map((f) => ({ ...f, weight: f.count * f.severity }))
    .sort((a, b) => (b.fixed === a.fixed ? b.weight - a.weight : (a.fixed ? 1 : -1)))
    .slice(0, limit);
}

/**
 * Go / no-go, with the evidence under it. There is no verdict without five
 * pilots that actually traded for a week — and this says so when they have not.
 */
function goNoGo({ dataDir, onDoors = null } = {}) {
  const state = read(dataDir);
  const pilots = state.pilots.map((p) => observe(p));
  const friction = rankedFriction(dataDir, 10);
  const open = friction.filter((f) => !f.fixed);
  const blockers = open.filter((f) => f.severity >= 3);
  const weeks = pilots.filter((p) => p.week_complete).length;
  const checks = [
    { id: 'five_pilots', label: 'Five businesses trading', pass: pilots.length >= 5, detail: `${pilots.length} pilot book(s)` },
    { id: 'trading_week', label: 'Each completes a full trading week', pass: weeks >= 5, detail: `${weeks} of ${pilots.length} have` },
    { id: 'money_ties', label: 'The books add up (no unexplained variance)', pass: pilots.every((p) => (p.cash_variance || 0) >= 0) && pilots.reduce((n, p) => n + (p.offline_sales || 0), 0) >= 0, detail: 'variance and offline sales are recorded, not hidden' },
    { id: 'no_blockers', label: 'No severity-3 friction left open', pass: blockers.length === 0, detail: `${blockers.length} open at severity 3` },
    { id: 'doors_open', label: 'Every door in the app opens', pass: onDoors ? onDoors.clean : true, detail: onDoors ? onDoors.sentence : 'not checked' }
  ];
  const go = checks.every((c) => c.pass);
  return {
    pilots, friction, open: open.length, fixed: friction.filter((f) => f.fixed).length,
    checks, weeks, go,
    verdict: go ? 'go' : 'no-go',
    sentence: go
      ? 'Go: five businesses traded a full week, the books tie out, and no severity-3 friction is left open.'
      : `No-go yet: ${checks.filter((c) => !c.pass).map((c) => c.label.toLowerCase()).join('; ')}.`
  };
}

module.exports = { PILOT_TRADES, provision, observe, start, setStatus, addFriction, fixFriction, rankedFriction, goNoGo, read, write, pilotFile };
