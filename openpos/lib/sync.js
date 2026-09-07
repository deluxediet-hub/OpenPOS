'use strict';
// lib/sync.js — Offline-First Sync Engine (Phase 17 Day 24-25)
// Local tx storage → outbox → sync engine → conflict detection (single-writer + first-ack R-O4)
// → retry with backoff → server ack → reconciliation + sync-status banner

const crypto = require('crypto');

function nowIso() { return new Date().toISOString(); }
function uuid() { return crypto.randomUUID(); }

// Conflict detection: first-ack wins (server version wins if already acked)
// For sales: client_id unique prevents duplicate money
// For stock: version check, first ack wins, second gets conflict logged

function detectConflict(db, entityType, entityId, clientId, version) {
  if (!clientId) return null;
  // If client_id already exists as a sale, it's a duplicate (idempotent success)
  if (entityType === 'sale') {
    const existing = db.prepare('SELECT id, client_id, version FROM sales WHERE client_id = ?').get(clientId);
    if (existing) {
      // Same client_id already acked → idempotent, not conflict
      return { type: 'duplicate', existingId: existing.id, message: 'already acked' };
    }
  }
  // For stock moves, check version
  if (entityType === 'stock') {
    // stock moves are append-only, so no version conflict unless same client_id
    const ex = db.prepare('SELECT id FROM stock_moves WHERE client_id = ?').get(clientId);
    if (ex) return { type: 'duplicate', existingId: ex.id, message: 'stock move already acked' };
  }
  return null;
}

function logSync(db, { entity_type, entity_id, branch_id, register_id, action, payload, client_id, version }) {
  db.prepare(
    `INSERT INTO sync_log (entity_type, entity_id, branch_id, register_id, action, payload, client_id, version, created_at, acked, conflict)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`
  ).run(entity_type, entity_id, branch_id || null, register_id || null, action, JSON.stringify(payload || {}), client_id || null, version || 1, nowIso());
}

function logConflict(db, { entity_type, entity_id, client_id, branch_id, register_id, attempted_payload, existing_payload, reason }) {
  db.prepare(
    `INSERT INTO sync_conflicts (entity_type, entity_id, client_id, branch_id, register_id, attempted_payload, existing_payload, reason, resolution, resolved, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'first_ack_wins', 0, ?)`
  ).run(entity_type, entity_id || null, client_id, branch_id || null, register_id || null,
    JSON.stringify(attempted_payload || {}), JSON.stringify(existing_payload || {}), reason || '', nowIso());
  // also log to sync_log as conflict (entity_id may be null before sale creation -> use 0)
  db.prepare(
    `INSERT INTO sync_log (entity_type, entity_id, branch_id, register_id, action, payload, client_id, version, created_at, acked, conflict)
     VALUES (?, ?, ?, ?, 'conflict', ?, ?, 1, ?, 0, 1)`
  ).run(entity_type, entity_id || 0, branch_id || null, register_id || null,
    JSON.stringify({ reason, attempted: attempted_payload }), client_id || null, nowIso());
}

function pushSale(db, { branch_id, register_id, user_id, client_id, payload, offline_created }) {
  // idempotency: if client_id exists, return existing sale
  if (client_id) {
    const existing = db.prepare('SELECT * FROM sales WHERE client_id = ?').get(client_id);
    if (existing) {
      return { status: 'acked', sale: existing, duplicate: true };
    }
  }
  // Create sale via existing sale creation logic? We delegate to caller, but here we just log outbox
  // This function is used when client pushes raw sale payload to sync endpoint
  // We will attempt to insert into sync_outbox first, then process
  const cid = client_id || uuid();
  const now = nowIso();
  try {
    db.prepare(
      `INSERT INTO sync_outbox (client_id, branch_id, register_id, user_id, type, payload, status, attempts, created_at, updated_at, version)
       VALUES (?, ?, ?, ?, 'sale', ?, 'pending', 0, ?, ?, 1)`
    ).run(cid, branch_id, register_id || null, user_id || null, JSON.stringify(payload || {}), now, now);
  } catch (e) {
    if (String(e.message).includes('UNIQUE') || String(e.message).includes('unique')) {
      const out = db.prepare('SELECT * FROM sync_outbox WHERE client_id = ?').get(cid);
      if (out && out.server_entity_id) {
        const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(out.server_entity_id);
        if (sale) return { status: 'acked', sale, duplicate: true };
      }
      return { status: 'pending', outbox: out };
    }
    throw e;
  }
  return { status: 'pending', client_id: cid };
}

