'use strict';
// ---------------------------------------------------------------------------
// permissions.js — fine-grained permission matrix (Phase 2).
// Roles are named permission sets; per-user grants can only ADD permissions.
// Enforcement is server-side (R-B2): every route checks via requirePerm.
// ---------------------------------------------------------------------------

const PERMISSIONS = [
  'products.view', 'products.manage',
  'categories.manage',
  'stock.view', 'stock.adjust',
  'branches.manage', 'locations.manage', 'registers.manage', 'departments.manage',
  'staff.manage', 'staff.permissions',
  'settings.manage', 'settings.tax', 'settings.receipt',
  'sales.discount', 'sales.void', 'sales.refund', 'sales.age_override',
  'purchases.manage', 'suppliers.manage',
  'customers.view', 'customers.manage', 'deni.approve',
  'transfers.manage', 'transfers.approve',
  'stocktake.manage', 'stocktake.approve',
  'expenses.manage',
  'reports.view', 'reports.sensitive',
  'audit.view',
  'promos.manage',
  'capabilities.manage'
];

const ALL = PERMISSIONS;

const ROLE_MAP = {
  owner: ALL,
  manager: ALL.filter((p) => p !== 'capabilities.manage' && p !== 'staff.permissions'),
  cashier: ['products.view', 'stock.view', 'customers.view', 'reports.view'],
  staff: ['products.view', 'stock.view', 'customers.view']
};

function roleHasPerm(role, perm) {
  return (ROLE_MAP[role] || []).includes(perm);
}

function userHasPerm(d, user, perm) {
  if (!user) return false;
  if (user.role === 'owner') return true;
  if (roleHasPerm(user.role, perm)) return true;
  const row = d
    .prepare('SELECT allowed FROM user_permissions WHERE user_id = ? AND permission = ?')
    .get(user.id, perm);
  return !!(row && row.allowed);
}

function userPerms(d, user) {
  const base = ROLE_MAP[user.role] || [];
  const grants = d
    .prepare('SELECT permission FROM user_permissions WHERE user_id = ? AND allowed = 1')
    .all(user.id)
    .map((r) => r.permission);
  return [...new Set([...base, ...grants])];
}

function requirePerm(d, perm) {
  return (req, res, next) => {
    if (!req.user || !userHasPerm(d, req.user, perm)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  };
}

module.exports = { PERMISSIONS, ROLE_MAP, ALL, roleHasPerm, userHasPerm, userPerms, requirePerm };
