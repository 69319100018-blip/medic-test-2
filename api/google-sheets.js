
'use strict';
const crypto = require('node:crypto');
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/drive.file'];
const TAB = 'บันทึกเวร';
const MAX_ATTEMPTS = 10;

function config() {
  return {
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || '',
    redirectUri: process.env.GOOGLE_REDIRECT_URI || 'https://medic-test-2-tea-8d38.vercel.app/api/google-sheets/callback',
    encryptionKey: process.env.GOOGLE_TOKEN_ENCRYPTION_KEY || '',
    cronSecret: process.env.CRON_SECRET || ''
  };
}
function key() {
  const raw = config().encryptionKey;
  const k = /^[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64url');
  if (k.length !== 32) throw new Error('GOOGLE_TOKEN_ENCRYPTION_KEY must be 32 bytes');
  return k;
}
function encryptToken(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}
function decryptToken(value) {
  const [version, iv, tag, encrypted] = String(value || '').split('.');
  if (version !== 'v1' || !iv || !tag || !encrypted) throw new Error('Invalid Google refresh token');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
}
const sha = (value) => crypto.createHash('sha256').update(value).digest('base64url');

async function googleJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(12000),
    headers: { Accept: 'application/json', ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.error_description || data.error?.message || data.error || 'Google API error');
    err.status = response.status;
    err.code = typeof data.error === 'string' ? data.error : (data.error?.status || 'google_api_error');
    if (response.status === 401 || err.code === 'invalid_grant') err.requiresReconnect = true;
    throw err;
  }
  return data;
}
async function googleRefresh(connection) {
  const cfg = config();
  const tokens = await googleJson('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: decryptToken(connection.refresh_token_encrypted),
      grant_type: 'refresh_token'
    })
  });
  return tokens.access_token;
}
async function sheetsCall(token, spreadsheetId, method, path, body) {
  const response = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(spreadsheetId) + path, {
    method,
    signal: AbortSignal.timeout(12000),
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.error?.message || 'Google Sheets request failed');
    err.status = response.status;
    err.code = data.error?.status || 'google_sheets_error';
    if (response.status === 401) err.requiresReconnect = true;
    throw err;
  }
  return data;
}
async function createSheet(token, displayName) {
  const name = String(displayName || 'ผู้ใช้งาน').replace(/[\r\n]/g, ' ').trim().slice(0, 80) || 'ผู้ใช้งาน';
  const created = await googleJson('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      properties: { title: 'Medic Shift Log - ' + name, locale: 'th_TH', timeZone: 'Asia/Bangkok' },
      sheets: [{ properties: { title: TAB, gridProperties: { frozenRowCount: 1 } } }]
    })
  });
  if (!created.spreadsheetId) throw new Error('Google did not return a spreadsheet ID');
  await sheetsCall(token, created.spreadsheetId, 'PUT',
    '/values/' + encodeURIComponent(TAB + '!A1:H1') + '?valueInputOption=RAW',
    { values: [['รหัสเวร', 'วันที่', 'ชื่อ', 'ตำแหน่ง', 'เวลาเข้า', 'เวลาออก', 'ระยะเวลา', 'สถานะ']] });
  return {
    id: created.spreadsheetId,
    url: created.spreadsheetUrl || ('https://docs.google.com/spreadsheets/d/' + created.spreadsheetId + '/edit')
  };
}
async function shiftValues(sql, username, shiftLogId) {
  const rows = await sql`
    SELECT e.id::text AS id, e.date_th AS date, e.time_th AS "checkInTime",
      COALESCE(e.duration, '') AS duration, u.display_name AS name, u.role,
      COALESCE(x.time_th, '') AS "checkOutTime"
    FROM public.shift_logs e
    JOIN public.users u ON u.username = e.username
    LEFT JOIN LATERAL (
      SELECT o.time_th FROM public.shift_logs o
      WHERE o.username = e.username AND o.type = 'ออกเวร'
        AND o.date_th = e.date_th AND o.created_at >= e.created_at
        AND o.created_at < COALESCE((
          SELECT MIN(n.created_at) FROM public.shift_logs n
          WHERE n.username = e.username AND n.type = 'เข้าเวร'
            AND n.date_th = e.date_th AND n.created_at > e.created_at
        ), 'infinity'::timestamptz)
      ORDER BY o.created_at ASC LIMIT 1
    ) x ON true
    WHERE e.id = ${shiftLogId} AND e.username = ${username} AND e.type = 'เข้าเวร'
    LIMIT 1
  `;
  if (!rows.length) throw new Error('Shift row not found');
  const r = rows[0];
  return [String(r.id), r.date || '', r.name || username, r.role || '', r.checkInTime || '', r.checkOutTime || '', r.duration || '', r.checkOutTime ? 'ออกเวรแล้ว' : 'กำลังเข้าเวร'];
}
async function syncShift(sql, connection, id) {
  if (!connection || connection.status !== 'connected' || !connection.refresh_token_encrypted) {
    throw Object.assign(new Error('Google account is not connected'), { terminal: true });
  }
  const token = await googleRefresh(connection);
  const row = await shiftValues(sql, connection.username, id);
  const existing = await sheetsCall(token, connection.spreadsheet_id, 'GET', '/values/' + encodeURIComponent(TAB + '!A2:A'));
  const values = Array.isArray(existing.values) ? existing.values : [];
  const index = values.findIndex((r) => String(r?.[0] || '') === String(id));
  if (index >= 0) {
    const line = index + 2;
    await sheetsCall(token, connection.spreadsheet_id, 'PUT',
      '/values/' + encodeURIComponent(TAB + '!A' + line + ':H' + line) + '?valueInputOption=RAW',
      { values: [row] });
  } else {
    await sheetsCall(token, connection.spreadsheet_id, 'POST',
      '/values/' + encodeURIComponent(TAB + '!A:H') + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
      { values: [row] });
  }
}
async function processJob(sql, id) {
  const claimed = await sql`
    UPDATE public.google_sheets_sync_jobs
    SET status = 'running', updated_at = NOW()
    WHERE id = ${id} AND status = 'pending' AND next_attempt_at <= NOW()
    RETURNING id, username, shift_log_id AS "shiftLogId", attempts
  `;
  const job = claimed[0];
  if (!job) return { status: 'skipped' };
  try {
    const connections = await sql`
      SELECT username, refresh_token_encrypted, spreadsheet_id, status
      FROM public.google_sheets_connections WHERE username = ${job.username} LIMIT 1
    `;
    await syncShift(sql, connections[0], job.shiftLogId);
    await sql`
      UPDATE public.google_sheets_sync_jobs
      SET status = 'synced', last_error = NULL, synced_at = NOW(), updated_at = NOW()
      WHERE id = ${job.id}
    `;
    await sql`
      UPDATE public.google_sheets_connections
      SET last_synced_at = NOW(), last_error = NULL, updated_at = NOW()
      WHERE username = ${job.username}
    `;
    return { status: 'synced' };
  } catch (err) {
    const attempts = Number(job.attempts || 0) + 1;
    const reconnect = !!err.requiresReconnect || err.code === 'invalid_grant';
    const terminal = reconnect || !!err.terminal || attempts >= MAX_ATTEMPTS;
    const message = String(err.message || 'Google Sheets sync failed').slice(0, 400);
    await sql`
      UPDATE public.google_sheets_sync_jobs
      SET status = ${terminal ? 'failed' : 'pending'},
          attempts = ${attempts},
          next_attempt_at = NOW() + (${Math.min(60, 2 ** attempts)} * INTERVAL '1 minute'),
          last_error = ${message}, updated_at = NOW()
      WHERE id = ${job.id}
    `;
    await sql`
      UPDATE public.google_sheets_connections
      SET status = CASE WHEN ${reconnect} THEN 'reauth_required' ELSE status END,
          last_error = ${message}, updated_at = NOW()
      WHERE username = ${job.username}
    `;
    console.error('Google Sheets sync failed:', job.username, err.code || err.status || 'unknown');
    return { status: terminal ? 'failed' : 'pending' };
  }
}
async function safeGoogleQueueShift(sql, username, shiftLogId) {
  try {
    const c = await sql`SELECT status FROM public.google_sheets_connections WHERE username = ${username} LIMIT 1`;
    if (!c.length || c[0].status !== 'connected') return { status: 'not_connected' };
    const jobs = await sql`
      INSERT INTO public.google_sheets_sync_jobs (username, shift_log_id)
      VALUES (${username}, ${shiftLogId})
      ON CONFLICT (shift_log_id) DO UPDATE
        SET status = 'pending', attempts = 0, next_attempt_at = NOW(),
            last_error = NULL, synced_at = NULL, updated_at = NOW()
        WHERE public.google_sheets_sync_jobs.status <> 'running'
      RETURNING id
    `;
    // Keep check-in/out responses independent of Google availability; the cron worker processes this queue.
    return { status: 'pending' };
  } catch (err) {
    console.error('Google Sheets queue failed:', err.code || err.name || 'unknown');
    return { status: 'pending' };
  }
}

