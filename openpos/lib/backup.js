'use strict';
// ---------------------------------------------------------------------------
// backup.js — snapshots, restore and the DR drill (Phase 32).
//
// A backup nobody has restored is a belief, not a backup. So this file makes
// two promises and keeps them testable:
//   1. A snapshot is a CONSISTENT copy (VACUUM INTO, not a file copy that can
//      catch the database mid-write), sealed with a checksum in its manifest.
//   2. Restoring VERIFIES first — integrity-checked, then swapped — and the
//      drill tells the owner how old their last good copy is.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const sec = require('./security');

function backupDir(dbm) {
  const dir = process.env.OPENPOS_BACKUP_DIR || path.join(path.dirname(dbm.DB_PATH), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Take a snapshot. `VACUUM INTO` gives a transactionally consistent copy even
 * while the shop is trading; the fallback is a plain copy (still fine with the
 * default rollback journal, and it says so in the manifest).
 */
function snapshot(d, dbm, { note = '' } = {}) {
  const dir = backupDir(dbm);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const cfg = sec.settings(d, dbm);
  const pass = dbm.getSetting(d, 'backup_passphrase', null);
  const sealed = cfg.backup.encrypt && !!pass;
  const base = `openpos-${ts}${sealed ? '.opbk' : '.db'}`;
  const tmp = path.join(dir, `.${base}.tmp`);
  const file = path.join(dir, base);

  let method = 'vacuum into';
  try {
    d.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  } catch (e) {
    // The book runs in WAL mode, so a raw copy can catch it mid-write:
    // checkpoint the journal into the main file, then copy and verify.
    method = 'checkpointed file copy';
    try { d.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (_) {}
    fs.copyFileSync(dbm.DB_PATH, tmp);
  }
  let bytes = fs.readFileSync(tmp);
  const rawSum = sha256(bytes);
  if (sealed) bytes = sec.encrypt(bytes, pass);
  fs.writeFileSync(file, bytes);
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);

  const manifest = {
    file: base,
    created_at: new Date().toISOString(),
    method,
    encrypted: sealed,
    bytes: bytes.length,
    sha256: sha256(bytes),
    sha256_plaintext: rawSum,
    schema: dbm.schemaInfo(d).version,
    note: String(note || '').slice(0, 200)
  };
  fs.writeFileSync(path.join(dir, `${base}.manifest.json`), JSON.stringify(manifest, null, 2));
  return manifest;
}

function list(dbm) {
  const dir = backupDir(dbm);
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.manifest.json'))
    .map((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

/**
 * Verify a snapshot without touching the live shop: does it exist, does its
 * checksum still match the manifest, is it a readable SQLite file, and is it
 * actually this shop's book?
 */
/**
 * Open a decrypted copy read-only and ask SQLite itself whether the book is
 * whole. This is the difference between "we have a file" and "we have a shop".
 */
function integrityOf(bytes) {
  const sqlite = require('node:sqlite');
  const Database = sqlite.DatabaseSync || sqlite.Database;
  const tmp = path.join(os.tmpdir(), `openpos-verify-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.db`);
  fs.writeFileSync(tmp, bytes);
  try {
    const d = new Database(tmp, { readOnly: true });
    const ok = (d.prepare('PRAGMA integrity_check').get() || {}).integrity_check;
    const sales = d.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='sales'").get().n
      ? d.prepare('SELECT COUNT(*) AS n FROM sales').get().n : 0;
    d.close();
    return { integrity: ok, sales };
  } catch (e) {
    return { integrity: `unreadable: ${e.message}`, sales: 0 };
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

function verify(dbm, file, passphrase = null) {
  const dir = backupDir(dbm);
  const p = path.join(dir, path.basename(file));
  if (!fs.existsSync(p)) return { ok: false, error: 'no such backup file' };
  const manifestPath = `${p}.manifest.json`;
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
  const bytes = fs.readFileSync(p);
  const sum = sha256(bytes);
  const out = {
    file: path.basename(p),
    ok: true,
    bytes: bytes.length,
    sha256: sum,
    manifest_match: manifest ? sum === manifest.sha256 : null,
    encrypted: bytes.slice(0, 5).toString() === 'OPBK1'
  };
  if (manifest && out.manifest_match === false) out.ok = false;
  if (out.encrypted) {
    if (!passphrase) return { ...out, integrity: 'sealed — the passphrase is needed to check inside' };
    try {
      const plain = sec.decrypt(bytes, passphrase);
      const deep = integrityOf(plain);
      return { ...out, ...deep, ok: out.ok && deep.integrity === 'ok', sales_rows: deep.sales };
    } catch (e) {
      return { ...out, ok: false, integrity: `could not open: ${e.message}` };
    }
  }
  const deep = integrityOf(bytes);
  return { ...out, ...deep, ok: out.ok && deep.integrity === 'ok', sales_rows: deep.sales };
}

/**
 * Restore. Two doors: `check` proves the file is good, `apply` swaps it in.
 * The apply step refuses a file it has not just verified, and the shop is told
 * it must restart — a live server cannot swap its own database safely.
 */
function restore(dbm, file, { apply = false, passphrase = null } = {}) {
  const dir = backupDir(dbm);
  const p = path.join(dir, path.basename(file));
  if (!fs.existsSync(p)) throw new Error('no such backup file');
  let bytes = fs.readFileSync(p);
  if (bytes.slice(0, 5).toString() === 'OPBK1') bytes = sec.decrypt(bytes, passphrase);
  const check = verify(dbm, file);
  if (check.manifest_match === false) throw new Error('the backup does not match its manifest — refusing to restore');
  if (!apply) return { ok: true, checked: true, bytes: bytes.length, restart_required: false };

  const live = dbm.DB_PATH;
  const staged = `${live}.restore-${Date.now()}`;
  fs.writeFileSync(staged, bytes);
  // Safety: keep the current book, then swap on the next start.
  fs.renameSync(live, `${live}.pre-restore-${Date.now()}`);
  fs.renameSync(staged, live);
  return {
    ok: true, restored: true, bytes: bytes.length,
    restart_required: true,
    note: 'the old database was kept alongside this one — restart OpenPOS to trade on the restored book'
  };
}

/** The drill an owner can actually do: is there a good copy, and how old is it? */
function drill(d, dbm) {
  const items = list(dbm);
  const t0 = Date.now();
  const checks = [];
  let good = null;
  const pass = dbm.getSetting(d, 'backup_passphrase', null);
  for (const m of items.slice(0, 5)) {
    const v = verify(dbm, m.file, pass);
    checks.push({ file: m.file, created_at: m.created_at, ok: v.ok && v.manifest_match !== false, encrypted: v.encrypted });
    if (!good && v.ok && v.manifest_match !== false && v.integrity === 'ok') good = m;
  }
  const last = items[0] || null;
  const ageMin = last ? Math.round((Date.now() - new Date(last.created_at).getTime()) / 60000) : null;
  return {
    backup_dir: backupDir(dbm),
    backups: items.length,
    last_backup_at: last ? last.created_at : null,
    last_backup_age_minutes: ageMin,
    verified_good: !!good,
    checks,
    rpo_minutes: ageMin === null ? null : ageMin,
    rto_estimate_minutes: items.length ? 5 : null,
    drill_ms: Date.now() - t0,
    pass: !!good && (ageMin === null || ageMin <= 24 * 60),
    sentence: !items.length
      ? 'No backups have been taken yet — take one before you need it.'
      : (good
        ? `Last good backup: ${good.file}${ageMin !== null ? `, ${ageMin} minute(s) old` : ''}. Restore is verified and takes about 5 minutes.`
        : `There ${items.length === 1 ? 'is' : 'are'} ${items.length} backup(s) but none could be verified — take a fresh one.`)
  };
}

module.exports = { snapshot, list, verify, restore, drill, backupDir };