function processOutbox(db, { processSaleFn, limit = 20 }) {
  // processSaleFn is async function that takes payload and returns { sale } or throws
  // For sync usage in server.js, we will process synchronously with existing sale creation transaction
  const rows = db.prepare(`SELECT * FROM sync_outbox WHERE status IN ('pending','failed') ORDER BY created_at ASC LIMIT ?`).all(limit);
  const results = [];
  for (const row of rows) {
    const payload = (() => { try { return JSON.parse(row.payload); } catch { return {}; } })();
    // Check conflict before processing
    const conflict = detectConflict(db, row.type, null, row.client_id, row.version);
    if (conflict && conflict.type === 'duplicate') {
      db.prepare(`UPDATE sync_outbox SET status='acked', updated_at=?, acked_at=?, server_entity_id=? WHERE id=?`)
        .run(nowIso(), nowIso(), conflict.existingId, row.id);
      results.push({ client_id: row.client_id, status: 'acked', duplicate: true, entity_id: conflict.existingId });
      continue;
    }
    try {
      db.prepare(`UPDATE sync_outbox SET status='processing', attempts=attempts+1, updated_at=? WHERE id=?`).run(nowIso(), row.id);
      // The actual sale creation is done by caller; here we just mark as processing
      // For offline-first, we expect server.js to handle the sale creation transactionally
      results.push({ client_id: row.client_id, status: 'processing', outbox_id: row.id, payload });
    } catch (e) {
      db.prepare(`UPDATE sync_outbox SET status='failed', last_error=?, updated_at=? WHERE id=?`).run(String(e.message).slice(0, 500), nowIso(), row.id);
      logConflict(db, {
        entity_type: row.type,
        client_id: row.client_id,
        branch_id: row.branch_id,
        register_id: row.register_id,
        attempted_payload: payload,
        existing_payload: {},
        reason: e.message
      });
      results.push({ client_id: row.client_id, status: 'failed', error: e.message });
    }
  }
  return results;
}

function ackOutbox(db, client_id, server_entity_id) {
  const now = nowIso();
  db.prepare(`UPDATE sync_outbox SET status='acked', acked_at=?, server_entity_id=?, updated_at=? WHERE client_id=?`)
    .run(now, server_entity_id, now, client_id);
}

function getStatus(db, { branch_id } = {}) {
  const whereBranch = (col) => branch_id ? ` AND ${col} = ?` : '';
  const argsBranch = branch_id ? [branch_id] : [];
  const outboxPending = db.prepare(`SELECT COUNT(*) AS n FROM sync_outbox WHERE status IN ('pending','processing','failed')${whereBranch('branch_id')}`).get(...argsBranch)?.n || 0;
  const outboxFailed = db.prepare(`SELECT COUNT(*) AS n FROM sync_outbox WHERE status='failed'${whereBranch('branch_id')}`).get(...argsBranch)?.n || 0;
  const outboxAcked = db.prepare(`SELECT COUNT(*) AS n FROM sync_outbox WHERE status='acked'${whereBranch('branch_id')}`).get(...argsBranch)?.n || 0;
  const outboxConflict = db.prepare(`SELECT COUNT(*) AS n FROM sync_outbox WHERE status='conflict'${whereBranch('branch_id')}`).get(...argsBranch)?.n || 0;
  const outboxTotal = db.prepare(`SELECT COUNT(*) AS n FROM sync_outbox WHERE 1=1${whereBranch('branch_id')}`).get(...argsBranch)?.n || 0;
  const conflicts = db.prepare(`SELECT COUNT(*) AS n FROM sync_conflicts WHERE resolved=0${whereBranch('branch_id')}`).get(...argsBranch)?.n || 0;
  const salesPendingSync = db.prepare(`SELECT COUNT(*) AS n FROM sales WHERE sync_status='pending'${whereBranch('branch_id')}`).get(...argsBranch)?.n || 0;
  const salesTotal = db.prepare(`SELECT COUNT(*) AS n FROM sales WHERE 1=1${whereBranch('branch_id')}`).get(...argsBranch)?.n || 0;
  const salesOffline = (() => { try { return db.prepare(`SELECT COUNT(*) AS n FROM sales WHERE offline_created=1${whereBranch('branch_id')}`).get(...argsBranch)?.n || 0; } catch { return db.prepare(`SELECT COUNT(*) AS n FROM sales WHERE client_id IS NOT NULL${whereBranch('branch_id')}`).get(...argsBranch)?.n || 0; } })();
  const etimsQueued = db.prepare(`SELECT COUNT(*) AS n FROM etims_queue WHERE status IN ('queued','pending')${whereBranch('branch_id')}`).get(...argsBranch)?.n || 0;
  const etimsTransmitted = (() => { try { return db.prepare(`SELECT COUNT(*) AS n FROM etims_queue WHERE status='transmitted'${whereBranch('branch_id')}`).get(...argsBranch)?.n || 0; } catch { return 0; } })();
  const syncLogTotal = db.prepare(`SELECT COUNT(*) AS n FROM sync_log WHERE 1=1${whereBranch('branch_id')}`).get(...argsBranch)?.n || 0;
  const syncLogLast24 = (() => { try { return db.prepare(`SELECT COUNT(*) AS n FROM sync_log WHERE created_at >= datetime('now','-1 day')${whereBranch('branch_id')}`).get(...argsBranch)?.n || 0; } catch { return 0; } })();
  const lastSync = db.prepare(`SELECT created_at FROM sync_log ORDER BY id DESC LIMIT 1`).get();
  const lastOutbox = db.prepare(`SELECT acked_at FROM sync_outbox WHERE status='acked' ORDER BY acked_at DESC LIMIT 1`).get();
  const recon_ok = outboxPending === 0 && conflicts === 0 && salesPendingSync === 0;
  return {
    outbox: { total: outboxTotal, pending: outboxPending, failed: outboxFailed, acked: outboxAcked, conflict: outboxConflict },
    sync_log: { total: syncLogTotal, last24h: syncLogLast24 },
    sales: { total: salesTotal, offline: salesOffline, pending_sync: salesPendingSync },
    etims: { pending: etimsQueued, transmitted: etimsTransmitted, queued: etimsQueued },
    recon: { ok: recon_ok },
    conflicts,
    salesPendingSync,
    etimsQueued,
    lastSyncAt: lastSync?.created_at || null,
    lastAckAt: lastOutbox?.acked_at || null,
    recon_ok
  };
}

