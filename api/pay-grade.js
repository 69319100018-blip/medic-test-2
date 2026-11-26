'use strict';

const PAY_GRADE_RATES = [
  { grade: 'ผู้อำนวยการ', rate: 45000, note: 'สามารถทำงาน และ เข้าใจแพทย์ได้เป็นอย่างดี' },
  { grade: 'รองผู้อำนวยการ', rate: 40500, note: 'ผู้ช่วยผู้อำนวยการใกล้เคียง กับ ผู้อำนวยการ' },
  { grade: 'แพทย์ชำนาญ', rate: 36000, note: 'ผู้ช่วยดูแลหน่วยงานแพทย์' },
  { grade: 'แพทย์', rate: 31500, note: 'แพทย์เข้าเวรเกิน 1 เดือน และ สอบขับฮอล์' },
  { grade: 'นักเรียนแพทย์', rate: 27000, note: 'นักเรียนแพทย์ เข้าเวร 3ชม. ครบ 10วัน' },
  { grade: 'Test 7 Day', rate: 10000, note: 'แพทย์ใหม่ / ฝึกหัด' },
  { grade: 'แพทย์อาสา', rate: 10000, note: 'แพทย์อาสา' },
  { grade: 'ผู้ช่วย/เลขา', rate: 30000, note: 'คอยช่วยเหลือและประสานงานแทนผู้อำนวยการ' }
];

function normalizeRole(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s.]/g, '');
}

// Match the exact role stored in public.users.role.
// Admin permissions (is_admin) are deliberately not used as a payroll rank.
const ROLE_TO_PAY_GRADE = new Map([
  ['ผู้อำนวยการแพทย์', 'ผู้อำนวยการ'],
  ['ผู้อำนวยการ', 'ผู้อำนวยการ'],
  ['รองผู้อำนวยการแพทย์', 'รองผู้อำนวยการ'],
  ['รองผู้อำนวยการ', 'รองผู้อำนวยการ'],
  ['รองผอ', 'รองผู้อำนวยการ'],
  ['แพทย์ชำนาญการ', 'แพทย์ชำนาญ'],
  ['แพทย์ชำนาญ', 'แพทย์ชำนาญ'],
  ['ชำนาญการ', 'แพทย์ชำนาญ'],
  ['แพทย์', 'แพทย์'],
  ['หมอ', 'แพทย์'],
  ['doctor', 'แพทย์'],
  ['นักเรียนแพทย์', 'นักเรียนแพทย์'],
  ['นักเรียน', 'นักเรียนแพทย์'],
  ['test7day', 'Test 7 Day'],
  ['แพทย์อาสา', 'แพทย์อาสา'],
  ['ผู้ช่วย/เลขา', 'ผู้ช่วย/เลขา'],
  ['ผู้ช่วย', 'ผู้ช่วย/เลขา'],
  ['เลขา', 'ผู้ช่วย/เลขา'],
  ['assistant', 'ผู้ช่วย/เลขา']
].map(([role, grade]) => [normalizeRole(role), grade]));

const RATE_BY_GRADE = new Map(PAY_GRADE_RATES.map((item) => [item.grade, item.rate]));

function getPayrollInfoForRole(role) {
  const sourceRole = String(role || '').trim();
  const grade = ROLE_TO_PAY_GRADE.get(normalizeRole(sourceRole)) || null;
  return {
    sourceRole,
    grade,
    rate: grade ? RATE_BY_GRADE.get(grade) : null,
    matched: Boolean(grade)
  };
}

module.exports = { PAY_GRADE_RATES, getPayrollInfoForRole, normalizeRole };