function registerGoogleSheetsRoutes({ app, sql, authRequired, needDb, safeError }) {
  app.get('/api/google-sheets/status', authRequired, async (req, res) => {
    try {
      if (!needDb(res)) return;
      const cfg = config();
      const rows = await sql`
        SELECT google_email AS "googleEmail", spreadsheet_url AS "spreadsheetUrl",
          status, last_synced_at AS "lastSyncedAt", last_error AS "lastError"
        FROM public.google_sheets_connections WHERE username = ${req.user.sub} LIMIT 1
      `;
      const c = rows[0] || null;
      return res.json({
        configured: !!(cfg.clientId && cfg.clientSecret && cfg.encryptionKey),
        connected: !!c && c.status === 'connected',
        status: c?.status || 'disconnected',
        googleEmail: c?.googleEmail || null,
        spreadsheetUrl: c?.spreadsheetUrl || null,
        lastSyncedAt: c?.lastSyncedAt || null,
        lastError: c?.lastError || null
      });
    } catch (err) { safeError(res, err); }
  });

  app.post('/api/google-sheets/connect', authRequired, async (req, res) => {
    try {
      if (!needDb(res)) return;
      const cfg = config();
      if (!cfg.clientId || !cfg.clientSecret || !cfg.encryptionKey) return res.status(503).json({ error: 'ผู้ดูแลระบบยังตั้งค่า Google OAuth ไม่ครบ' });
      key();
      const state = crypto.randomBytes(32).toString('base64url');
      const verifier = crypto.randomBytes(48).toString('base64url');
      await sql`DELETE FROM public.google_sheets_oauth_states WHERE expires_at < NOW()`;
      await sql`
        INSERT INTO public.google_sheets_oauth_states (state_hash, username, code_verifier, expires_at)
        VALUES (${hash(state)}, ${req.user.sub}, ${verifier}, NOW() + INTERVAL '10 minutes')
      `;
      const params = new URLSearchParams({
        client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: 'code',
        scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent',
        include_granted_scopes: 'true', state, code_challenge: hash(verifier),
        code_challenge_method: 'S256'
      });
      return res.json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString() });
    } catch (err) { safeError(res, err); }
  });

  app.get('/api/google-sheets/callback', async (req, res) => {
    const redirect = (result) => res.redirect(302, '/dashboard.html?googleSheets=' + encodeURIComponent(result));
    try {
      const state = String(req.query.state || '');
      const code = String(req.query.code || '');
      if (!/^[A-Za-z0-9_-]{32,100}$/.test(state)) return redirect('invalid_state');
      const states = await sql`
        DELETE FROM public.google_sheets_oauth_states
        WHERE state_hash = ${hash(state)} AND expires_at > NOW()
        RETURNING username, code_verifier AS "codeVerifier"
      `;
      const s = states[0];
      if (!s) return redirect('expired');
      if (req.query.error) return redirect('denied');
      if (!code || code.length > 4096) return redirect('invalid_code');
      const cfg = config();
      const tokens = await googleJson('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code, client_id: cfg.clientId, client_secret: cfg.clientSecret,
          redirect_uri: cfg.redirectUri, grant_type: 'authorization_code', code_verifier: s.codeVerifier
        })
      });
      if (!tokens.access_token) throw new Error('Google did not return an access token');
      const identity = await googleJson('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: 'Bearer ' + tokens.access_token }
      });
      if (!identity.sub || !identity.email || identity.email_verified !== true) throw new Error('Google account verification failed');
      const oldRows = await sql`
        SELECT google_sub, refresh_token_encrypted, spreadsheet_id, spreadsheet_url
        FROM public.google_sheets_connections WHERE username = ${s.username} LIMIT 1
      `;
      const old = oldRows[0] || null;
      let refresh = tokens.refresh_token || null;
      if (!refresh && old && old.google_sub === identity.sub) refresh = decryptToken(old.refresh_token_encrypted);
      if (!refresh) return redirect('refresh_token_missing');
      const other = await sql`
        SELECT username FROM public.google_sheets_connections
        WHERE google_sub = ${identity.sub} AND username <> ${s.username} LIMIT 1
      `;
      if (other.length) return redirect('google_account_in_use');
      let sheet;
      if (old && old.google_sub === identity.sub && old.spreadsheet_id) {
        sheet = { id: old.spreadsheet_id, url: old.spreadsheet_url };
      } else {
        const profile = await sql`SELECT display_name FROM public.users WHERE username = ${s.username} LIMIT 1`;
        sheet = await createSheet(tokens.access_token, profile[0]?.display_name || s.username);
      }
      await sql`
        INSERT INTO public.google_sheets_connections
          (username, google_sub, google_email, refresh_token_encrypted, spreadsheet_id, spreadsheet_url, status, last_error, updated_at)
        VALUES (${s.username}, ${identity.sub}, ${identity.email}, ${encryptToken(refresh)},
          ${sheet.id}, ${sheet.url}, 'connected', NULL, NOW())
        ON CONFLICT (username) DO UPDATE SET
          google_sub = EXCLUDED.google_sub, google_email = EXCLUDED.google_email,
          refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
          spreadsheet_id = EXCLUDED.spreadsheet_id, spreadsheet_url = EXCLUDED.spreadsheet_url,
          status = 'connected', last_error = NULL, updated_at = NOW()
      `;
      await sql`
        INSERT INTO public.google_sheets_sync_jobs (username, shift_log_id)
        SELECT ${s.username}, history.id
        FROM (
          SELECT id FROM public.shift_logs
          WHERE username = ${s.username} AND type = 'เข้าเวร'
          ORDER BY created_at DESC LIMIT 500
        ) history
        ON CONFLICT (shift_log_id) DO UPDATE SET
          status = 'pending', attempts = 0, next_attempt_at = NOW(),
          last_error = NULL, synced_at = NULL, updated_at = NOW()
        WHERE public.google_sheets_sync_jobs.status <> 'running'
      `;
      return redirect('connected');
    } catch (err) {
      console.error('Google OAuth callback failed:', err.code || err.status || err.name || 'unknown');
      return redirect('error');
    }
  });

  app.post('/api/google-sheets/disconnect', authRequired, async (req, res) => {
    try {
      if (!needDb(res)) return;
      const rows = await sql`SELECT refresh_token_encrypted FROM public.google_sheets_connections WHERE username = ${req.user.sub} LIMIT 1`;
      if (!rows.length) return res.json({ ok: true, disconnected: false });
      if (rows[0].refresh_token_encrypted) {
        try {
          const refresh = decryptToken(rows[0].refresh_token_encrypted);
          await fetch('https://oauth2.googleapis.com/revoke', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: refresh }),
            signal: AbortSignal.timeout(8000)
          });
        } catch (err) { console.warn('Google revoke not confirmed:', err.code || err.name); }
      }
      await sql`
        UPDATE public.google_sheets_connections
        SET refresh_token_encrypted = NULL, status = 'disconnected', last_error = NULL, updated_at = NOW()
        WHERE username = ${req.user.sub}
      `;
      await sql`
        UPDATE public.google_sheets_sync_jobs
        SET status = 'failed', last_error = 'Google Sheets disconnected', updated_at = NOW()
        WHERE username = ${req.user.sub} AND status IN ('pending', 'running')
      `;
      return res.json({ ok: true, disconnected: true });
    } catch (err) { safeError(res, err); }
  });

  app.post('/api/google-sheets/retry', authRequired, async (req, res) => {
    try {
      if (!needDb(res)) return;
      const c = await sql`SELECT status FROM public.google_sheets_connections WHERE username = ${req.user.sub} LIMIT 1`;
      if (!c.length || c[0].status !== 'connected') return res.status(409).json({ error: 'กรุณาเชื่อมต่อ Google Sheets ก่อน' });
      const jobs = await sql`
        UPDATE public.google_sheets_sync_jobs
        SET status = 'pending', attempts = 0, next_attempt_at = NOW(), last_error = NULL, updated_at = NOW()
        WHERE username = ${req.user.sub} AND status = 'failed' RETURNING id
      `;
      let processed = 0;
      for (const job of jobs.slice(0, 10)) {
        const result = await processJob(sql, job.id);
        if (result.status !== 'skipped') processed += 1;
      }
      return res.json({ ok: true, queued: jobs.length, processed });
    } catch (err) { safeError(res, err); }
  });

  app.get('/api/cron/google-sheets-sync', async (req, res) => {
    const secret = config().cronSecret;
    if (!secret || String(req.headers.authorization || '') !== 'Bearer ' + secret) return res.status(401).json({ error: 'Unauthorized' });
    try {
      if (!needDb(res)) return;
      await sql`
        UPDATE public.google_sheets_sync_jobs
        SET status = 'pending', next_attempt_at = NOW(), updated_at = NOW()
        WHERE status = 'running' AND updated_at < NOW() - INTERVAL '10 minutes'
      `;
      const jobs = await sql`
        SELECT id FROM public.google_sheets_sync_jobs
        WHERE status = 'pending' AND next_attempt_at <= NOW() AND attempts < ${MAX_ATTEMPTS}
        ORDER BY created_at ASC LIMIT 25
      `;
      let processed = 0;
      for (const job of jobs) {
        const result = await processJob(sql, job.id);
        if (result.status !== 'skipped') processed += 1;
      }
      return res.json({ ok: true, processed });
    } catch (err) { safeError(res, err); }
  });
}

module.exports = { registerGoogleSheetsRoutes, safeGoogleQueueShift };
