-- Personal Google Sheets integration (one private spreadsheet per Medic account)
CREATE TABLE IF NOT EXISTS public.google_sheets_connections (
    username TEXT PRIMARY KEY REFERENCES public.users(username) ON DELETE CASCADE,
    google_sub TEXT NOT NULL UNIQUE,
    google_email TEXT NOT NULL,
    refresh_token_encrypted TEXT,
    spreadsheet_id TEXT NOT NULL,
    spreadsheet_url TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'connected'
        CHECK (status IN ('connected', 'reauth_required', 'disconnected')),
    last_synced_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.google_sheets_oauth_states (
    state_hash TEXT PRIMARY KEY,
    username TEXT NOT NULL REFERENCES public.users(username) ON DELETE CASCADE,
    code_verifier TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_google_sheets_oauth_states_expires
    ON public.google_sheets_oauth_states (expires_at);

CREATE TABLE IF NOT EXISTS public.google_sheets_sync_jobs (
    id BIGSERIAL PRIMARY KEY,
    username TEXT NOT NULL REFERENCES public.users(username) ON DELETE CASCADE,
    shift_log_id BIGINT NOT NULL REFERENCES public.shift_logs(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'synced', 'failed')),
    attempts INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    synced_at TIMESTAMPTZ,
    UNIQUE (shift_log_id)
);
CREATE INDEX IF NOT EXISTS idx_google_sheets_sync_jobs_pending
    ON public.google_sheets_sync_jobs (status, next_attempt_at, created_at);
