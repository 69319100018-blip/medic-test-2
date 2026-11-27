-- Framework adapter contract.
-- This foundation intentionally fails closed until the server owner identifies
-- the actual framework, duty events, vehicle resource and key/garage resource.
MedicBridgeAdapter = {}

local Adapter = MedicBridgeAdapter

Adapter.Name = Config.Framework or 'unknown'

function Adapter.IsReady()
    return false
end

function Adapter.GetIdentifier(source)
    if not source or GetPlayerPing(source) <= 0 then return nil, nil end
    local wanted = Config.IdentifierType or 'license'
    local prefix = wanted .. ':'
    for _, value in ipairs(GetPlayerIdentifiers(source)) do
        if value:sub(1, #prefix) == prefix then
            return wanted, value
        end
    end
    return nil, nil
end

function Adapter.FindSourceByIdentifier(identifierType, identifier)
    if not identifierType or not identifier then return nil end
    for _, rawSource in ipairs(GetPlayers()) do
        local source = tonumber(rawSource)
        local foundType, foundIdentifier = Adapter.GetIdentifier(source)
        if foundType == identifierType and foundIdentifier == identifier then
            return source
        end
    end
    return nil
end

function Adapter.GetOnlineCount()
    return #GetPlayers()
end

-- REQUIRED framework-specific implementation:
-- 1) Verify this is genuinely an EMS player (server-side).
-- 2) Set the EMS duty state to false using the framework's server API.
-- 3) Revoke access to EMS menus, equipment and duty vehicles.
-- 4) Ask the player to leave the EMS vehicle, then verify server-side.
-- 5) Lock/secure the fleet vehicle and revoke keys using the actual vehicle/key resource.
-- Return true only when both dutyCleared and vehicleSecured are confirmed.
function Adapter.ForceOffDuty(_source, _payload)
    return false, {
        error = 'framework_adapter_not_configured',
        dutyCleared = false,
        vehicleSecured = false
    }
end

return Adapter
