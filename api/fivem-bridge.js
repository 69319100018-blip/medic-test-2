'use strict';

const crypto = require('node:crypto');

const EVENT_TYPES = new Set([
  'player_connected', 'player_disconnected', 'duty_started',
  'duty_ended', 'vehicle_entered', 'vehicle_exited'
]);
const IDENTIFIER_TYPES = new Set(['license', 'license2', 'fivem', 'citizenid']);
const COMMAND_TYPES = new Set(['force_off_duty']);
const CLOCK_SKEW_SECONDS = 120;

function hashBridgeToken(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}
function secureHexEqual(expected, actual) {
  if (!/^[a-f0-9]{64}$/i.test(String(expected || '')) ||
      !/^[a-f0-9]{64}$/i.test(String(actual || ''))) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}
function isValidUuid(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function isValidIdentifier(value) {
  return typeof value === 'string' && value.length >= 6 && value.length <= 160 &&
    /^[A-Za-z0-9:_-]+$/.test(value);
}
function sanitizeMetadata(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const output = {};
  const allowed = new Set([
    'framework', 'job', 'duty', 'vehicleNetId', 'vehiclePlate',
    'vehicleModel', 'vehicleClass', 'reason', 'source', 'dutyCleared', 'vehicleSecured'
  ]);
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.has(key)) continue;
    if (typeof value === 'string') output[key] = value.slice(0, 120);
    else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) output[key] = value;
  }
  return output;
}
function requireAdmin(req, res) {
  if (req.user?.isAdmin === true) return true;
  res.status(403).json({ error: 'เฉพาะแอดมินเท่านั้นที่ใช้ FiveM Control API ได้' });
  return false;
}

