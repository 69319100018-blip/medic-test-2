-- Migration 001: prevent more than one open shift per user and Thai calendar day.
-- Back up the database first.
--
-- Preflight: this query must return zero rows before creating the index:
-- SELECT username, date_th, COUNT(*)
-- FROM shift_logs
-- WHERE type = 'เข้าเวร' AND duration IS NULL
-- GROUP BY username, date_th
-- HAVING COUNT(*) > 1;
--
-- Resolve any duplicate open shifts manually and retain the correct audit trail.
-- Then run this statement in Neon SQL Editor:
CREATE UNIQUE INDEX IF NOT EXISTS idx_shift_logs_one_open_per_user_day
    ON shift_logs (username, date_th)
    WHERE type = 'เข้าเวร' AND duration IS NULL;
