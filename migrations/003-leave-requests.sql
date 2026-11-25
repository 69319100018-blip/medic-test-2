CREATE TABLE IF NOT EXISTS public.leave_requests (
  id BIGSERIAL PRIMARY KEY,
  username TEXT NOT NULL REFERENCES public.users(username) ON DELETE CASCADE,
  leave_type VARCHAR(40) NOT NULL CHECK (leave_type IN ('ลาป่วย', 'ลากิจ', 'ลาพักผ่อน', 'อื่นๆ')),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  reason VARCHAR(1000) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  review_note TEXT,
  reviewed_by TEXT REFERENCES public.users(username) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT leave_requests_date_range_check CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_leave_requests_user_created
  ON public.leave_requests (username, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leave_requests_status_created
  ON public.leave_requests (status, created_at DESC);