'use strict';

/** Staff account routes. PIN hashing and last-admin protections are unchanged. */
module.exports = function register(app, {
  db, requireAuth, requireRole, hashPin, pinTaken, audit, broadcast, bad
}) {
  /* --------------------------------- staff -------------------------------- */
  /* PINs are stored as scrypt hashes and are never returned by list/detail calls.
     The plaintext is echoed exactly once — on the create/update response — so the
     manager can write it down, mirroring the gift-card code pattern. */
  const reveal = (row, pin) => ({ id: row.id, name: row.name, role: row.role, active: row.active,
    hourly_rate: row.hourly_rate, pin });

  app.get('/api/users', requireAuth, requireRole('manager', 'admin'), (req, res) =>
    res.json(db.prepare('SELECT id,name,role,active,hourly_rate FROM users ORDER BY role,name')
      .all().map((u) => ({ ...u, has_pin: true }))));

  app.post('/api/users', requireAuth, requireRole('manager', 'admin'), (req, res) => {
    const { name, pin, role } = req.body;
    if (!name || !pin || !role) return bad(res, 'Name, PIN and role required');
    const allowedRoles = ['seller', 'admin', 'manager', 'waiter', 'cashier', 'bartender', 'kitchen'];
    if (!allowedRoles.includes(role)) return bad(res, 'Unknown role');
    if (role === 'admin' && req.user.role !== 'admin') return bad(res, 'Only an admin can create another admin', 403);
    if (!/^\d{4,6}$/.test(String(pin))) return bad(res, 'PIN must be 4-6 digits');
    if (pinTaken(String(pin))) return bad(res, 'That PIN is already in use');
    const r = db.prepare('INSERT INTO users(name,pin,role) VALUES(?,?,?)').run(name.trim(), hashPin(String(pin)), role);
    audit(req.user, 'user.create', `${name} (${role})`);
    broadcast('users');
    res.json(reveal(db.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid), String(pin)));
  });

  app.put('/api/users/:id', requireAuth, requireRole('manager', 'admin'), (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
    if (!u) return bad(res, 'Not found', 404);
    let newPin = null;
    if (req.body.pin != null && String(req.body.pin).trim() !== '') {
      newPin = String(req.body.pin).trim();
      if (!/^\d{4,6}$/.test(newPin)) return bad(res, 'PIN must be 4-6 digits');
      if (pinTaken(newPin, u.id)) return bad(res, 'That PIN is already in use');
    }
    const nextRole = req.body.role ?? u.role;
    if (!['seller', 'admin', 'manager', 'waiter', 'cashier', 'bartender', 'kitchen'].includes(nextRole))
      return bad(res, 'Unknown role');
    if ((u.role === 'admin' || nextRole === 'admin') && req.user.role !== 'admin')
      return bad(res, 'Only an admin can manage administrator accounts', 403);
    const nextActive=req.body.active!=null?(req.body.active?1:0):u.active;
    if(u.role==='admin' && (nextRole!=='admin'||!nextActive) && db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND active=1").get().c<=1)
      return bad(res,'You cannot disable or demote the last active admin');
    db.prepare('UPDATE users SET name=?, pin=?, role=?, active=? WHERE id=?')
      .run(req.body.name ?? u.name, newPin ? hashPin(newPin) : u.pin, nextRole,
        req.body.active != null ? (req.body.active ? 1 : 0) : u.active, u.id);
    audit(req.user, 'user.update', u.name + (newPin ? ' (PIN changed)' : ''));
    broadcast('users');
    res.json(reveal(db.prepare('SELECT * FROM users WHERE id=?').get(u.id), newPin));
  });

  app.delete('/api/users/:id', requireAuth, requireRole('admin'), (req, res) => {
    if (Number(req.params.id) === req.user.id) return bad(res, 'You cannot remove yourself');
    db.prepare('UPDATE users SET active=0 WHERE id=?').run(req.params.id);
    audit(req.user, 'user.disable', String(req.params.id));
    broadcast('users');
    res.json({ ok: true });
  });
};
