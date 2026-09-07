'use strict';
// ---------------------------------------------------------------------------
// segments.js — who to talk to, and why (Phase 24).
//
// Segments are computed, never stored: a shop of 400 customers should not have
// to maintain a list. Each one is a question a shopkeeper actually asks —
// "who has stopped coming?", "who are my best customers?", "who owes me?".
// A campaign is a promotion pointed at one of these answers.
// ---------------------------------------------------------------------------

const LAPSED_DAYS = 60;
const ACTIVE_DAYS = 30;

const SEGMENTS = [
  { id: 'all', label: 'Every customer', sw: 'Wateja wote', desc: 'Anyone with a profile.' },
  { id: 'vip', label: 'Best customers', sw: 'Wateja bora', desc: 'The top 20% by spend over 12 months (at least 3 visits).' },
  { id: 'active', label: 'Regular', sw: 'Wa kawaida', desc: 'Bought in the last 30 days.' },
  { id: 'lapsed', label: 'Lapsed', sw: 'Waliopotea', desc: 'Bought before, nothing in 60 days.' },
  { id: 'new', label: 'New', sw: 'Wapya', desc: 'First purchase in the last 30 days.' },
  { id: 'deni', label: 'Owes money', sw: 'Wana deni', desc: 'Has an outstanding balance.' },
  { id: 'wholesale', label: 'Wholesale', sw: 'Jumla', desc: 'On the wholesale tier.' },
  { id: 'birthday', label: 'Birthday this month', sw: 'Siku ya kuzaliwa', desc: 'Birthday falls in the current month.' }
];

/** Every customer with the numbers the segments need. */
function stats(d, { branches = null } = {}) {
  const where = branches && branches.length ? `AND (c.branch_id IS NULL OR c.branch_id IN (${branches.map(() => '?').join(',')}))` : '';
  const rows = d.prepare(`
    SELECT c.id, c.name, c.phone, c.tier, c.birthday, c.credit_limit,
           (SELECT COUNT(*) FROM sales s WHERE s.customer_id = c.id AND s.status IN ('paid','partial')) AS visits,
           (SELECT COALESCE(SUM(s.gross), 0) FROM sales s WHERE s.customer_id = c.id AND s.status IN ('paid','partial')) AS spend,
           (SELECT COALESCE(SUM(s.gross), 0) FROM sales s WHERE s.customer_id = c.id AND s.status IN ('paid','partial')
             AND s.created_at >= ?) AS spend_12m,
           (SELECT MAX(s.created_at) FROM sales s WHERE s.customer_id = c.id AND s.status IN ('paid','partial')) AS last_at,
           (SELECT MIN(s.created_at) FROM sales s WHERE s.customer_id = c.id AND s.status IN ('paid','partial')) AS first_at,
           (SELECT COALESCE(SUM(cl.amount), 0) FROM customer_ledger cl WHERE cl.customer_id = c.id) AS ledger
      FROM customers c
     WHERE 1=1 ${where}
     ORDER BY c.id
  `).all(...(branches && branches.length ? [...branches, new Date(Date.now() - 365 * 86400000).toISOString()] : [new Date(Date.now() - 365 * 86400000).toISOString()]));

  const now = Date.now();
  const day = 86400000;
  const withFlags = rows.map((r) => ({
    ...r,
    days_since: r.last_at ? Math.round((now - new Date(r.last_at).getTime()) / day) : null,
    days_since_first: r.first_at ? Math.round((now - new Date(r.first_at).getTime()) / day) : null,
    owes: Number(r.ledger || 0) > 0
  }));

  // VIP: top 20% of 12-month spend among customers with at least 3 visits
  const buyers = withFlags.filter((r) => r.visits >= 3 && r.spend_12m > 0).sort((a, b) => b.spend_12m - a.spend_12m);
  const vipCut = Math.max(1, Math.ceil(buyers.length * 0.2));
  const vip = new Set(buyers.slice(0, vipCut).map((r) => r.id));
  const month = new Date().getMonth() + 1;
  for (const r of withFlags) {
    r.segments = [];
    if (vip.has(r.id)) r.segments.push('vip');
    if (r.last_at && r.days_since <= ACTIVE_DAYS) r.segments.push('active');
    if (r.last_at && r.days_since > LAPSED_DAYS) r.segments.push('lapsed');
    if (r.first_at && r.days_since_first <= ACTIVE_DAYS && r.visits <= 2) r.segments.push('new');
    if (r.owes) r.segments.push('deni');
    if (r.tier === 'wholesale') r.segments.push('wholesale');
    if (r.birthday && Number(String(r.birthday).slice(5, 7)) === month) r.segments.push('birthday');
  }
  return withFlags;
}

/** Is this customer in this segment right now? */
function isIn(d, customerId, segment) {
  if (!segment || segment === 'all') return true;
  const row = stats(d).find((r) => r.id === Number(customerId));
  return !!(row && row.segments.includes(segment));
}

/** Segment → how many customers, and how much they are worth. */
function summary(d, { branches = null } = {}) {
  const rows = stats(d, { branches });
  const out = SEGMENTS.map((s) => {
    const members = s.id === 'all' ? rows : rows.filter((r) => r.segments.includes(s.id));
    return {
      id: s.id, label: s.label, labelSw: s.sw, desc: s.desc,
      customers: members.length,
      spend: members.reduce((t, r) => t + Number(r.spend || 0), 0),
      avg_spend: members.length ? Math.round(members.reduce((t, r) => t + Number(r.spend || 0), 0) / members.length) : 0
    };
  });
  return { rows: out, total: rows.length, members: rows };
}

/** The audience for one segment (for a campaign preview). */
function audience(d, segment, { limit = 200, branches = null } = {}) {
  const rows = stats(d, { branches });
  const members = !segment || segment === 'all' ? rows : rows.filter((r) => r.segments.includes(segment));
  return {
    count: members.length,
    customers: members.slice(0, limit).map((r) => ({
      id: r.id, name: r.name, phone: r.phone, visits: r.visits,
      spend: r.spend, last_at: r.last_at, days_since: r.days_since
    }))
  };
}

module.exports = { SEGMENTS, LAPSED_DAYS, ACTIVE_DAYS, stats, isIn, summary, audience };