function registerFiveMBridgeRoutes({ app, sql, authRequired, needDb, safeError }) {
  if (!app || !sql || typeof authRequired !== 'function' ||
      typeof needDb !== 'function' || typeof safeError !== 'function') {
    throw new Error('registerFiveMBridgeRoutes requires app, sql, authRequired, needDb and safeError');
  }

  const bridgeServerAuth = async (req, res, next) => {
    try {
      if (!needDb(res)) return;
      const serverId = String(req.headers['x-medic-server-id'] || '');
      const bearer = String(req.headers.authorization || '');
      const token = bearer.startsWith('Bearer ') ? bearer.slice(7) : '';
      const timestampText = String(req.headers['x-medic-timestamp'] || '');
      const nonce = String(req.headers['x-medic-nonce'] || '');
      const timestamp = Number(timestampText);
      if (!/^[a-zA-Z0-9_-]{2,64}$/.test(serverId) ||
          token.length < 32 || token.length > 256 ||
          !/^\d{10}$/.test(timestampText) || !Number.isSafeInteger(timestamp) ||
          Math.abs(Math.floor(Date.now() / 1000) - timestamp) > CLOCK_SKEW_SECONDS ||
          !/^[A-Za-z0-9_-]{20,120}$/.test(nonce)) {
        return res.status(401).json({ error: 'ข้อมูลยืนยัน FiveM Bridge ไม่ถูกต้อง' });
      }
      const servers = await sql`
        SELECT server_id AS "serverId", token_hash AS "tokenHash", enabled
        FROM public.fivem_bridge_servers WHERE server_id = ${serverId} LIMIT 1
      `;
      const server = servers[0];
      if (!server || server.enabled !== true ||
          !secureHexEqual(server.tokenHash, hashBridgeToken(token))) {
        return res.status(401).json({ error: 'FiveM Bridge ไม่ได้รับอนุญาต' });
      }
      const nonceRows = await sql`
        INSERT INTO public.fivem_bridge_request_nonces (server_id, nonce, expires_at)
        VALUES (${serverId}, ${nonce}, NOW() + (300 * INTERVAL '1 second'))
        ON CONFLICT (server_id, nonce) DO NOTHING RETURNING nonce
      `;
      if (!nonceRows.length) return res.status(409).json({ error: 'คำขอนี้ถูกส่งซ้ำแล้ว' });
      req.bridgeServer = { serverId };
      return next();
    } catch (err) {
      return safeError(res, err);
    }
  };

  app.post('/api/fivem/heartbeat', bridgeServerAuth, async (req, res) => {
    try {
      const onlinePlayers = Number(req.body?.onlinePlayers);
      if (!Number.isInteger(onlinePlayers) || onlinePlayers < 0 || onlinePlayers > 500) {
        return res.status(400).json({ error: 'onlinePlayers ไม่ถูกต้อง' });
      }
      await sql`
        UPDATE public.fivem_bridge_servers
        SET last_heartbeat_at = NOW(), online_players = ${onlinePlayers},
            framework = ${String(req.body?.framework || 'unknown').slice(0, 32)},
            resource_version = ${String(req.body?.resourceVersion || 'unknown').slice(0, 32)},
            adapter_ready = ${req.body?.adapterReady === true}, updated_at = NOW()
        WHERE server_id = ${req.bridgeServer.serverId} AND enabled = TRUE
      `;
      return res.json({ ok: true, serverTime: new Date().toISOString() });
    } catch (err) {
      return safeError(res, err);
    }
  });

  app.post('/api/fivem/events', bridgeServerAuth, async (req, res) => {
    try {
      const events = req.body?.events;
      if (!Array.isArray(events) || events.length < 1 || events.length > 25) {
        return res.status(400).json({ error: 'events ต้องมี 1 ถึง 25 รายการ' });
      }
      let accepted = 0;
      let duplicates = 0;
      let unmapped = 0;
      for (const raw of events) {
        const eventKey = String(raw?.eventKey || '');
        const identifierType = String(raw?.identifierType || '');
        const identifier = String(raw?.identifier || '');
        const eventType = String(raw?.eventType || '');
        if (!/^[A-Za-z0-9_-]{12,120}$/.test(eventKey) ||
            !IDENTIFIER_TYPES.has(identifierType) ||
            !isValidIdentifier(identifier) || !EVENT_TYPES.has(eventType)) {
          return res.status(400).json({ error: 'รูปแบบ FiveM event ไม่ถูกต้อง' });
        }
        const metadata = sanitizeMetadata(raw.metadata);
        const mapped = await sql`
          SELECT username FROM public.fivem_player_links
          WHERE server_id = ${req.bridgeServer.serverId}
            AND identifier_type = ${identifierType} AND identifier = ${identifier}
          LIMIT 1
        `;
        const username = mapped[0]?.username || null;
        if (!username) unmapped += 1;
        const occurredAt = typeof raw.occurredAt === 'string' && Number.isFinite(Date.parse(raw.occurredAt))
          ? new Date(raw.occurredAt).toISOString() : new Date().toISOString();
        const inserted = await sql`
          INSERT INTO public.fivem_bridge_events
            (server_id, event_key, username, identifier_type, identifier, event_type, metadata, occurred_at)
          VALUES (${req.bridgeServer.serverId}, ${eventKey}, ${username},
            ${identifierType}, ${identifier}, ${eventType},
            ${JSON.stringify(metadata)}::jsonb, ${occurredAt}::timestamptz)
          ON CONFLICT (server_id, event_key) DO NOTHING RETURNING event_key
        `;
        if (!inserted.length) {
          duplicates += 1;
          continue;
        }
        accepted += 1;
        if (!username) continue;

        const isOnline = eventType !== 'player_disconnected';
        const dutyValue = eventType === 'duty_started' ? true
          : (eventType === 'duty_ended' || eventType === 'player_disconnected' ? false : null);
        const vehicleEntered = eventType === 'vehicle_entered';
        const vehicleExited = eventType === 'vehicle_exited';
        await sql`
          INSERT INTO public.fivem_bridge_player_states
            (server_id, username, is_online, is_on_duty, vehicle_net_id, vehicle_plate,
             vehicle_model, last_event_type, last_event_at, last_seen_at, updated_at)
          VALUES (${req.bridgeServer.serverId}, ${username}, ${isOnline},
            COALESCE(${dutyValue}::boolean, FALSE),
            ${vehicleEntered ? String(metadata.vehicleNetId || '') || null : null},
            ${vehicleEntered ? String(metadata.vehiclePlate || '') || null : null},
            ${vehicleEntered ? String(metadata.vehicleModel || '') || null : null},
            ${eventType}, ${occurredAt}::timestamptz, NOW(), NOW())
          ON CONFLICT (server_id, username) DO UPDATE SET
            is_online = EXCLUDED.is_online,
            is_on_duty = COALESCE(${dutyValue}::boolean, public.fivem_bridge_player_states.is_on_duty),
            vehicle_net_id = CASE
              WHEN ${vehicleExited || eventType === 'player_disconnected'} THEN NULL
              WHEN ${vehicleEntered} THEN EXCLUDED.vehicle_net_id
              ELSE public.fivem_bridge_player_states.vehicle_net_id END,
            vehicle_plate = CASE
              WHEN ${vehicleExited || eventType === 'player_disconnected'} THEN NULL
              WHEN ${vehicleEntered} THEN EXCLUDED.vehicle_plate
              ELSE public.fivem_bridge_player_states.vehicle_plate END,
            vehicle_model = CASE
              WHEN ${vehicleExited || eventType === 'player_disconnected'} THEN NULL
              WHEN ${vehicleEntered} THEN EXCLUDED.vehicle_model
              ELSE public.fivem_bridge_player_states.vehicle_model END,
            last_event_type = EXCLUDED.last_event_type, last_event_at = EXCLUDED.last_event_at,
            last_seen_at = NOW(), updated_at = NOW()
        `;
      }
      return res.json({ ok: true, accepted, duplicates, unmapped });
    } catch (err) {
      return safeError(res, err);
    }
  });

  app.post('/api/fivem/commands/poll', bridgeServerAuth, async (req, res) => {
    try {
      const commands = await sql`
        WITH claimable AS (
          SELECT command_row.id, command_row.username
          FROM public.fivem_bridge_commands AS command_row
          WHERE command_row.server_id = ${req.bridgeServer.serverId}
            AND command_row.status = 'pending' AND command_row.expires_at > NOW()
          ORDER BY command_row.requested_at ASC
          LIMIT 20 FOR UPDATE SKIP LOCKED
        )
        UPDATE public.fivem_bridge_commands AS command
        SET status = 'processing', claimed_at = NOW(),
            attempts = attempts + 1, updated_at = NOW()
        FROM claimable
        JOIN public.fivem_player_links AS link
          ON link.server_id = ${req.bridgeServer.serverId}
         AND link.username = claimable.username
        WHERE command.id = claimable.id
        RETURNING command.id::text AS id, command.command_type AS "commandType",
          command.username, command.payload, command.expires_at AS "expiresAt",
          link.identifier_type AS "identifierType", link.identifier
      `;
      return res.json({ ok: true, commands });
    } catch (err) {
      return safeError(res, err);
    }
  });

  app.post('/api/fivem/commands/:commandId/ack', bridgeServerAuth, async (req, res) => {
    try {
      const commandId = String(req.params.commandId || '');
      if (!isValidUuid(commandId)) return res.status(400).json({ error: 'commandId ไม่ถูกต้อง' });
      const result = sanitizeMetadata(req.body?.result);
      const requestedStatus = String(req.body?.status || '');
      const success = requestedStatus === 'completed' &&
        result.dutyCleared === true && result.vehicleSecured === true;
      if (!success && requestedStatus !== 'failed') {
        return res.status(400).json({ error: 'ผลคำสั่งไม่ครบถ้วนหรือไม่ถูกต้อง' });
      }
      const rows = await sql`
        UPDATE public.fivem_bridge_commands
        SET status = ${success ? 'completed' : 'failed'},
            result = ${JSON.stringify(result)}::jsonb,
            completed_at = NOW(), updated_at = NOW()
        WHERE id = ${commandId} AND server_id = ${req.bridgeServer.serverId}
          AND status = 'processing'
        RETURNING username, command_type AS "commandType"
      `;
      if (!rows.length) return res.status(409).json({ error: 'ไม่พบคำสั่งที่กำลังประมวลผลหรือคำสั่งนี้ถูกปิดแล้ว' });
      if (success && rows[0].commandType === 'force_off_duty') {
        await sql`
          UPDATE public.fivem_bridge_player_states
          SET is_on_duty = FALSE, vehicle_net_id = NULL, vehicle_plate = NULL,
              vehicle_model = NULL, last_event_type = 'duty_ended',
              last_event_at = NOW(), updated_at = NOW()
          WHERE server_id = ${req.bridgeServer.serverId} AND username = ${rows[0].username}
        `;
      }
      return res.json({ ok: true, status: success ? 'completed' : 'failed' });
    } catch (err) {
      return safeError(res, err);
    }
  });

  app.get('/api/fivem/admin/overview', authRequired, async (req, res) => {
    try {
      if (!needDb(res)) return;
      if (!requireAdmin(req, res)) return;
      const servers = await sql`
        SELECT server_id AS "serverId", display_name AS "displayName", framework,
          enabled, adapter_ready AS "adapterReady", online_players AS "onlinePlayers",
          last_heartbeat_at AS "lastHeartbeatAt", resource_version AS "resourceVersion"
        FROM public.fivem_bridge_servers ORDER BY display_name
      `;
      const players = await sql`
        SELECT state.server_id AS "serverId", state.username,
          users.display_name AS name, users.role, state.is_online AS "isOnline",
          state.is_on_duty AS "isOnDuty", state.vehicle_plate AS "vehiclePlate",
          state.vehicle_model AS "vehicleModel", state.last_event_type AS "lastEventType",
          state.last_event_at AS "lastEventAt", state.last_seen_at AS "lastSeenAt"
        FROM public.fivem_bridge_player_states AS state
        JOIN public.users ON users.username = state.username
        ORDER BY state.is_on_duty DESC, users.display_name
      `;
      return res.json({ servers, players });
    } catch (err) {
      return safeError(res, err);
    }
  });

  app.post('/api/fivem/admin/player-links', authRequired, async (req, res) => {
    try {
      if (!needDb(res)) return;
      if (!requireAdmin(req, res)) return;
      const serverId = String(req.body?.serverId || '');
      const username = String(req.body?.username || '');
      const identifierType = String(req.body?.identifierType || '');
      const identifier = String(req.body?.identifier || '');
      if (!/^[a-zA-Z0-9_-]{2,64}$/.test(serverId) ||
          !/^[a-zA-Z0-9_. -]{2,64}$/.test(username) ||
          !IDENTIFIER_TYPES.has(identifierType) || !isValidIdentifier(identifier)) {
        return res.status(400).json({ error: 'ข้อมูลผูกบัญชี FiveM ไม่ถูกต้อง' });
      }
      const serverRows = await sql`
        SELECT server_id FROM public.fivem_bridge_servers
        WHERE server_id = ${serverId} AND enabled = TRUE LIMIT 1
      `;
      if (!serverRows.length) return res.status(404).json({ error: 'ไม่พบเซิร์ฟเวอร์ FiveM ที่เปิดใช้งาน' });
      const users = await sql`SELECT username FROM public.users WHERE username = ${username} LIMIT 1`;
      if (!users.length) return res.status(404).json({ error: 'ไม่พบชื่อบัญชี Medic ในฐานข้อมูล' });
      const linked = await sql`
        INSERT INTO public.fivem_player_links
          (server_id, username, identifier_type, identifier, linked_by)
        VALUES (${serverId}, ${username}, ${identifierType}, ${identifier}, ${req.user.sub})
        ON CONFLICT (server_id, username) DO UPDATE SET
          identifier_type = EXCLUDED.identifier_type, identifier = EXCLUDED.identifier,
          linked_by = EXCLUDED.linked_by, updated_at = NOW()
        RETURNING username
      `;
      return res.json({ ok: true, username: linked[0]?.username });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'Identifier นี้ถูกผูกกับบัญชีอื่นแล้ว' });
      return safeError(res, err);
    }
  });

  app.post('/api/fivem/admin/commands', authRequired, async (req, res) => {
    try {
      if (!needDb(res)) return;
      if (!requireAdmin(req, res)) return;
      const username = String(req.body?.username || '');
      const commandType = String(req.body?.commandType || '');
      const reason = String(req.body?.reason || '').trim();
      const idempotencyKey = String(req.headers['idempotency-key'] || '');
      if (!/^[a-zA-Z0-9_. -]{2,64}$/.test(username) ||
          !COMMAND_TYPES.has(commandType) || reason.length < 8 || reason.length > 500 ||
          !isValidUuid(idempotencyKey)) {
        return res.status(400).json({ error: 'ข้อมูลคำสั่งไม่ถูกต้อง (ต้องมีเหตุผลและ Idempotency-Key)' });
      }
      const links = await sql`
        SELECT link.server_id AS "serverId", state.is_online AS "isOnline",
          state.is_on_duty AS "isOnDuty"
        FROM public.fivem_player_links AS link
        JOIN public.fivem_bridge_servers AS server
          ON server.server_id = link.server_id AND server.enabled = TRUE
        LEFT JOIN public.fivem_bridge_player_states AS state
          ON state.server_id = link.server_id AND state.username = link.username
        WHERE link.username = ${username} LIMIT 1
      `;
      if (!links.length) return res.status(404).json({ error: 'บัญชีนี้ยังไม่ได้ผูก Identifier กับ FiveM' });
      if (!links[0].isOnline || !links[0].isOnDuty) {
        return res.status(409).json({ error: 'ผู้เล่นไม่ได้ออนไลน์และอยู่ในสถานะเข้าเวรใน FiveM' });
      }
      const inserted = await sql`
        INSERT INTO public.fivem_bridge_commands
          (server_id, username, command_type, payload, requested_by, idempotency_key, expires_at)
        VALUES (${links[0].serverId}, ${username}, ${commandType},
          ${JSON.stringify({ reason, secureDutyVehicle: true })}::jsonb,
          ${req.user.sub}, ${idempotencyKey}, NOW() + INTERVAL '2 minutes')
        ON CONFLICT (requested_by, idempotency_key) DO NOTHING
        RETURNING id::text AS id, status, requested_at AS "requestedAt"
      `;
      if (inserted.length) return res.status(202).json({ ok: true, ...inserted[0] });
      const existing = await sql`
        SELECT id::text AS id, status, requested_at AS "requestedAt"
        FROM public.fivem_bridge_commands
        WHERE requested_by = ${req.user.sub} AND idempotency_key = ${idempotencyKey}
        LIMIT 1
      `;
      return res.status(202).json({ ok: true, idempotent: true, ...(existing[0] || {}) });
    } catch (err) {
      return safeError(res, err);
    }
  });
}

module.exports = {
  registerFiveMBridgeRoutes, hashBridgeToken, secureHexEqual,
  isValidUuid, isValidIdentifier, sanitizeMetadata
};
