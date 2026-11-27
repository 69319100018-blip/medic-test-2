const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bridge = require('../api/fivem-bridge');
const root = path.join(__dirname, '..');

test('FiveM bridge API module exposes deterministic token and validation helpers', () => {
  assert.equal(
    bridge.hashBridgeToken('test'),
    '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'
  );
  const hash = bridge.hashBridgeToken('a long random bridge token');
  assert.equal(bridge.secureHexEqual(hash, hash), true);
  assert.equal(bridge.secureHexEqual(hash, 'not-a-hash'), false);
  assert.equal(bridge.isValidUuid('8a8aa8c5-2fd2-4ee5-9bb2-22d343811a40'), true);
  assert.equal(bridge.isValidUuid('not-a-uuid'), false);
  assert.equal(bridge.isValidIdentifier('license:abcdef123456'), true);
  assert.equal(bridge.isValidIdentifier('x'), false);
});

test('FiveM event and command acknowledgement metadata is allow-listed', () => {
  const metadata = bridge.sanitizeMetadata({
    framework: 'custom',
    vehiclePlate: 'EMS-001',
    dutyCleared: true,
    vehicleSecured: true,
    refreshToken: 'must-not-be-stored',
    password: 'must-not-be-stored'
  });
  assert.deepEqual(metadata, {
    framework: 'custom',
    vehiclePlate: 'EMS-001',
    dutyCleared: true,
    vehicleSecured: true
  });
});

test('FiveM routes remain isolated from the current production API entry', () => {
  const apiEntry = fs.readFileSync(path.join(root, 'api', 'index.js'), 'utf8');
  const bridgeSource = fs.readFileSync(path.join(root, 'api', 'fivem-bridge.js'), 'utf8');
  assert.doesNotMatch(apiEntry, /fivem-bridge|registerFiveMBridgeRoutes/);
  const dashboard = fs.readFileSync(path.join(root, 'dashboard.html'), 'utf8');
  assert.doesNotMatch(dashboard, /fivem-control\.js|fivem-control\.css|fivemControlSection/);
  assert.match(bridgeSource, /req\.user\?\.isAdmin === true/);
  assert.match(bridgeSource, /crypto\.timingSafeEqual/);
  assert.match(bridgeSource, /FOR UPDATE SKIP LOCKED/);
  assert.match(bridgeSource, /onlineIdentifiers/);
  assert.match(bridgeSource, /claimed_at < NOW\(\) - INTERVAL '30 seconds'/);
  assert.match(bridgeSource, /adapterReady !== true/);
  assert.match(bridgeSource, /dutyCleared === true/);
  assert.match(bridgeSource, /vehicleSecured === true/);
  assert.match(bridgeSource, /DISCORD_WEBHOOK_FIVEM/);
  assert.match(bridgeSource, /allowed_mentions: \{ parse: \[\] \}/);
});

test('FiveM resource is disabled by default and keeps credentials server-only', () => {
  const manifest = fs.readFileSync(path.join(root, 'fivem', 'medic_bridge', 'fxmanifest.lua'), 'utf8');
  const config = fs.readFileSync(path.join(root, 'fivem', 'medic_bridge', 'server', 'config.lua'), 'utf8');
  const adapter = fs.readFileSync(path.join(root, 'fivem', 'medic_bridge', 'server', 'adapter.lua'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'fivem', 'medic_bridge', 'server', 'main.lua'), 'utf8');
  assert.match(manifest, /server_scripts/);
  assert.doesNotMatch(manifest, /shared_scripts|shared_script/);
  assert.match(config, /GetConvarInt\('medic_bridge_enabled', 0\) == 1/);
  assert.match(config, /GetConvar\('medic_bridge_token', ''\)/);
  assert.match(adapter, /function Adapter\.IsReady\(\)\s+return false\s+end/);
  assert.match(adapter, /framework_adapter_not_configured/);
  assert.match(main, /disabled by default/);
  assert.doesNotMatch(main, /RegisterNetEvent\(['"]medic_bridge:server:/);
});

test('FiveM database migration is standalone and idempotent', () => {
  const migration = fs.readFileSync(
    path.join(root, 'migrations', '20261127-fivem-bridge-foundation.sql'),
    'utf8'
  );
  for (const table of [
    'fivem_bridge_servers',
    'fivem_bridge_request_nonces',
    'fivem_player_links',
    'fivem_bridge_events',
    'fivem_bridge_player_states',
    'fivem_bridge_commands'
  ]) {
    assert.match(migration, new RegExp('CREATE TABLE IF NOT EXISTS public\\.' + table));
  }
  assert.match(migration, /enabled BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(migration, /UNIQUE \(server_id, event_key\)/);
  assert.match(migration, /UNIQUE \(requested_by, idempotency_key\)/);
});
