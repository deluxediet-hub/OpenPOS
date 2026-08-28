'use strict';
/* Static architecture contracts for the incremental server split. */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const files = (dir) => fs.readdirSync(path.join(root, dir)).filter((x) => x.endsWith('.js')).map((x) => `${dir}/${x}`);
let pass = 0, fail = 0;
const ck = (name, ok, detail = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ FAIL ' + name + (detail ? '  ' + detail : '')); }
};

console.log('\n=== server module structure ===\n');
const server = read('server.js');
const routes = files('routes');
const services = files('services');
const allRouteSource = [server, ...routes.map(read)].join('\n');
const declarations = (allRouteSource.match(/app\.(?:get|post|put|patch|delete)\(/g) || []).length;
const countEndpoint = (fragment) => (allRouteSource.match(new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;

ck('server.js is a compact composition root', server.split('\n').length < 400, `${server.split('\n').length} lines`);
ck('route declaration count matches the operations API expansion', declarations === 135, String(declarations));
ck('authentication route module exists', routes.includes('routes/auth.js'));
ck('payment and return route modules exist', routes.includes('routes/payments.js') && routes.includes('routes/returns.js'));
ck('inventory/purchase/stocktake modules exist', routes.includes('routes/inventory.js') && routes.includes('routes/purchases.js') && routes.includes('routes/stocktakes.js'));
ck('report and shift modules exist', routes.includes('routes/reports.js') && routes.includes('routes/shifts.js'));
ck('printing route module exists', routes.includes('routes/printing.js'));
ck('close-out service exists', services.includes('services/sale-closeout.js'));
ck('reconciliation service exists', services.includes('services/reconciliation.js'));
ck('retail till service exists', services.includes('services/retail-till.js'));
ck('structured inventory ledger service exists', services.includes('services/inventory-ledger.js'));
ck('backup operations service exists',services.includes('services/backup-operations.js'));
ck('payment endpoint is registered exactly once', countEndpoint("'/api/orders/:id/pay'") === 1);
ck('return endpoint is registered exactly once', countEndpoint("'/api/orders/:id/refund'") === 1);
ck('shift close endpoint is registered exactly once', countEndpoint("'/api/shifts/:id/close'") === 1);
ck('receipt print endpoint is registered exactly once', countEndpoint("'/api/print/receipt/:id'") === 1);
ck('route modules do not import server.js', routes.every((file) => !/require\(['"]\.\.\/server/.test(read(file))));
ck('server still exports the Express app', /module\.exports\s*=\s*app/.test(server));
const assets=path.join(root,'public','assets');
ck('legacy manager2 bundle is removed',!fs.existsSync(path.join(assets,'manager2.js')));
ck('manager responsibilities are split into focused modules',
  ['manager-pricing.js','manager-reconciliation.js','manager-hospitality.js','manager-loyalty.js','manager-system.js']
    .every((file)=>fs.existsSync(path.join(assets,file))));
ck('retail manager hides loyalty from active navigation',/children=children\.filter\(\(\[id\]\)=>id==='drawer'\)/.test(read('public/assets/manager.js')));
ck('retail checkout conditionally removes tip controls',/retail\?'':`<div class="tline"><span>Tip/.test(read('public/assets/cashier.js')));

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail ? 1 : 0);
