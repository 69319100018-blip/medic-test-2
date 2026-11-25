'use strict';

function canManageCalendar(user) {
  const role = String(user?.role || '').toLowerCase().replace(/\\s+/g, '');
  return user?.isAdmin === true ||
    role.includes('แอดมิน') ||
    role.includes('ผู้อำนวยการ');
}

module.exports = { canManageCalendar };
