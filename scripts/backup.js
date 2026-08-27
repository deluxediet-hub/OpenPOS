'use strict';
/**
 * backup.js — safe hot backup of the SQLite database, with rotation and an
 * optional off-site webhook push.
 *
 * Uses better-sqlite3's online backup API, so it is safe to run while the
 * server is live and needs no external sqlite3 CLI.
 *
 *   npm run backup                     -> backups/pos-YYYY-MM-DD-HHMMSS.db
 *   npm run backup -- /path/x.db       -> explicit destination
 *
 * Environment:
 *   POS_BACKUP_KEEP    how many local copies to retain (default 14, 0 = keep all)
 *   POS_BACKUP_WEBHOOK optional HTTPS URL; the finished backup is PUT there so
 *                      an off-site copy exists (S3 presigned URL, Backblaze, a
 *                      NAS webhook, or your own receiver).
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB = process.env.POS_DB || path.join(__dirname, '..', 'data', 'pos.db');
const KEEP = Number(process.env.POS_BACKUP_KEEP ?? 14);
const WEBHOOK = process.env.POS_BACKUP_WEBHOOK || '';
const BACKUP_DIR = process.env.POS_BACKUP_DIR || path.join(__dirname, '..', 'backups');

if (!fs.existsSync(DB)) {
  console.error('No database at ' + DB + ' — has the server been started at least once?');
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const dest = process.argv[2] ? path.resolve(process.argv[2]) : path.join(BACKUP_DIR, `pos-${stamp}.db`);
fs.mkdirSync(path.dirname(dest), { recursive: true });

const src = new Database(DB, { readonly: true });

async function pushOffSite(file) {
  if (!WEBHOOK) return;
  const body = fs.readFileSync(file);
  const name = path.basename(file);
  try {
    const res = await fetch(WEBHOOK, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Backup-Name': name },
      body
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    console.log(`  off-site copy pushed to webhook (${(body.length / 1024).toFixed(0)} KB)`);
  } catch (e) {
    /* A failed remote copy must not look like a successful backup */
    console.error('  WARNING: off-site push failed — ' + e.message);
    console.error('  The local backup is intact, but you have no off-site copy.');
    process.exitCode = 1;
  }
}

/* Drop the -wal/-shm sidecars: once the copy is closed cleanly the .db is
   self-contained, and leaving them behind litters the backup directory. */
function stripSidecars(file) {
  for (const ext of ['-wal', '-shm']) {
    try { fs.unlinkSync(file + ext); } catch {}
  }
}

function rotate() {
  if (!KEEP) return;
  const files = fs.readdirSync(BACKUP_DIR)
    .filter((f) => /^pos-.*\.db$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const old of files.slice(KEEP)) {
    const full = path.join(BACKUP_DIR, old.f);
    fs.unlinkSync(full);
    stripSidecars(full);            // remove the matching -wal/-shm too
    console.log(`  rotated out ${old.f}`);
  }
  /* sweep any orphaned sidecars whose .db is already gone */
  for (const f of fs.readdirSync(BACKUP_DIR)) {
    if (!/\.db-(wal|shm)$/.test(f)) continue;
    if (!fs.existsSync(path.join(BACKUP_DIR, f.replace(/-(wal|shm)$/, '')))) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch {}
    }
  }
}

src.backup(dest)
  .then(async () => {
    /* verify the copy is a readable database, not a truncated file */
    const chk = new Database(dest, { readonly: true });
    const integrity = chk.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error('Backup integrity_check failed: ' + integrity);
    const orders = chk.prepare('SELECT COUNT(*) c FROM orders').get().c;
    const items = chk.prepare('SELECT COUNT(*) c FROM menu_items').get().c;
    chk.close();
    stripSidecars(dest);
    const kb = Math.round(fs.statSync(dest).size / 1024);
    console.log(`Backup written: ${dest}`);
    console.log(`  ${kb} KB · ${orders} orders · ${items} menu items · verified readable`);
    rotate();
    await pushOffSite(dest);
  })
  .catch((e) => { console.error('Backup failed:', e.message); process.exit(1); })
  .finally(() => src.close());
