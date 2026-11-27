fx_version 'cerulean'
game 'gta5'
lua54 'yes'

author 'Medic Shift Log'
description 'Optional, disabled-by-default Medic Shift Log bridge foundation'
version '0.1.0'

-- Server configuration and credentials are loaded only by the server.
server_scripts {
    'server/config.lua',
    'server/adapter.lua',
    'server/main.lua'
}

client_scripts {
    'client/main.lua'
}
