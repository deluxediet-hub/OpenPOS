'use strict';
/**
 * Test runner — spawns its own server on a private port with its own throwaway
 * SQLite file, so the suite is deterministic and never touches the preview DB.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

/* A per-run base port so this run can never collide with an orphaned server left
   behind by a previously-crashed run (which would shadow us and serve a stale DB). */
const PORT = process.env.TEST_PORT || (4100 + (process.pid % 400));
const BASE = `http://127.0.0.1:${PORT}`;
const servers = [];
process.on('exit', () => { for (const s of servers) { try { s.kill('SIGKILL'); } catch {} } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUp(base, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const r = await fetch(base + '/healthz');
      if (r.ok) return true;
    } catch {}
    await sleep(150);
  }
  return false;
}

function runSuite(file, base) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, file)], {
      env: { ...process.env, BASE: base, TZ: process.env.TEST_TZ || 'Africa/Nairobi' }, stdio: 'inherit'
    });
    child.on('exit', (code) => resolve(code || 0));
  });
}

(async () => {
  const suites = ['domain.js', 'packaging.js', 'structure.js', 'retail.js', 'hardening.js', 'inventory-packages.js', 'reconciliation.js', 'operations.js', 'e2e.js', 'features.js', 'ui.js'];
  let code = 0;

  for (const suite of suites) {
    /* Every suite gets its own server AND its own database — sharing one DB made
       later suites inherit leftover orders from earlier ones. */
    const db = path.join(os.tmpdir(), `pos-test-${process.pid}-${suite}.db`);
    const backupDir=path.join(os.tmpdir(),`pos-backups-${process.pid}-${suite}`);
    const port = Number(PORT) + suites.indexOf(suite);
    const base = `http://127.0.0.1:${port}`;

    for (const f of [db, db + '-wal', db + '-shm']) { try { fs.unlinkSync(f); } catch {} }
    try{fs.rmSync(backupDir,{recursive:true,force:true});}catch{}

    if (['domain.js', 'packaging.js', 'structure.js'].includes(suite)) {
      /* pure/static tests — no server needed */
      code = await runSuite(suite, base);
      if (code) break;
      continue;
    }

    const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      /* Pin a non-UTC zone. Running the suite in UTC hides every local-vs-UTC
         timestamp mismatch, because the two formats happen to agree there. */
      env: { ...process.env, PORT: String(port), POS_DB: db, POS_BACKUP_DIR:backupDir,
        TZ: process.env.TEST_TZ || 'Africa/Nairobi' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    servers.push(server);
    let bootErr = '';
    server.stdout.on('data', () => {});
    server.stderr.on('data', (d) => { bootErr += d; });

    const up = await waitUp(base);
    if (!up) {
      console.error(`\nTest server for ${suite} failed to start on port ${port}`);
      if (bootErr) console.error(bootErr);
      server.kill('SIGKILL');
      code = 2;
      break;
    }

    /* First-run onboarding: creates the owner and (for realism) loads the sample
       menu, so the suites exercise a fully-populated business. */
    const setupRes = await fetch(base + '/api/setup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        business: { business_name: ['retail.js','hardening.js','inventory-packages.js','reconciliation.js','operations.js'].includes(suite) ? 'Test Wines & Spirits' : 'Test Cafe', address: '1 Test Way',
          phone: '+254700000000', kra_pin: 'P000000000T', ...(['retail.js','hardening.js','inventory-packages.js','reconciliation.js','operations.js'].includes(suite) ? { business_type: 'wines_spirits' } : {}) },
        owner_name: 'Owner', owner_pin: '0000', sample: true
      })
    });
    if (!setupRes.ok && setupRes.status !== 400) {
      console.error('setup failed', setupRes.status, await setupRes.text());
      server.kill('SIGTERM'); process.exit(2);
    }

    code = await runSuite(suite, base);
    server.kill('SIGTERM');
    await sleep(150);
    for (const f of [db, db + '-wal', db + '-shm']) { try { fs.unlinkSync(f); } catch {} }
    try{fs.rmSync(backupDir,{recursive:true,force:true});}catch{}
    if (code) break;
  }

  process.exit(code);
})();
