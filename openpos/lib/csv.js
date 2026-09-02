'use strict';
// ---------------------------------------------------------------------------
// csv.js — tiny RFC-4180-ish CSV serializer/parser (no dependencies).
// Used by the product engine's import/export (Phase 3).
// ---------------------------------------------------------------------------

function escapeField(v) {
  const s = v === null || v === undefined ? '' : String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** Serialize rows (array of objects) with the given columns. */
function toCsv(columns, rows) {
  const lines = [columns.join(',')];
  for (const r of rows) {
    lines.push(columns.map((c) => escapeField(r[c])).join(','));
  }
  return lines.join('\r\n');
}

/**
 * Parse CSV text into { headers, rows } (rows = array of objects keyed by header).
 * Handles quoted fields, escaped quotes, \n and \r\n line endings.
 */
function fromCsv(text) {
  const src = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === '') { inQuotes = true; i++; continue; }
    if (ch === ',') { pushField(); i++; continue; }
    if (ch === '\n') { pushRow(); i++; continue; }
    field += ch; i++;
  }
  if (field !== '' || row.length) pushRow();
  if (!rows.length) return { headers: [], rows: [] };
  const headers = rows[0].map((h) => h.trim());
  const out = [];
  for (const r of rows.slice(1)) {
    if (r.every((c) => String(c).trim() === '')) continue;
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = r[idx] !== undefined ? r[idx] : ''; });
    out.push(obj);
  }
  return { headers, rows: out };
}

module.exports = { toCsv, fromCsv };
