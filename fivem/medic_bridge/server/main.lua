local Adapter = MedicBridgeAdapter
local eventQueue = {}
local cachedIdentifiers = {}
local MAX_QUEUED_EVENTS = 200
local requestSequence = 0

math.randomseed(os.time() + GetGameTimer())

local function log(message)
    print(('[medic_bridge] %s'):format(tostring(message)))
end

local function configured()
    return Config.Enabled == true
        and Config.ApiBase ~= ''
        and Config.ServerId ~= ''
        and #Config.Token >= 32
end

local function makeNonce()
    requestSequence = requestSequence + 1
    return ('%d-%d-%d-%d'):format(
        os.time(), GetGameTimer(), requestSequence,
        math.random(100000000, 999999999)
    )
end

local function request(path, body, callback)
    if not configured() then
        if callback then callback(0, nil) end
        return
    end

    local payload = json.encode(body or {})
    local headers = {
        ['Content-Type'] = 'application/json',
        ['Authorization'] = 'Bearer ' .. Config.Token,
        ['X-Medic-Server-ID'] = Config.ServerId,
        ['X-Medic-Timestamp'] = tostring(os.time()),
        ['X-Medic-Nonce'] = makeNonce()
    }

    PerformHttpRequest(
        Config.ApiBase .. path,
        function(status, response)
            local decoded = nil
            if response and response ~= '' then
                local ok, value = pcall(json.decode, response)
                if ok then decoded = value end
            end
            if callback then callback(status, decoded) end
        end,
        'POST',
        payload,
        headers
    )
end

local function newEventKey()
    requestSequence = requestSequence + 1
    return ('%d_%d_%d_%d'):format(
        os.time(), GetGameTimer(), requestSequence,
        math.random(100000, 999999)
    )
end

local function queueEvent(source, eventType, metadata)
    if not configured() or not Adapter.IsReady() then return false end
    local playerSource = tonumber(source)
    local cached = cachedIdentifiers[playerSource]
    local identifierType, identifier
    if cached then
        identifierType, identifier = cached.identifierType, cached.identifier
    else
        identifierType, identifier = Adapter.GetIdentifier(playerSource)
        if identifierType and identifier then
            cachedIdentifiers[playerSource] = { identifierType = identifierType, identifier = identifier }
        end
    end
    if not identifierType or not identifier then
        log('event ignored: player identifier unavailable')
        return false
    end
    if #eventQueue >= MAX_QUEUED_EVENTS then
        table.remove(eventQueue, 1)
        log('event queue reached its limit; oldest unsent event was dropped')
    end
    eventQueue[#eventQueue + 1] = {
        eventKey = newEventKey(),
        identifierType = identifierType,
        identifier = identifier,
        eventType = eventType,
        occurredAt = os.date('!%Y-%m-%dT%H:%M:%SZ'),
        metadata = metadata or {}
    }
    return true
end

local function flushEvents()
    if #eventQueue == 0 or not Adapter.IsReady() then return end
    local batch = {}
    local count = math.min(#eventQueue, 25)
    for i = 1, count do batch[i] = eventQueue[i] end

    request('/api/fivem/events', { events = batch }, function(status, response)
        if status >= 200 and status < 300 and response and response.ok == true then
            for _ = 1, count do table.remove(eventQueue, 1) end
        else
            log(('event sync deferred (HTTP %s)'):format(tostring(status)))
        end
    end)
end

local function acknowledge(commandId, status, result)
    request('/api/fivem/commands/' .. commandId .. '/ack', {
        status = status,
        result = result or {}
    }, function(httpStatus)
        if httpStatus < 200 or httpStatus >= 300 then
            log(('command acknowledgement deferred (HTTP %s)'):format(tostring(httpStatus)))
        end
    end)
end

local function executeCommand(command)
    if command.commandType ~= 'force_off_duty' then
        acknowledge(command.id, 'failed', { reason = 'unsupported_command' })
        return
    end

    local source = Adapter.FindSourceByIdentifier(command.identifierType, command.identifier)
    if not source then
        acknowledge(command.id, 'failed', { reason = 'player_not_online' })
        return
    end

    local ok, result = Adapter.ForceOffDuty(source, command.payload or {})
    result = result or {}
    if ok == true and result.dutyCleared == true and result.vehicleSecured == true then
        acknowledge(command.id, 'completed', {
            dutyCleared = true,
            vehicleSecured = true,
            detail = tostring(result.detail or 'confirmed_by_framework_adapter'):sub(1, 120)
        })
    else
        acknowledge(command.id, 'failed', {
            dutyCleared = result.dutyCleared == true,
            vehicleSecured = result.vehicleSecured == true,
            reason = tostring(result.error or 'framework_action_not_confirmed'):sub(1, 120)
        })
    end
end

local function heartbeat()
    if not configured() then return end
    request('/api/fivem/heartbeat', {
        onlinePlayers = Adapter.GetOnlineCount(),
        onlineIdentifiers = Adapter.GetOnlineIdentities(),
        framework = Adapter.Name or Config.Framework or 'unknown',
        resourceVersion = Config.ResourceVersion,
        adapterReady = Adapter.IsReady() == true
    }, function(status, response)
        if status < 200 or status >= 300 or not response or response.ok ~= true then
            log(('heartbeat deferred (HTTP %s)'):format(tostring(status)))
        end
    end)
end

local function pollCommands()
    if not configured() or not Adapter.IsReady() then return end
    request('/api/fivem/commands/poll', {}, function(status, response)
        if status < 200 or status >= 300 or not response or type(response.commands) ~= 'table' then
            if status ~= 0 then log(('command poll deferred (HTTP %s)'):format(tostring(status))) end
            return
        end
        for _, command in ipairs(response.commands) do
            executeCommand(command)
        end
    end)
end

-- Exports are for other SERVER resources only. Do not call these from client events.
exports('ReportDutyState', function(source, isOnDuty, metadata)
    if type(isOnDuty) ~= 'boolean' then return false end
    return queueEvent(source, isOnDuty and 'duty_started' or 'duty_ended', metadata)
end)

exports('ReportVehicleState', function(source, isInsideDutyVehicle, vehicleMetadata)
    if type(isInsideDutyVehicle) ~= 'boolean' then return false end
    return queueEvent(source, isInsideDutyVehicle and 'vehicle_entered' or 'vehicle_exited', vehicleMetadata)
end)

AddEventHandler('playerJoining', function()
    local playerSource = source
    SetTimeout(2000, function()
        if GetPlayerPing(playerSource) <= 0 then return end
        local identifierType, identifier = Adapter.GetIdentifier(playerSource)
        if identifierType and identifier then
            cachedIdentifiers[playerSource] = { identifierType = identifierType, identifier = identifier }
            queueEvent(playerSource, 'player_connected', {})
        end
    end)
end)

AddEventHandler('playerDropped', function()
    local playerSource = source
    queueEvent(playerSource, 'player_disconnected', {})
    cachedIdentifiers[playerSource] = nil
end)

CreateThread(function()
    if not Config.Enabled then
        log('disabled by default; no API calls or game-side actions will run')
        return
    end
    if not configured() then
        log('enabled flag is set, but API URL, server ID or token is missing; bridge remains inactive')
        return
    end

    log('enabled; waiting for a configured framework adapter')
    heartbeat()
    while true do
        Wait(Config.HeartbeatIntervalMs)
        heartbeat()
    end
end)

CreateThread(function()
    while true do
        Wait(Config.PollIntervalMs)
        if configured() and Adapter.IsReady() then
            flushEvents()
            pollCommands()
        end
    end
end)
