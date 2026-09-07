'use strict';
// ---------------------------------------------------------------------------
// linkaudit.js — does every door in the app open? (Phase 35, machine half)
//
// A pilot shop hits a dead link in week one and quietly stops trusting the
// product. This walks every href, src and fetch() in the shipped pages and
// checks each one against the routes the server actually registers. It says
// which doors are real, which are dynamic (so a machine cannot judge them),
// and which simply do not exist.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const VERBS = ['get', 'post', 'put', 'patch', 'delete', 'use'];

/** Routes the server registers, read from its own source. */
function routesFromSource(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = [];
  const re = new RegExp(`app\\.(${VERBS.join('|')})\\(\\s*'([^']+)'`, 'g');
  let m;
  while ((m = re.exec(src))) out.push({ method: m[1], path: m[2], line: src.slice(0, m.index).split('\n').length });
  return out;
}

function pathMatches(route, url) {
  const r = route.split('/').filter(Boolean);
  const u = url.split('/').filter(Boolean);
  if (r.length !== u.length) return false;
  return r.every((seg, i) => seg.startsWith(':') || seg === u[i] || (seg.startsWith('*') && seg.length === 1));
}

/**
 * Every internal door a page can open: links, scripts, images and the API
 * paths the JavaScript calls.
 */
function linksFromPage(file) {
  const html = fs.readFileSync(file, 'utf8');
  const found = new Map();
  const add = (raw) => {
    let p = String(raw || '').trim();
    if (!p.startsWith('/')) return;
    if (p.startsWith('//')) return;                 // external
    p = p.split('#')[0].split('?')[0];
    if (!p || p === '/') return;
    if (p.includes('${')) { found.set(p.replace(/\$\{[^}]*\}/g, ':x'), 'dynamic'); return; }
    found.set(p, 'static');
  };
  for (const m of html.matchAll(/(?:href|src|action)="(\/[^"]*)"/g)) add(m[1]);
  // keep `${...}` in the match: a path built at run-time is dynamic, not dead
  for (const m of html.matchAll(/\/(?:api|modules|public)[A-Za-z0-9_\-./${}]*/g)) add(m[0]);
  return found;
}

/**
 * Compare doors to routes. A path that names an existing FILE in public/ is a
 * real door too (pages, scripts, the service worker).
 */
function audit({ publicDir = path.join(__dirname, '..', 'public'), serverFile = path.join(__dirname, '..', 'server.js'), pages = null } = {}) {
  const routes = routesFromSource(serverFile);
  const files = new Set(fs.readdirSync(publicDir));
  const pageList = pages || fs.readdirSync(publicDir).filter((f) => f.endsWith('.html'));
  const dead = [];
  const dynamic = [];
  const ok = [];
  for (const page of pageList) {
    const full = path.join(publicDir, page);
    if (!fs.existsSync(full)) continue;
    for (const [p, kind] of linksFromPage(full)) {
      const bare = p.replace(/^\//, '');
      const isFile = files.has(bare) || fs.existsSync(path.join(publicDir, bare));
      const isRoute = routes.some((r) => pathMatches(r.path, p));
      if (kind === 'dynamic') { dynamic.push({ page, path: p }); continue; }
      if (isFile || isRoute) { ok.push({ page, path: p, by: isFile ? 'file' : 'route' }); continue; }
      dead.push({ page, path: p });
    }
  }
  return {
    pages: pageList,
    routes: routes.length,
    checked: ok.length + dead.length + dynamic.length,
    ok: ok.length,
    dynamic: dynamic.length,
    dead,
    clean: dead.length === 0,
    sentence: dead.length === 0
      ? `${ok.length} doors, all of them open (${dynamic.length} built at run-time and left to the tests).`
      : `${dead.length} door(s) do not open: ${dead.slice(0, 8).map((d) => `${d.page} → ${d.path}`).join('; ')}.`
  };
}

module.exports = { audit, routesFromSource, linksFromPage, pathMatches };
