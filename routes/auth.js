'use strict';
const crypto = require('crypto');

/** Authentication route + middleware boundary. Keeps the existing in-memory,
 * cookie-based contract intact while removing session concerns from server.js. */
module.exports = function registerAuth(app, { db, findUserByPin, audit, bad }) {
  const sessions = new Map();
  const attempts = new Map();
  const approvals = new Map();
  const cookie = 'pos_session';
  const sessionMs = 12 * 60 * 60 * 1000;
  const approvalMs = 2 * 60 * 1000;
  const token = () => crypto.randomBytes(24).toString('hex');

  function parseCookies(req) {
    const out = {};
    const raw = req.headers.cookie;
    if (!raw) return out;
    raw.split(';').forEach((part) => {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    });
    return out;
  }

  function currentUser(req) {
    const sessionToken = parseCookies(req)[cookie];
    if (!sessionToken || !sessions.has(sessionToken)) return null;
    const session = sessions.get(sessionToken);
    if (session.expiresAt <= Date.now()) { sessions.delete(sessionToken); return null; }
    return db.prepare('SELECT id,name,role,active FROM users WHERE id=? AND active=1')
      .get(session.user_id) || null;
  }

  function requireAuth(req, res, next) {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: 'Not signed in' });
    req.user = user;
    next();
  }

  const requireRole = (...roles) => (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not signed in' });
    if (roles.includes(req.user.role)) return next();
    const approvalToken=String(req.headers['x-pos-approval']||'');
    const approval=approvals.get(approvalToken);
    approvals.delete(approvalToken); // approval is one-use, including failed attempts
    const sessionToken=parseCookies(req)[cookie];
    if(!approval||approval.expiresAt<=Date.now()||approval.actorId!==req.user.id||approval.sessionToken!==sessionToken||!roles.includes(approval.approver.role))
      return res.status(403).json({ error: 'Permission denied' });
    req.approver=approval.approver;
    audit(req.user,'approval.use',`${approval.approver.name} approved ${req.method} ${req.path}`);
    next();
  };

  app.post('/api/login', (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'local';
    const attempt = attempts.get(ip) || { failures: 0, blockedUntil: 0 };
    if (attempt.blockedUntil > Date.now())
      return bad(res, `Too many failed PINs. Try again in ${Math.ceil((attempt.blockedUntil - Date.now()) / 1000)} seconds.`, 429);
    const pin = String(req.body.pin || '').trim();
    if (!pin) return bad(res, 'PIN required');
    const user = findUserByPin(pin);
    if (!user) {
      attempt.failures += 1;
      if (attempt.failures >= 5) { attempt.blockedUntil = Date.now() + 60000; attempt.failures = 0; }
      attempts.set(ip, attempt);
      return bad(res, 'Invalid PIN', 401);
    }
    attempts.delete(ip);
    const sessionToken = token();
    sessions.set(sessionToken, { user_id: user.id, expiresAt: Date.now() + sessionMs });
    res.setHeader('Set-Cookie', `${cookie}=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`);
    audit({ id: user.id, name: user.name }, 'login', user.role);
    res.json({ user });
  });

  app.post('/api/authorize', requireAuth, (req,res)=>{
    const attemptKey=`approval:${req.user.id}:${req.ip||req.socket.remoteAddress||'local'}`;
    const attempt=attempts.get(attemptKey)||{failures:0,blockedUntil:0};
    if(attempt.blockedUntil>Date.now())return bad(res,'Too many failed approval PINs. Try again shortly.',429);
    const pin=String(req.body.pin||'').trim();
    const approver=pin?findUserByPin(pin):null;
    if(!approver||!['manager','admin'].includes(approver.role)){
      attempt.failures+=1;if(attempt.failures>=5){attempt.blockedUntil=Date.now()+60000;attempt.failures=0;}
      attempts.set(attemptKey,attempt);return bad(res,'That PIN is not authorized for manager actions',403);
    }
    attempts.delete(attemptKey);
    const sessionToken=parseCookies(req)[cookie];
    const approvalToken=token();
    approvals.set(approvalToken,{actorId:req.user.id,sessionToken,approver:{id:approver.id,name:approver.name,role:approver.role},expiresAt:Date.now()+approvalMs});
    audit(req.user,'approval.request',`${approver.name} approved a protected action`);
    res.json({approval_token:approvalToken,approved_by:{id:approver.id,name:approver.name,role:approver.role},expires_in_seconds:approvalMs/1000});
  });

  app.post('/api/logout', (req, res) => {
    const sessionToken = parseCookies(req)[cookie];
    if (sessionToken) {
      sessions.delete(sessionToken);
      for(const [key,approval] of approvals)if(approval.sessionToken===sessionToken)approvals.delete(key);
    }
    res.setHeader('Set-Cookie', `${cookie}=; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });

  app.get('/api/me', requireAuth, (req, res) =>
    res.json({ user: { id: req.user.id, name: req.user.name, role: req.user.role } }));

  return { requireAuth, requireRole };
};
