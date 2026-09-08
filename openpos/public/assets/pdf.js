'use strict';
// ---------------------------------------------------------------------------
// pdf.js — a small PDF writer, and the only one the shop needs.
//
// Why hand-rolled: a shop in Kisumu may have no internet the day the owner
// needs a report, so nothing here downloads a library. It writes a plain
// PDF 1.4 file (A4, Helvetica, text, rules and shaded bands) — enough for a
// sales report, a stock count or a customer statement that has to survive
// being emailed, printed and read by an accountant.
//
// Everything outside ASCII is folded to its nearest ASCII shape rather than
// dropped, so "Ksh 1,200" and Swahili text survive; a glyph we truly cannot
// write becomes "?" rather than corrupting the file.
// ---------------------------------------------------------------------------
(function (global) {
  // ---- text metrics: Helvetica and Helvetica-Bold, in 1/1000 em ------------
  function table(pairs) {
    const t = new Array(127).fill(500);
    for (const [ch, w] of pairs) t[ch.charCodeAt(0)] = w;
    return t;
  }
  const PUNCT = [
    [' ', 278], ['!', 278], ['"', 355], ['#', 556], ['$', 556], ['%', 889], ['&', 667],
    ["'", 191], ['(', 333], [')', 333], ['*', 389], ['+', 584], [',', 278], ['-', 333],
    ['.', 278], ['/', 278], [':', 278], [';', 278], ['<', 584], ['=', 584], ['>', 584],
    ['?', 556], ['@', 1015], ['[', 278], ['\\', 278], [']', 278], ['^', 469], ['_', 556],
    ['`', 333], ['{', 334], ['|', 260], ['}', 334], ['~', 584]
  ];
  const UP = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const UP_R = [667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611];
  const UP_B = [722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611];
  const LO = 'abcdefghijklmnopqrstuvwxyz';
  const LO_R = [556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500];
  const LO_B = [556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500];

  const REG = table(PUNCT);
  const BOLD = table(PUNCT.map(([c, w]) => [c, w]));
  for (let i = 0; i < 10; i++) { REG[48 + i] = 556; BOLD[48 + i] = 556; }
  for (let i = 0; i < 26; i++) {
    REG[UP.charCodeAt(i)] = UP_R[i]; BOLD[UP.charCodeAt(i)] = UP_B[i];
    REG[LO.charCodeAt(i)] = LO_R[i]; BOLD[LO.charCodeAt(i)] = LO_B[i];
  }
  // the few widths that differ in bold
  BOLD[33] = 333; BOLD[34] = 474; BOLD[38] = 722; BOLD[39] = 238; BOLD[58] = 333; BOLD[59] = 333;
  BOLD[63] = 611; BOLD[64] = 975; BOLD[91] = 333; BOLD[93] = 333; BOLD[94] = 584; BOLD[123] = 389;
  BOLD[124] = 280; BOLD[125] = 389;

  function widthOf(str) {
    let w = 0;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      w += c < 127 ? REG[c] : 556;
    }
    return w;
  }
  function widthOfBold(str) {
    let w = 0;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      w += c < 127 ? BOLD[c] : 556;
    }
    return w;
  }
  const measure = (str, size, bold) => (bold ? widthOfBold(str) : widthOf(str)) * size / 1000;

  // ---- characters a WinAnsi font can actually draw -------------------------
  const FOLD = {
    '—': '-', '–': '-', '−': '-', '·': '.', '•': '.', '’': "'", '‘': "'",
    '“': '"', '”': '"', '×': 'x', '≈': '~', '✓': 'Y', '✗': 'x', '≥': '>=',
    '≤': '<=', ' ': ' ', '…': '...'
  };
  function fold(str) {
    let out = '';
    for (const ch of String(str == null ? '' : str)) {
      if (ch in FOLD) out += FOLD[ch];
      else if (ch.charCodeAt(0) < 127) out += ch;
      else out += '?';
    }
    return out;
  }
  function esc(str) {
    return fold(str).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  }
  function rgb(hex) {
    const h = String(hex || '#000').replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    if (!isFinite(n)) return '0 0 0';
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
      .map((v) => Math.round(v * 1000) / 1000).join(' ');
  }
  const px = (n) => (Math.round(n * 100) / 100).toFixed(2);
  function ellipsize(str, size, bold, maxWidth) {
    const s = fold(str);
    if (measure(s, size, bold) <= maxWidth) return s;
    let out = s;
    while (out.length > 1 && measure(out + '...', size, bold) > maxWidth) out = out.slice(0, -1);
    return out + '...';
  }

  const INK = '#12211a';
  const MUTED = '#5b6b60';
  const LINE = '#d3ddd6';
  const BAND = '#eef4f0';
  const BRAND = '#0a6b3a';

  // -------------------------------------------------------------------------
  function doc(opts) {
    const o = opts || {};
    const landscape = o.landscape === true;
    const PW = landscape ? 841.89 : 595.28;
    const PH = landscape ? 595.28 : 841.89;
    const M = o.margin || 42;
    const contentWidth = PW - M * 2;
    const ops = [];
    const pages = [];
    let y = M;

    const push = (s) => ops.push(s);

    function newPage() {
      if (ops.length) pages.push(ops.join('\n'));
      ops.length = 0;
      y = M;
    }
    function need(h) {
      if (y + h > PH - M - 18) newPage();
    }

    function rect(x, yTop, w, h, fill) {
      push(`${rgb(fill)} rg ${px(x)} ${px(PH - yTop - h)} ${px(w)} ${px(h)} re f`);
    }
    function hline(x, yTop, w, color, thick) {
      push(`${rgb(color)} RG ${px(thick || 0.6)} w ${px(x)} ${px(PH - yTop)} m ${px(x + w)} ${px(PH - yTop)} l S`);
    }
    function textIn(str, x, w, yTop, o) {
      const size = o.size || 9.5;
      const bold = !!o.bold;
      const align = o.align || 'left';
      const pad = o.pad == null ? 5 : o.pad;
      const value = ellipsize(str, size, bold, w - pad * 2);
      const tw = measure(value, size, bold);
      let x0 = x + pad;
      if (align === 'right') x0 = x + w - pad - tw;
      else if (align === 'center') x0 = x + (w - tw) / 2;
      const baseline = yTop + size * 0.78;
      push(`${rgb(o.color || INK)} rg BT /${bold ? 'F2' : 'F1'} ${px(size)} Tf ${px(x0)} ${px(PH - baseline)} Tm (${esc(value)}) Tj ET`);
    }

    // ------------------------------------------------------------ heading --
    function heading(title, subtitle) {
      newPage();
      rect(0, 0, PW, 6, BRAND);
      y = M + 8;
      textIn(title || 'Report', M, contentWidth, y, { size: 17, bold: true, pad: 0 });
      y += 22;
      if (subtitle) {
        textIn(subtitle, M, contentWidth, y, { size: 10, color: MUTED, pad: 0 });
        y += 15;
      }
      hline(M, y - 4, contentWidth, LINE, 0.8);
      y += 8;
    }

    /** meta: [[label, value], ...] drawn as a tidy two-column block */
    function meta(pairs) {
      const rows = pairs.filter((p) => p && p[1] != null && String(p[1]) !== '');
      if (!rows.length) return;
      const labelW = 96;
      need(rows.length * 14 + 8);
      rect(M, y, contentWidth, rows.length * 14 + 8, '#f7faf8');
      y += 5;
      for (const [k, v] of rows) {
        textIn(k, M, labelW, y, { size: 9, color: MUTED });
        textIn(v, M + labelW, contentWidth - labelW, y, { size: 9.5, bold: true, pad: 0 });
        y += 14;
      }
      y += 9;
    }

    function note(str) {
      if (!str) return;
      need(20);
      textIn(str, M, contentWidth, y, { size: 9, color: MUTED, pad: 0 });
      y += 16;
    }

    // -------------------------------------------------------------- table --
    function table(columns, rows, o) {
      const topts = o || {};
      const cols = (columns || []).map((c) => (typeof c === 'string'
        ? { title: c, align: 'left' }
        : { title: c.title, align: c.align || 'left' }));
      if (!cols.length) return;
      const body = rows || [];
      const totals = topts.totals || null;

      const pad = 6;
      const wanted = cols.map((c, i) => {
        let max = measure(fold(c.title), 9, true);
        for (const r of body) max = Math.max(max, measure(fold(r && r[i] != null ? r[i] : ''), 9.5, false));
        if (totals) max = Math.max(max, measure(fold(totals[i] != null ? totals[i] : ''), 9.5, true));
        return Math.min(Math.max(52, max + pad * 2 + 4), contentWidth * 0.45);
      });
      const sum = wanted.reduce((a, b) => a + b, 0);
      let widths = sum > contentWidth ? wanted.map((w) => (w * contentWidth) / sum) : wanted.slice();
      const total = widths.reduce((a, b) => a + b, 0);
      if (total < contentWidth) {
        let i = cols.findIndex((c) => c.align !== 'right');
        if (i < 0) i = 0;
        widths[i] += contentWidth - total;
      }

      let drawHead = () => {};
      const drawRow = (cells, o2) => {
        const h = o2.height || 15.5;
        if (y + h > PH - M - 18) { newPage(); drawHead(); }
        if (o2.fill) rect(M, y, contentWidth, h, o2.fill);
        let x = M;
        for (let i = 0; i < cols.length; i++) {
          textIn(cells[i] == null ? '' : cells[i], x, widths[i], y + (h - 10) / 2, {
            size: o2.size || 9.5, bold: !!o2.bold, align: cols[i].align, color: o2.color, pad
          });
          x += widths[i];
        }
        y += h;
      };
      drawHead = () => {
        need(20);
        rect(M, y, contentWidth, 18, BAND);
        let x = M;
        for (let i = 0; i < cols.length; i++) {
          textIn(cols[i].title, x, widths[i], y + 4.5, { size: 9, bold: true, align: cols[i].align, color: '#33413a', pad });
          x += widths[i];
        }
        y += 18;
        hline(M, y, contentWidth, LINE, 0.7);
      };

      drawHead();
      if (!body.length) {
        drawRow([cols[0].title ? 'Nothing to show for this period' : '', ...cols.slice(1).map(() => '')],
          { fill: null, color: MUTED, bold: false, height: 24 });
      }
      body.forEach((r, idx) => {
        drawRow(r, idx % 2 ? { fill: '#f8fbfa' } : {});
      });
      if (totals) {
        hline(M, y, contentWidth, '#9fb3a6', 0.8);
        drawRow(totals, { bold: true, fill: BAND, height: 17 });
      }
      y += 6;
    }

    // ------------------------------------------------------------- output --
    function build() {
      if (ops.length) pages.push(ops.join('\n'));
      if (!pages.length) pages.push('');

      // page furniture, drawn last so it sits under the content box
      const stamped = pages.map((body, i) => {
        const n = i + 1, of = pages.length;
        const foot = `${rgb(MUTED)} rg BT /F1 8 Tf ${px(M)} ${px(M - 14)} Tm (${esc(o.footer || 'OpenPOS v2')}) Tj ET\n`
          + `${rgb(MUTED)} rg BT /F1 8 Tf ${px(PW - M - measure(`Page ${n} of ${of}`, 8, false))} ${px(M - 14)} Tm (${esc(`Page ${n} of ${of}`)}) Tj ET`
          + `\n${rgb(LINE)} RG 0.5 w ${px(M)} ${px(M - 6)} m ${px(PW - M)} ${px(M - 6)} l S`;
        return body ? `${body}\n${foot}` : foot;
      });

      const objs = [];
      const add = (body) => { objs.push(body); return objs.length; }; // 1-based ids
      const fontReg = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
      const fontBold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
      const resId = add(`<< /Font << /F1 ${fontReg} 0 R /F2 ${fontBold} 0 R >> /ProcSet [/PDF /Text] >>`);
      const pagesId = objs.length + 1 + stamped.length * 2; // placeholder: filled below
      const pageIds = [];
      for (const body of stamped) {
        // every character we write is ASCII, so length == bytes
        const contentId = add(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
        const pageId = add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${px(PW)} ${px(PH)}] /Resources ${resId} 0 R /Contents ${contentId} 0 R >>`);
        pageIds.push(pageId);
      }
      const realPagesId = add(`<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`);
      if (realPagesId !== pagesId) {
        // fix the forward reference now that we know the real object number
        for (const id of pageIds) objs[id - 1] = objs[id - 1].replace(`/Parent ${pagesId} 0 R`, `/Parent ${realPagesId} 0 R`);
      }
      const infoId = add(`<< /Title (${esc(o.title || 'OpenPOS report')}) /Producer (OpenPOS v2) /Creator (OpenPOS v2) >>`);
      const catalogId = add(`<< /Type /Catalog /Pages ${realPagesId} 0 R >>`);

      let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
      const offsets = [];
      objs.forEach((body, i) => {
        offsets.push(out.length);
        out += `${i + 1} 0 obj\n${body}\nendobj\n`;
      });
      const xref = out.length;
      out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
      for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
      out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

      const bytes = new Uint8Array(out.length);
      for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 255;
      return bytes;
    }

    function blob() {
      const bytes = build();
      return new Blob([bytes], { type: 'application/pdf' });
    }

    return { heading, meta, note, table, build, blob, pageWidth: PW, contentWidth };
  }

  // -------------------------------------------------------------------------
  function toBase64(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return typeof btoa === 'function' ? btoa(out) : '';
  }

  function save(bytes, filename) {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const a = document.createElement('a');
    a.download = filename || 'openpos-report.pdf';
    if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
      const url = URL.createObjectURL(blob);
      a.href = url;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch {} }, 4000);
      return true;
    }
    // No object URLs here (an old WebView, say): hand the file over as data.
    const b64 = toBase64(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    if (!b64) return false;
    a.href = `data:application/pdf;base64,${b64}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  }

  /** Read a real <table> on the page into columns and rows. */
  function readTable(el) {
    const table = el && el.tagName === 'TABLE' ? el : el && el.querySelector && el.querySelector('table');
    if (!table) return null;
    const heads = [...table.querySelectorAll('thead th, thead td')].map((th) => th.textContent.trim());
    const body = table.querySelector('tbody') || table;
    const rows = [...body.querySelectorAll('tr')].map((tr) => [...tr.children].map((td) => td.textContent.trim()));
    if (!heads.length) return null;
    // drop columns the reader cannot use: buttons, checkboxes, empty headers
    const keep = heads.map((h, i) => {
      if (!h) return false;
      if (/^(action|actions|\.\.\.|)$/i.test(h)) return false;
      const cells = rows.map((r) => r[i] || '');
      if (!cells.some((c) => c !== '')) return false;
      return true;
    });
    const columns = heads.filter((h, i) => keep[i]).map((h, i) => {
      const idx = heads.map((_, j) => j).filter((j) => keep[j])[i];
      const numeric = rows.filter((r) => (r[idx] || '') !== '')
        .every((r) => /^[-+(]?[$€£]?\s*[\d,.\s]*%?$/.test(r[idx]) && /\d/.test(r[idx]));
      return { title: h, align: numeric && rows.length ? 'right' : 'left' };
    });
    const outRows = rows.map((r) => r.filter((_, i) => keep[i]));
    return { columns, rows: outRows };
  }

  /** Build a report PDF straight off a table the shop is already looking at. */
  function fromTable(o) {
    const src = typeof o.table === 'string' ? document.getElementById(o.table) : o.table;
    const data = o.columns ? { columns: o.columns, rows: o.rows || [] } : readTable(src);
    if (!data) throw new Error('nothing to print');
    const d = doc({ landscape: o.landscape, title: o.title, footer: o.footer });
    d.heading(o.title || 'Report', o.subtitle);
    const meta = [];
    if (o.shop) meta.push(['Shop', o.shop]);
    if (o.range) meta.push(['Period', o.range]);
    meta.push(['Printed', new Date().toLocaleString()]);
    for (const kv of o.meta || []) meta.push(kv);
    d.meta(meta);
    if (o.note) d.note(o.note);
    d.table(data.columns, data.rows, { totals: o.totals });
    return d;
  }

  const api = { doc, save, readTable, fromTable, measure };
  if (global.OP) global.OP.pdf = api;
  global.OpenPosPdf = api;
})(typeof window !== 'undefined' ? window : globalThis);
