-- Payroll is now derived only from public.users.role via api/pay-grade.js.
-- Keep the old column for backward compatibility, but do not use it as an authority.
COMMENT ON COLUMN public.users.pay_grade IS
  'Deprecated: payroll grade and rate are derived exclusively from public.users.role via api/pay-grade.js. This column is retained for compatibility only.';
