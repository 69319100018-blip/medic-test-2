# medic_bridge (foundation)

This is an optional FiveM Resource for the Medic Shift Log integration.

- It is **disabled by default**.
- The server adapter is intentionally unimplemented and always reports `IsReady() == false`.
- The Resource does not change player jobs, duty states, vehicles or keys until the actual framework/vehicle adapter is implemented and approved.
- Keep `server/config.lua` in `server_scripts` only. Never move the token to a shared/client script.
- Do not add the Resource to a live server's `server.cfg` until the owner approves a staging test and the matching API/database release is ready.

Read [the complete foundation and activation guide](../../docs/FIVEM-BRIDGE-FOUNDATION.md).
