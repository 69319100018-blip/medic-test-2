CREATE TABLE IF NOT EXISTS public.calendar_events (
  id BIGSERIAL PRIMARY KEY,
  event_date DATE NOT NULL,
  title VARCHAR(160) NOT NULL,
  description TEXT,
  start_time TIME,
  end_time TIME,
  location VARCHAR(180),
  created_by TEXT REFERENCES public.users(username) ON DELETE SET NULL,
  updated_by TEXT REFERENCES public.users(username) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT calendar_events_time_range_check
    CHECK (start_time IS NULL OR end_time IS NULL OR end_time >= start_time)
);
CREATE INDEX IF NOT EXISTS idx_calendar_events_date_time
  ON public.calendar_events (event_date, start_time, id);