function pullChanges(db, { branch_id, since, limit = 100 }) {
  let sql = `SELECT * FROM sync_log WHERE 1=1`;
  const params = [];
  if (branch_id) { sql += ` AND branch_id = ?`; params.push(branch_id); }
  if (since) { sql += ` AND created_at > ?`; params.push(since); }
  sql += ` ORDER BY created_at ASC LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...params);
}

function getConflicts(db, { branch_id, limit = 50 } = {}) {
  let sql = `SELECT * FROM sync_conflicts WHERE resolved=0`;
  const params = [];
  if (branch_id) { sql += ` AND branch_id = ?`; params.push(branch_id); }
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);
  const rows = db.prepare(sql).all(...params);
  return rows.map(r => ({ ...r, resolved_by: r.resolution || 'first_ack_wins', reason: r.reason || '' }));
}

function resolveConflict(db, id, resolution = 'first_ack_wins', userId = null) {
  const row = db.prepare('SELECT * FROM sync_conflicts WHERE id = ?').get(id);
  if (!row) throw new Error('conflict not found');
  db.prepare(`UPDATE sync_conflicts SET resolved=1, resolution=?, resolved_at=? WHERE id=?`).run(resolution, nowIso(), id);
  if (resolution === 'client_wins') {
    // Re-apply client payload? For now just log
    db.prepare(
      `INSERT INTO sync_log (entity_type, entity_id, branch_id, register_id, action, payload, client_id, version, created_at, acked, conflict)
       VALUES (?, ?, ?, ?, 'create', ?, ?, 1, ?, 1, 0)`
    ).run(row.entity_type, row.entity_id || null, row.branch_id, row.register_id, row.attempted_payload, row.client_id, nowIso());
  }
  return { ok: true, id, resolution };
}

function retryFailed(db) {
  const now = nowIso();
  const rows = db.prepare(`SELECT * FROM sync_outbox WHERE status='failed' ORDER BY created_at ASC LIMIT 50`).all();
  for (const r of rows) {
    // exponential backoff: attempts * 30s
    const last = new Date(r.updated_at).getTime();
    const backoffMs = Math.min(1000 * 30 * Math.pow(2, r.attempts), 1000 * 60 * 10); // max 10min
    if (Date.now() - last < backoffMs) continue;
    db.prepare(`UPDATE sync_outbox SET status='pending', updated_at=? WHERE id=?`).run(now, r.id);
  }
  return rows.length;
}

module.exports = {
  uuid,
  nowIso,
  detectConflict,
  logSync,
  logConflict,
  pushSale,
  processOutbox,
  ackOutbox,
  getStatus,
  pullChanges,
  getConflicts,
  resolveConflict,
  retryFailed
};
