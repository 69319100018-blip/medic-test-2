-- Client helper called by a future trusted server-side framework adapter.
-- It only asks the local player to leave the specified networked vehicle.
-- Vehicle locking, key revocation and duty state must still be enforced server-side.
RegisterNetEvent('medic_bridge:client:leaveDutyVehicle', function(networkId)
    local wantedNetId = tonumber(networkId)
    if not wantedNetId or wantedNetId <= 0 then return end

    local vehicle = NetToVeh(wantedNetId)
    if vehicle == 0 or not DoesEntityExist(vehicle) then return end

    local ped = PlayerPedId()
    if GetVehiclePedIsIn(ped, false) ~= vehicle then return end

    TaskLeaveVehicle(ped, vehicle, 16)
end)
