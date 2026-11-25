'use strict';

function canApproveLeave(user) {
  if (user?.isAdmin === true) return true;
  const role = String(user?.role || '').toLowerCase().replace(/[\s.]/g, '');
  return role.startsWith('รองผู้อำนวยการ') ||
    role.startsWith('ผู้อำนวยการ') ||
    role.startsWith('รองผอ') ||
    role.startsWith('ผอ');
}

module.exports = { canApproveLeave };
