-- Server-only configuration. Do not move this file into shared_scripts.
Config = {
    Enabled = GetConvarInt('medic_bridge_enabled', 0) == 1,
    ApiBase = GetConvar('medic_bridge_api_base', 'https://medic-test-2-tea-8d38.vercel.app'):gsub('/+$', ''),
    ServerId = GetConvar('medic_bridge_server_id', ''),
    Token = GetConvar('medic_bridge_token', ''),
    Framework = GetConvar('medic_bridge_framework', 'unknown'),
    IdentifierType = GetConvar('medic_bridge_identifier_type', 'license'),
    ResourceVersion = '0.1.0-foundation',
    HeartbeatIntervalMs = 30000,
    PollIntervalMs = 5000
}
