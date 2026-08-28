'use strict';

/** Retail sales require one open shared till. Owner auto-open behavior is preserved. */
module.exports = function createRetailTillService({ db, audit, broadcast }) {
  return function ensureRetailTill(user) {
    const active = db.prepare("SELECT * FROM shifts WHERE status IN ('open','reconciling') ORDER BY id DESC LIMIT 1").get();
    if (active) return active.status === 'open' ? active : null;
    if (!['admin', 'manager'].includes(user.role)) return null;
    const id = db.prepare("INSERT INTO shifts(opened_by,opening_float,opening_mpesa,notes) VALUES(?,0,0,'Automatically opened for owner sale')")
      .run(user.id).lastInsertRowid;
    audit(user, 'shift.auto_open', 'Owner started sale with zero opening Cash/M-Pesa balances');
    broadcast('sales');
    return db.prepare('SELECT * FROM shifts WHERE id=?').get(id);
  };
};
