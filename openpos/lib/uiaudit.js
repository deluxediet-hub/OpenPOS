'use strict';
// ---------------------------------------------------------------------------
// uiaudit.js — the solo-mode audit (Phase 34, R-C2).
//
// The rule: a one-till duka must never meet the words "branch", "warehouse",
// "supplier", "purchase order" or "price level". Saying "we hid them" is not
// enough — this reads the pages the shop actually loads, strips everything a
// solo business can never reach, and counts what is left. If a word survives,
// it names the file and the line so it can be cut rather than argued about.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

// Words a small shop should never have to read (EN and SW, lower-cased).
const ERP_WORDS = [
  { word: 'branch', sw: ['shamba', 'matawi'] },
  { word: 'warehouse', sw: ['ghala'] },
  { word: 'supplier', sw: ['msambazaji', 'muuzaji wa jumla', 'washirika'] },
  { word: 'purchase order', sw: ['odha ya ununuzi'] },
  { word: 'price level', sw: ['kiwango cha bei'] },
  { word: 'department', sw: ['kitengo'] }
];

// Sections the shell only shows when a capability is on (see TABS in manager.html).
const GATED_SECTION_RE = /<section[^>]*id="tab-(transfers|purchasing|layout|staff|marketing|integrations)"[^>]*>/g;

const VOID_TAGS = new Set(['input', 'br', 'img', 'hr', 'meta', 'link', 'source', 'col']);

/** Blank out the element that starts at `lt` (the index of its '<'). */
/** Blank out `len` chars but keep the newlines, so line numbers survive. */
function blanks(html, from, to) {
  let out = '';
  for (let i = from; i < to; i++) out += html[i] === '\n' ? '\n' : ' ';
  return out;
}

function blankElement(html, lt) {
  const nameMatch = /^<([a-zA-Z0-9-]+)/.exec(html.slice(lt, lt + 40));
  if (!nameMatch) return lt + 1;
  const name = nameMatch[1].toLowerCase();
  if (VOID_TAGS.has(name)) {
    const end = html.indexOf('>', lt);
    return end < 0 ? html.length : end + 1;
  }
  const openRe = new RegExp(`<${name}(\\s|>)`, 'gi');
  const closeRe = new RegExp(`</${name}\\s*>`, 'gi');
  openRe.lastIndex = lt + 1;
  closeRe.lastIndex = lt + 1;
  let depth = 1;
  let cursor = lt + 1;
  while (depth > 0) {
    const nextOpen = openRe.exec(html);
    const nextClose = closeRe.exec(html);
    const openAt = nextOpen && !nextOpen[1].startsWith('/') ? nextOpen.index : Infinity;
    const closeAt = nextClose ? nextClose.index : Infinity;
    if (openAt === Infinity && closeAt === Infinity) return html.length;
    if (openAt < closeAt) { depth++; cursor = openAt + 1; } else { depth--; cursor = closeAt + 1; }
  }
  return cursor;
}

/**
 * The text a real shop can see in this file: no scripts, no styles, none of the
 * sections that only appear when a capability is on, and none of the elements
 * marked `data-cap` / `data-caps` (those are cut at boot by OP.applyCaps).
 */
function visibleText(html) {
  let s = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(GATED_SECTION_RE, (m) => m); // keep positions; cut below
  // cut gated sections
  let out = '';
  let i = 0;
  GATED_SECTION_RE.lastIndex = 0;
  let m;
  while ((m = GATED_SECTION_RE.exec(s))) {
    out += s.slice(i, m.index);
    const end = blankElement(s, m.index);
    out += blanks(s, m.index, end);
    i = end;
    GATED_SECTION_RE.lastIndex = end;
  }
  out += s.slice(i);
  s = out;
  // cut elements the capability pass hides at boot
  const capRe = /data-caps?="/gi;
  let m2;
  while ((m2 = capRe.exec(s))) {
    let lt = s.lastIndexOf('<', m2.index);
    if (lt < 0) continue;
    const end = blankElement(s, lt);
    if (end <= lt) continue;
    s = s.slice(0, lt) + blanks(s, lt, end) + s.slice(end);
    capRe.lastIndex = lt;
  }
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{2,}/g, '\n');
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

/**
 * Audit one page. Returns the ERP words still visible to a solo business,
 * with the line numbers, so they can be cut rather than argued about.
 */
function auditPage(file) {
  const html = fs.readFileSync(file, 'utf8');
  const text = visibleText(html).toLowerCase();
  const hits = [];
  for (const w of ERP_WORDS) {
    const needles = [w.word, ...(w.sw || [])];
    for (const needle of needles) {
      let at = text.indexOf(needle);
      while (at >= 0) {
        // a whole-ish word, not "branch" hiding inside "branches" only counted once
        const before = text[at - 1] || ' ';
        const after = text[at + needle.length] || ' ';
        if (/[a-z]/.test(before) || /[a-z]/.test(after)) { at = text.indexOf(needle, at + 1); continue; }
        hits.push({
          word: w.word, matched: needle,
          line: lineOf(text, at),
          where: text.slice(Math.max(0, at - 60), at + 60).trim()
        });
        at = text.indexOf(needle, at + needle.length);
      }
    }
  }
  return { file: path.basename(file), hits };
}

/**
 * The whole audit: every screen a shop can open, walked for ERP leakage.
 * `solo` is measured from the business's own capabilities, not assumed.
 */
function soloAudit(caps = {}, dir = path.join(__dirname, '..', 'public')) {
  const solo = !caps.multi_branch && !caps.multi_location && !caps.warehouse &&
    !caps.purchasing && !caps.departments && !caps.price_levels;
  const pages = ['pos.html', 'manager.html']
    .map((f) => path.join(dir, f))
    .filter((f) => fs.existsSync(f))
    .map(auditPage);
  const total = pages.reduce((n, p) => n + p.hits.length, 0);
  return {
    solo,
    capabilities_off: Object.entries(caps).filter(([, v]) => !v).map(([k]) => k),
    pages,
    hits: total,
    clean: total === 0,
    sentence: total === 0
      ? `Solo mode is clean: ${pages.map((p) => p.file).join(' and ')} show a one-till shop no branch, warehouse, supplier, purchase order, price level or department.`
      : `${total} place(s) still talk to a one-till shop like it is a chain: ${pages.flatMap((p) => p.hits.map((h) => `${p.file}:${h.line} "${h.matched}"`)).join('; ')}.`
  };
}

module.exports = { soloAudit, auditPage, visibleText, ERP_WORDS };
