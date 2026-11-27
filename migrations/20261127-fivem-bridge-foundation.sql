-- FiveM bridge foundation.
-- This migration is intentionally separate and is NOT applied by deployment.
-- Review, back up the database, and apply only after server-owner approval.

CREATE TABLE IF NOT EXISTS public.fivem_bridge_servers (
    server_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    token_hash CHAR(64) NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'),
    framework TEXT NOT NULL DEFAULT 'unknown'
        CHECK (framework IN ('unknown', 'esx', 'qbcore', 'qbox', 'custom')),
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    adapter_ready BOOLEAN NOT NULL DEFAULT FALSE,
    online_players INTEGER NOT NULL DEFAULT 0 CHECK (online_players >= 0),
    resource_version TEXT,
    last_heartbeat_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.fivem_bridge_request_nonces (
    server_id TEXT NOT NULL REFERENCES public.fivem_bridge_servers(server_id) ON DELETE CASCADE,
    nonce TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (server_id, nonce)
);
CREATE INDEX IF NOT EXISTS idx_fivem_bridge_nonces_expiry
    ON public.fivem_bridge_request_nonces (expires_at);

CREATE TABLE IF NOT EXISTS public.fivem_player_links (
    server_id TEXT NOT NULL REFERENCES public.fivem_bridge_servers(server_id) ON DELETE CASCADE,
    username TEXT NOT NULL REFERENCES public.users(username) ON DELETE CASCADE,
    identifier_type TEXT NOT NULL
        CHECK (identifier_type IN ('license', 'license2', 'fivem', 'citizenid')),
    identifier TEXT NOT NULL,
    linked_by TEXT REFERENCES public.users(username) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (server_id, username),
    UNIQUE (server_id, identifier_type, identifier)
);
CREATE INDEX IF NOT EXISTS idx_fivem_player_links_identifier
    ON public.fivem_player_links (server_id, identifier_type, identifier);

CREATE TABLE IF NOT EXISTS public.fivem_bridge_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES public.fivem_bridge_servers(server_id) ON DELETE CASCADE,
    event_key TEXT NOT NULL,
    username TEXT REFERENCES public.users(username) ON DELETE SET NULL,
    identifier_type TEXT NOT NULL,
    identifier TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN (
        'player_connected', 'player_disconnected', 'duty_started',
        'duty_ended', 'vehicle_entered', 'vehicle_exited'
    )),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (server_id, event_key)
);
CREATE INDEX IF NOT EXISTS idx_fivem_bridge_events_recent
    ON public.fivem_bridge_events (server_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_fivem_bridge_events_user
    ON public.fivem_bridge_events (username, received_at DESC);

CREATE TABLE IF NOT EXISTS public.fivem_bridge_player_states (
    server_id TEXT NOT NULL REFERENCES public.fivem_bridge_servers(server_id) ON DELETE CASCADE,
    username TEXT NOT NULL REFERENCES public.users(username) ON DELETE CASCADE,
    is_online BOOLEAN NOT NULL DEFAULT FALSE,
    is_on_duty BOOLEAN NOT NULL DEFAULT FALSE,
    vehicle_net_id TEXT,
    vehicle_plate TEXT,
    vehicle_model TEXT,
    last_event_type TEXT,
    last_event_at TIMESTAMPTZ,
    last_seen_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (server_id, username)
);
CREATE INDEX IF NOT EXISTS idx_fivem_bridge_player_states_duty
    ON public.fivem_bridge_player_states (server_id, is_on_duty, is_online);

CREATE TABLE IF NOT EXISTS public.fivem_bridge_commands (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id TEXT NOT NULL REFERENCES public.fivem_bridge_servers(server_id) ON DELETE CASCADE,
    username TEXT NOT NULL REFERENCES public.users(username) ON DELETE CASCADE,
    command_type TEXT NOT NULL CHECK (command_type IN ('force_off_duty')),
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    requested_by TEXT NOT NULL REFERENCES public.users(username),
    idempotency_key UUID NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'expired')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    claimed_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    result JSONB,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (requested_by, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_fivem_bridge_commands_poll
    ON public.fivem_bridge_commands (server_id, status, requested_at)
    WHERE status IN ('pending', 'processing');

COMMENT ON TABLE public.fivem_bridge_servers IS
    'FiveM bridge server registry. enabled defaults false; token_hash stores SHA-256 only.';
COMMENT ON TABLE public.fivem_player_links IS
    'Admin-approved mapping from a Medic username to a stable server-side FiveM identifier.';
COMMENT ON TABLE public.fivem_bridge_commands IS
    'Auditable commands queued for FiveM. The game server must execute and acknowledge them.';
