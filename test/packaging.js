'use strict';
/* Packaging invariants — static checks over the Windows packaging assets.
   These guard the appliance guarantees WITHOUT touching the POS application.
   They verify, from the installer/launcher source, that:
     - business data is never written inside the application directory,
     - the launcher is single-instance and headless and uses the bundled runtime,
     - the firewall rule is LAN-only (Private/Domain) on port 3000,
     - update/rollback/uninstall never delete business data by default.
*/
const fs = require('fs');
const path = require('path');
const P = (f) => fs.readFileSync(path.join(__dirname, '..', 'packaging', f), 'utf8');

let pass = 0, fail = 0;
const ck = (n, c, e = '') => {
  if (c) { pass++; console.log('  ✓ ' + n + (e ? '  ' + e : '')); }
  else { fail++; console.log('  ✗ FAIL ' + n + '  ' + e); }
};

console.log('\n=== packaging invariants ===\n');

const vbs = P('assets/start-hidden.vbs');
const portableBat = fs.readFileSync(path.join(__dirname, '..', 'start-pos.bat'), 'utf8');
const portableVbs = fs.readFileSync(path.join(__dirname, '..', 'start-pos-hidden.vbs'), 'utf8');
ck('portable BAT delegates to hidden VBS and exits', /wscript\.exe/i.test(portableBat) && /start-pos-hidden\.vbs/i.test(portableBat) && /exit \/b 0/i.test(portableBat));
ck('portable hidden launcher uses window style 0', /shell\.Run [^\n]*,\s*0,\s*False/i.test(portableVbs));
ck('portable launcher keeps a startup log', /logs\\start-pos\.log/i.test(portableBat));
ck('launcher writes DB outside the app dir (ProgramData)', /%ProgramData%\\OpenPOS|ProgramData.*OpenPOS/i.test(vbs) && /POS_DATA_DIR/.test(vbs));
ck('launcher never points POS_DATA_DIR at the app folder', !/POS_DATA_DIR"\)\s*=\s*(appdir|base)\b/.test(vbs));
ck('launcher is headless (hidden window flag 0)', /sh\.Run [^\n]*,\s*0,\s*False/.test(vbs));
ck('launcher uses the bundled runtime, not system node', /runtime\\node\.exe/.test(vbs));
ck('launcher is single-instance (health check before start)', /healthz/.test(vbs) && /ServerUp/.test(vbs) && /Quit 0/.test(vbs));

const init = P('assets/init-data.ps1');
ck('init creates data/spool/backups under ProgramData', /ProgramData/.test(init) && /data/.test(init) && /spool/.test(init) && /app-backups/.test(init));
ck('init uses a junction so spool survives updates', /mklink \/J/.test(init));
ck('init is create-only (no Remove/Delete of data)', !/Remove-Item|Del\b/.test(init));

const fw = P('assets/allow-lan-access.ps1');
ck('firewall rule targets port 3000', /LocalPort 3000/.test(fw));
ck('firewall restricted to Private/Domain (not Public)', /Private,Domain/.test(fw) && !/Profile\s+(Any|Public)/.test(fw));
ck('firewall requires elevation', /RunAsAdministrator/.test(fw));

const iss = P('openpos.iss');
ck('installer does not create a data dir inside the app', !/\{app\}\\data/.test(iss));
ck('installer places persistent data in ProgramData', /commonappdata/.test(iss));
ck('installer wires single-instance hidden auto-start', /userstartup.*start-hidden\.vbs/.test(iss.replace(/\n/g, ' ')) );
ck('installer runs init-data before first start', /init-data\.ps1/.test(iss));
ck('installer removes only the spool junction on uninstall', /rmdir [^\n]*app\\spool/.test(iss) && !/DelTree\(ExpandConstant\('\{app\}'\)/.test(iss));
ck('uninstall keeps data by default (explicit confirm to delete)', /Keep your business data/.test(iss) && /DelTree\(ExpandConstant\('\{commonappdata\}\\OpenPOS'\)/.test(iss));
ck('installer registers watchdog + daily backup tasks', /OpenPOS Watchdog/.test(iss) && /OpenPOS Daily Backup/.test(iss) && /\/mo 5/.test(iss) && /\/sc daily/.test(iss));
ck('uninstall removes both scheduled tasks', (iss.match(/\/delete \/tn ""OpenPOS (Watchdog|Daily Backup)""/g) || []).length === 2);

const upd = P('assets/update-app.ps1');
const rb  = P('assets/rollback-app.ps1');
ck('update backs up to ProgramData, not the app dir', /ProgramData/.test(upd));
ck('update copies code only (no data/spool deletes)', !/Remove-Item[^\n]*(data|spool)/i.test(upd));
ck('update never touches the database file', !/pos\.db/.test(upd) || !/Remove|Delete/i.test(upd));
ck('rollback restores from ProgramData backups', /ProgramData/.test(rb) && /app-backups/.test(rb));

const stop = P('assets/stop-server.ps1');
ck('stop targets only the OpenPOS node process', /node\.exe/.test(stop) && /server\.js/.test(stop));

const wd  = P('assets/watchdog.vbs');
ck('watchdog restarts only when the server is down', /healthz/.test(wd) && /start-hidden\.vbs/.test(wd) && /ServerUp/.test(wd));
const rbk = P('assets/run-backup.ps1');
ck('scheduled backup targets ProgramData DB and backup directory', /ProgramData/.test(rbk) && /POS_DB/.test(rbk) && /POS_BACKUP_DIR/.test(rbk) && /OpenPOS\\backups/.test(rbk));
ck('scheduled backup uses the bundled runtime + app backup.js', /runtime\\node\.exe/.test(rbk) && /backup\.js/.test(rbk));
ck('scheduled backup keeps a bounded number of copies', /POS_BACKUP_KEEP/.test(rbk));
const verifyBackup=fs.readFileSync(path.join(__dirname,'..','scripts','verify-backup.js'),'utf8');
ck('restore drill runs SQLite integrity_check and checks core tables', /integrity_check/.test(verifyBackup) && /missing tables/.test(verifyBackup));
ck('installer exposes owner-facing backup verification shortcut', /Verify latest backup/.test(iss) && fs.existsSync(path.join(__dirname,'..','packaging','assets','verify-latest-backup.ps1')));

const build = P('build-installer.ps1');
ck('build bundles the Windows native better-sqlite3 via npm once', /install --omit=dev/.test(build) && /node_modules/.test(build));
ck('build bundles the private node runtime', /node\.exe/.test(build) && /win-x64/.test(build));
ck('build copies the app byte-for-byte (no transformation)', /'server\.js'/.test(build) && /Copy-Item/.test(build) && !/transform/i.test(build));

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail ? 1 : 0);
