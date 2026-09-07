'use strict';
// ---------------------------------------------------------------------------
// plans.js — subscriptions, trials and usage limits (Phase 33).
//
// A shop should never be surprised by a bill, and never be locked out of its
// own till without warning. So: a trial that counts its days out loud, limits
// that WARN before they BLOCK, and payment by M-Pesa — the one way every
// Kenyan business already pays.
// ---------------------------------------------------------------------------

const DAY = 864e5;

const PLANS = [
  {
    id: 'solo',
    name: 'Solo',
    sw: 'Duka moja',
    price_month: 0,
    price_year: 0,
    desc: 'One till, one shop, everything that matters. Free forever.',
    swDesc: 'Taa moja, duka moja, kila kitu muhimu. Bure milele.',
    limits: { products: 500, users: 3, branches: 1, locations: 2, registers: 2 }
  },
  {
    id: 'pro',
    name: 'Shop',
    sw: 'Duka',
    price_month: 1500,
    price_year: 15000,
    desc: 'For a busy shop: more staff, more stock, WhatsApp orders and the online store.',
    swDesc: 'Kwa duka lenye shughuli: wafanyakazi zaidi, bidhaa zaidi, oda za WhatsApp na duka la mtandaoni.',
    limits: { products: 5000, users: 10, branches: 3, locations: 6, registers: 10 }
  },
  {
    id: 'chain',
    name: 'Chain',
    sw: 'Minyororo',
    price_month: 4000,
    price_year: 40000,
    desc: 'Many branches, one brain: central reports, transfers and per-branch pricing.',
    swDesc: 'Matawi mengi, akili moja: ripoti kuu, uhamisho na bei kwa kila tawi.',
    limits: { products: 50000, users: 100, branches: 50, locations: 200, registers: 200 }
  }
];

const PAYBILL = { number: process.env.OPENPOS_PAYBILL || '4099881', account_hint: 'your shop code' };

function planOf(id) {
  return PLANS.find((p) => p.id === id) || PLANS[0];
}

/** Where a business stands today: days of trial left, days paid for, blocked? */
function status(biz, now = new Date()) {
  const plan = planOf(biz.plan);
  const trialEnds = biz.trial_ends_at ? new Date(biz.trial_ends_at).getTime() : null;
  const paidUntil = biz.paid_until ? new Date(biz.paid_until).getTime() : null;
  const t = now.getTime();
  const trialDaysLeft = trialEnds ? Math.ceil((trialEnds - t) / DAY) : null;
  const paidDaysLeft = paidUntil ? Math.ceil((paidUntil - t) / DAY) : null;
  const inTrial = trialDaysLeft !== null && trialDaysLeft > 0;
  const paid = paidDaysLeft !== null && paidDaysLeft > 0;
  const free = plan.price_month === 0;
  const graceDays = 7;
  const expiredDays = trialDaysLeft !== null ? Math.max(0, -trialDaysLeft) : 0;
  const blocked = !free && !inTrial && !paid && expiredDays > graceDays;
  return {
    business: biz.id,
    plan: plan.id,
    plan_name: plan.name,
    price_month: plan.price_month,
    price_year: plan.price_year,
    free,
    // money in the bank outranks a countdown: a shop that has paid is paid,
    // even if its 30 trial days are not up yet.
    status: blocked ? 'blocked' : (paid ? 'paid' : (inTrial ? 'trial' : (free ? 'active' : 'grace'))),
    trial_days_left: trialDaysLeft,
    paid_days_left: paidDaysLeft,
    grace_days_left: blocked ? 0 : Math.max(0, graceDays - expiredDays),
    limits: { ...plan.limits, ...(biz.limits || {}) },
    paybill: PAYBILL.number,
    account: biz.id,
    blocked,
    sentence: (() => {
      if (free) return `${plan.name} — free, no bill, no expiry.`;
      if (blocked) return `Payment is overdue by ${expiredDays} day(s). Pay Ksh ${plan.price_month} to Paybill ${PAYBILL.number}, account ${biz.id}, to keep trading.`;
      if (paidDaysLeft !== null && paidDaysLeft > 0) return `${plan.name} — paid up, ${paidDaysLeft} day(s) remaining.`;
      if (inTrial) return `${plan.name} trial — ${trialDaysLeft} day(s) left. After that Ksh ${plan.price_month} a month.`;
      return `${plan.name} payment is past due — ${Math.max(0, graceDays - expiredDays)} day(s) of grace left.`;
    })()
  };
}

/** Usage against the plan: counts, limits and what is close to the edge. */
function usage(counts, limits) {
  const rows = Object.keys(limits).map((k) => {
    const used = Number(counts[k] || 0);
    const limit = Number(limits[k] || 0);
    return {
      metric: k, used, limit,
      pct: limit > 0 ? Math.round((used / limit) * 100) : 0,
      over: limit > 0 && used > limit,
      near: limit > 0 && used >= limit * 0.8
    };
  });
  return {
    rows,
    over: rows.filter((r) => r.over),
    near: rows.filter((r) => r.near && !r.over),
    sentence: rows.some((r) => r.over)
      ? `Over the limit on: ${rows.filter((r) => r.over).map((r) => r.metric).join(', ')}.`
      : (rows.some((r) => r.near)
        ? `Getting close on: ${rows.filter((r) => r.near).map((r) => r.metric).join(', ')}.`
        : 'Within every limit on this plan.')
  };
}

/** Money in: a month (or a year) added from the day the payment lands. */
function applyPayment(biz, { months = 1, amount = 0, ref = '', method = 'mpesa' }, now = new Date()) {
  const plan = planOf(biz.plan);
  const from = biz.paid_until && new Date(biz.paid_until) > now ? new Date(biz.paid_until) : now;
  const until = new Date(from.getTime() + months * 30 * DAY);
  return {
    business: biz.id,
    plan: plan.id,
    amount: Number(amount) || (months >= 12 ? plan.price_year : plan.price_month * months),
    months, ref, method,
    paid_at: now.toISOString(),
    paid_until: until.toISOString(),
    payment: { method, ref, amount: Number(amount) || (months >= 12 ? plan.price_year : plan.price_month * months) }
  };
}

module.exports = { PLANS, PAYBILL, planOf, status, usage, applyPayment };
