-- Payroll rate grade is separate from application access role.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS pay_grade text;

COMMENT ON COLUMN public.users.pay_grade IS
  'Payroll rank used to calculate hourly compensation; separate from users.role permissions.';
