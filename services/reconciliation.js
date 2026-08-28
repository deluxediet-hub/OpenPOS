'use strict';

/** Collects the immutable shift ledger facts used by till reconciliation. Pure
 * status/classification math remains unchanged and will move to domain.js in the
 * dedicated reconciliation phase. */
module.exports = function createReconciliationService({ db, domain, nowLocal }) {
  function drawerFigures(shift) {
    const from = shift.opened_at;
    const to = shift.closed_at || nowLocal();
    const value = (sql, ...params) => db.prepare(sql).get(...params).v || 0;
    const funding = (method) => value(`SELECT COALESCE(SUM(amount),0) v FROM gift_card_funding
      WHERE method=? AND shift_id=? AND created_at BETWEEN ? AND ?`, method, shift.id, from, to);
    const cashSales = value(`SELECT COALESCE(SUM(amount),0) v FROM payments
      WHERE method='cash' AND kind='sale' AND shift_id=? AND created_at BETWEEN ? AND ?`, shift.id, from, to) + funding('cash');
    const mpesaSales = value(`SELECT COALESCE(SUM(amount),0) v FROM payments
      WHERE method='mpesa' AND kind='sale' AND shift_id=? AND created_at BETWEEN ? AND ?`, shift.id, from, to) + funding('mpesa');
    const cardSales = value(`SELECT COALESCE(SUM(amount),0) v FROM payments
      WHERE method='card' AND kind='sale' AND shift_id=? AND created_at BETWEEN ? AND ?`, shift.id, from, to) + funding('card');
    const cashRefunds = -value(`SELECT COALESCE(SUM(amount),0) v FROM payments
      WHERE method='cash' AND kind='refund' AND shift_id=? AND created_at BETWEEN ? AND ?`, shift.id, from, to);
    const cashExpenses = value(`SELECT COALESCE(SUM(amount),0) v FROM cash_payouts
      WHERE shift_id=? AND method='cash' AND created_at BETWEEN ? AND ?`, shift.id, from, to);
    const mpesaExpenses = value(`SELECT COALESCE(SUM(amount),0) v FROM cash_payouts
      WHERE shift_id=? AND method='mpesa' AND created_at BETWEEN ? AND ?`, shift.id, from, to);
    const expected = domain.expectedTender({ opening:shift.opening_float, sales:cashSales, refunds:cashRefunds, expenses:cashExpenses });
    const mpesaRefunds = -value(`SELECT COALESCE(SUM(amount),0) v FROM payments
      WHERE method='mpesa' AND kind='refund' AND shift_id=?`, shift.id);
    const cardRefunds = -value(`SELECT COALESCE(SUM(amount),0) v FROM payments
      WHERE method='card' AND kind='refund' AND shift_id=?`, shift.id);
    const expectedMpesa = domain.expectedTender({opening:shift.opening_mpesa,sales:mpesaSales,refunds:mpesaRefunds,expenses:mpesaExpenses});
    const expectedCard = domain.expectedTender({opening:shift.opening_card,sales:cardSales,refunds:cardRefunds});
    return {
      cash_sales: cashSales, mpesa_sales: mpesaSales, card_sales: cardSales,
      cash_refunds: cashRefunds, mpesa_refunds: mpesaRefunds, card_refunds: cardRefunds,
      payouts: cashExpenses + mpesaExpenses, cash_expenses: cashExpenses, mpesa_expenses: mpesaExpenses,
      expected, expected_mpesa: expectedMpesa, expected_card: expectedCard
    };
  }

  return { drawerFigures };
};
