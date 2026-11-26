'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');

process.env.JWT_SECRET = 'test-only-secret-for-local-smoke-tests-32-chars';
process.env.ALLOWED_ORIGINS = '';
delete process.env.DATABASE_URL;

const app = require('../api/index.js');
const { createLocalServer } = require('../server-local/server.js');

let apiServer;
let localServer;
let apiUrl;
let localUrl;

function listen(serverFactory) {
  return new Promise((resolve, reject) => {
    const server = serverFactory();
    server.once('error', reject);
    server.once('listening', () => {
      const address = server.address();
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

function close(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

before(async () => {
  const api = await listen(() => app.listen(0, '127.0.0.1'));
  apiServer = api.server;
  apiUrl = api.url;

  const local = await listen(() => createLocalServer({ port: 0, host: '127.0.0.1' }));
  localServer = local.server;
  localUrl = local.url;
});

after(async () => {
  await Promise.all([close(apiServer), close(localServer)]);
});

test('protected API rejects requests without a bearer token', async () => {
  const response = await fetch(`${apiUrl}/api/users`);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'ต้องเข้าสู่ระบบก่อน');
});

test('health reports unavailable database without leaking connection details', async () => {
  const response = await fetch(`${apiUrl}/api/health`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).ok, false);
});

test('login fails closed when the database is not configured', async () => {
  const response = await fetch(`${apiUrl}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'test-user', password: 'not-a-real-password' })
  });
  assert.equal(response.status, 503);
});

test('CORS does not grant access to an unconfigured origin', async () => {
  const response = await fetch(`${apiUrl}/api/health`, {
    headers: { Origin: 'https://untrusted.example' }
  });
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('browser API client uses same-origin URLs when served by the local server', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'api-client.js'), 'utf8');
  assert.match(source, /const API_BASE = window\.location\.protocol === 'file:' \? 'http:\/\/localhost:3000' : '';/);
});

test('local runtime serves the frontend from the shared API app', async () => {
  const response = await fetch(`${localUrl}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/html/);
  assert.match(await response.text(), /Medic|login|เข้าสู่ระบบ/i);
});

test('local runtime does not expose source, environment, or package metadata', async () => {
  for (const pathname of ['/api/index.js', '/server-local/env.example', '/package.json', '/schema.sql']) {
    const response = await fetch(`${localUrl}${pathname}`);
    assert.equal(response.status, 404, pathname);
  }
});


test('fund withdrawals use explicit numeric casts and the available cash allocation', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'api', 'index.js'), 'utf8');
  assert.ok(source.includes('0::numeric - ${amt}::numeric'));
  assert.ok(source.includes("cash >= ${amt}::numeric"));
  assert.ok(source.includes("total_income = total_income + CASE"));
});

test('stock item IDs accept numeric database IDs and status changes persist through the API', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const apiSource = fs.readFileSync(path.join(__dirname, '..', 'api', 'index.js'), 'utf8');
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
  assert.ok(apiSource.includes('if (!/^[1-9]\\d{0,18}$/.test(id))'));
  assert.ok(appSource.includes('function renderStockWithdrawals()'));
  assert.ok(appSource.includes('await apiUpdateStock(id, { manualStatus: newStatus });'));
  assert.ok(appSource.includes('await apiLoadStockWithdrawals()'));
});


test('calendar write permissions include deputy director and higher roles only', () => {
  const { canManageCalendar } = require('../api/calendar-permissions');
  assert.equal(canManageCalendar({ role: 'รองผู้อำนวยการแพทย์' }), true);
  assert.equal(canManageCalendar({ role: 'ผู้อำนวยการแพทย์' }), true);
  assert.equal(canManageCalendar({ role: 'แอดมินแพทย์' }), true);
  assert.equal(canManageCalendar({ role: 'นักเรียนแพทย์' }), false);
  assert.equal(canManageCalendar({ role: 'แพทย์' }), false);
  assert.equal(canManageCalendar({ role: 'นักเรียนแพทย์', isAdmin: true }), true);
});

test('calendar API requires authentication and guards all write routes', async () => {
  const read = await fetch(`${apiUrl}/api/calendar-events?from=2026-11-01&to=2026-11-30`);
  const create = await fetch(`${apiUrl}/api/calendar-events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2026-11-25', title: 'ประชุมทีม' })
  });
  assert.equal(read.status, 401);
  assert.equal(create.status, 401);
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'api', 'index.js'), 'utf8');
  assert.match(source, /app\.post\('\/api\/calendar-events', authRequired, calendarManagerRequired/);
  assert.match(source, /app\.patch\('\/api\/calendar-event', authRequired, calendarManagerRequired/);
  assert.match(source, /app\.delete\('\/api\/calendar-event', authRequired, calendarManagerRequired/);
});


test('leave approval permissions start at deputy director and above', () => {
  const { canApproveLeave } = require('../api/leave-permissions');
  assert.equal(canApproveLeave({ role: 'รองผู้อำนวยการแพทย์' }), true);
  assert.equal(canApproveLeave({ role: 'ผู้อำนวยการแพทย์' }), true);
  assert.equal(canApproveLeave({ role: 'รอง.ผู้อำนวยการ' }), true);
  assert.equal(canApproveLeave({ role: 'ผอ.แพทย์' }), true);
  assert.equal(canApproveLeave({ role: 'แอดมินแพทย์', isAdmin: true }), true);
  assert.equal(canApproveLeave({ role: 'แพทย์' }), false);
  assert.equal(canApproveLeave({ role: 'นักเรียนแพทย์' }), false);
  assert.equal(canApproveLeave({ role: 'ผู้ช่วยผู้อำนวยการ' }), false);
});

test('leave request routes require authentication and protect approval actions', async () => {
  const read = await fetch(`${apiUrl}/api/leave-requests`);
  const create = await fetch(`${apiUrl}/api/leave-requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leaveType: 'ลากิจ', startDate: '2026-11-26', endDate: '2026-11-26', reason: 'ธุระส่วนตัว' })
  });
  const decide = await fetch(`${apiUrl}/api/leave-request`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: '1', status: 'approved' })
  });
  assert.equal(read.status, 401);
  assert.equal(create.status, 401);
  assert.equal(decide.status, 401);
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'api', 'index.js'), 'utf8');
  assert.match(source, /app\.get\('\/api\/leave-requests', authRequired/);
  assert.match(source, /app\.post\('\/api\/leave-requests', authRequired/);
  assert.match(source, /app\.patch\('\/api\/leave-request', authRequired, leaveApproverRequired/);
  assert.match(source, /status = 'pending'/);
  assert.match(source, /เหตุผลที่ไม่อนุมัติอย่างน้อย 3 ตัวอักษร/);
});


test('current on-duty roster is authenticated and only queries open shifts for today', async () => {
  const response = await fetch(`${apiUrl}/api/on-duty`);
  assert.equal(response.status, 401);
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'api', 'index.js'), 'utf8');
  const routeStart = source.indexOf("app.get('/api/on-duty'");
  const routeEnd = source.indexOf("// ---------- Shifts ----------", routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  const route = source.slice(routeStart, routeEnd);
  assert.match(route, /authRequired/);
  assert.match(route, /s\.duration IS NULL/);
  assert.match(route, /s\.type = 'เข้าเวร'/);
  assert.match(route, /s\.date_th = \$\{today\}/);
  assert.match(route, /INNER JOIN public\.users/);
  assert.doesNotMatch(route, /password_hash|review_note/);
});


test('security headers deny framing, inline scripts and cacheable API responses', async () => {
  const response = await fetch(`${apiUrl}/api/health`);
  const csp = response.headers.get('content-security-policy') || '';
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /script-src 'self' https:\/\/cdn\.jsdelivr\.net/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(response.headers.get('cache-control') || '', /no-store/);
});

test('logout is protected and sessions are revocable server-side', async () => {
  const response = await fetch(`${apiUrl}/api/logout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(response.status, 401);
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'api', 'index.js'), 'utf8');
  assert.match(source, /event_type = 'auth_session_issued'/);
  assert.match(source, /event_type = 'auth_session_revoked'/);
  assert.match(source, /jwtid: crypto\.randomUUID\(\)/);
  assert.match(source, /issuer: JWT_ISSUER/);
  assert.match(source, /audience: JWT_AUDIENCE/);
  assert.match(source, /maxAge: JWT_EXPIRES/);
});

test('active username bans are checked on every authenticated API request', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'api', 'index.js'), 'utf8');
  assert.match(source, /b\.username = u\.username/);
  assert.match(source, /AS "isBanned"/);
  assert.match(source, /if \(user\.isBanned\)/);
});

test('client security telemetry is audit-only and cannot create bans', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'api', 'index.js'), 'utf8');
  const start = source.indexOf("app.post('/api/security-event'");
  const end = source.indexOf("app.get('/api/health'", start);
  const route = source.slice(start, end);
  assert.match(route, /securityEventLimiter/);
  assert.match(route, /allowedEventTypes/);
  assert.doesNotMatch(route, /INSERT INTO security_bans/);
});

test('DevTools traps are not loaded by application pages', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const file of ['index.html', 'register.html', 'dashboard.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.doesNotMatch(html, /js\/anti-devtools\.js/);
  }
  const anti = fs.readFileSync(path.join(__dirname, '..', 'js', 'anti-devtools.js'), 'utf8');
  assert.doesNotMatch(anti, /debugger;/);
  assert.doesNotMatch(anti, /hardKick\(/);
});

test('Vercel static responses have browser security headers', () => {
  const config = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'vercel.json'), 'utf8'));
  const headers = config.headers[0].headers;
  const values = Object.fromEntries(headers.map((entry) => [entry.key, entry.value]));
  assert.match(values['Strict-Transport-Security'], /max-age=31536000/);
  assert.equal(values['X-Frame-Options'], 'DENY');
  assert.equal(values['Referrer-Policy'], 'no-referrer');
  assert.match(values['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.match(values['Permissions-Policy'], /camera=\(\)/);
});


test('persistent login throttling does not let an attacker lock a username from unrelated IPs', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'api', 'index.js'), 'utf8');
  assert.match(source, /username = \$\{uname\} AND ip_address = \$\{ipLogin\} AND created_at > NOW\(\) - INTERVAL '15 minutes'/);
  assert.match(source, /userIpFailures >= 8 \|\| ipFailures >= 50/);
  assert.doesNotMatch(source, /AS "userFailures"/);
});


test('Google Sheets endpoints require an authenticated Medic session and a cron secret', async () => {
  const responses = await Promise.all([
    fetch(`${apiUrl}/api/google-sheets/status`),
    fetch(`${apiUrl}/api/google-sheets/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
    fetch(`${apiUrl}/api/google-sheets/disconnect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
    fetch(`${apiUrl}/api/google-sheets/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
    fetch(`${apiUrl}/api/cron/google-sheets-sync`)
  ]);
  for (const response of responses) assert.equal(response.status, 401);
});

test('Google Sheets integration isolates users and encrypts refresh tokens', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'api', 'google-sheets.js'), 'utf8');
  assert.match(source, /https:\/\/www\.googleapis\.com\/auth\/drive\.file/);
  assert.match(source, /createCipheriv\('aes-256-gcm'/);
  assert.match(source, /code_challenge_method: 'S256'/);
  assert.match(source, /const sha = \(value\) => crypto\.createHash\('sha256'\)/);
  assert.doesNotMatch(source, /\bhash\s*\(/);
  assert.match(source, /access_type: 'offline'/);
  assert.match(source, /WHERE username = \$\{req\.user\.sub\}/);
  assert.match(source, /ON CONFLICT \(shift_log_id\)/);
  assert.match(source, /google_sub/);
  const statusStart = source.indexOf("app.get('/api/google-sheets/status'");
  const statusEnd = source.indexOf("app.post('/api/google-sheets/connect'", statusStart);
  assert.doesNotMatch(source.slice(statusStart, statusEnd), /refresh_token_encrypted/);
});

test('shift check-in and check-out enqueue only the signed-in user\'s own log for Sheets sync', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'api', 'index.js'), 'utf8');
  assert.match(source, /safeGoogleQueueShift\(sql, username, inserted\[0\]\.id\)/);
  assert.match(source, /safeGoogleQueueShift\(sql, username, result\.shift_log_id\)/);
  assert.match(source, /RETURNING shift\.id AS shift_log_id/);
});


test('personal Google Sheets endpoints require an authenticated user and a protected cron token', async () => {
  const responses = await Promise.all([
    fetch(`${apiUrl}/api/google-sheets/status`),
    fetch(`${apiUrl}/api/google-sheets/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
    fetch(`${apiUrl}/api/google-sheets/disconnect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
    fetch(`${apiUrl}/api/google-sheets/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
    fetch(`${apiUrl}/api/cron/google-sheets-sync`)
  ]);
  for (const response of responses) assert.equal(response.status, 401);
});

test('personal Google Sheets integration uses least-privilege OAuth and encrypted per-user tokens', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'api', 'google-sheets.js'), 'utf8');
  const api = fs.readFileSync(path.join(__dirname, '..', 'api', 'index.js'), 'utf8');
  assert.match(source, /https:\/\/www\.googleapis\.com\/auth\/drive\.file/);
  assert.match(source, /createCipheriv\('aes-256-gcm'/);
  assert.match(source, /code_challenge_method: 'S256'/);
  assert.match(source, /access_type: 'offline'/);
  assert.match(source, /WHERE username = \$\{req\.user\.sub\}/);
  assert.match(source, /ON CONFLICT \(shift_log_id\)/);
  assert.match(source, /app\.get\('\/api\/cron\/google-sheets-sync'/);
  assert.match(source, /rerun_requested/);
  assert.match(source, /import\('@vercel\/functions'\)/);
  const deploymentConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  assert.equal(deploymentConfig.crons[0].schedule, '0 17 * * *');
  const statusStart = source.indexOf("app.get('/api/google-sheets/status'");
  const connectStart = source.indexOf("app.post('/api/google-sheets/connect'", statusStart);
  assert.doesNotMatch(source.slice(statusStart, connectStart), /refresh_token_encrypted/);
  assert.match(api, /safeGoogleQueueShift\(sql, username, inserted\[0\]\.id\)/);
  assert.match(api, /safeGoogleQueueShift\(sql, username, result\.shift_log_id\)/);
  assert.match(source, /DATE_TRUNC\('week', NOW\(\) AT TIME ZONE 'Asia\/Bangkok'\)/);
  assert.match(source, /registeredDate/);
  assert.match(source, /date < profile\.registeredDate/);
  assert.match(source, /totalSeconds/);
  assert.match(source, /totalHours/);
  assert.match(source, /totalMoney/);
  assert.match(source, /profile\.payroll\?\.matched/);
  assert.doesNotMatch(source, /J3\*24\*O3|J3\*24>=21/);
  assert.match(source, /startColumnIndex: 11, endColumnIndex: 12/);
  assert.match(source, /startColumnIndex: 12, endColumnIndex: 13/);
  assert.match(source, /startColumnIndex: 1, endColumnIndex: 12/);
  assert.match(source, /startColumnIndex: 13, endColumnIndex: 15/);
  assert.match(source, /syncCurrentWeekForConnection/);
  assert.match(source, /addProtectedRange/);
  assert.match(source, /WEEKLY_DATA_PROTECTION_DESCRIPTION/);
  assert.match(source, /WEEKLY_RANK_PROTECTION_DESCRIPTION/);
  assert.match(source, /RANK_PROTECTION_DESCRIPTION/);
  assert.match(source, /getPayrollInfoForRole\(profile\.role\)/);
  assert.match(source, /profile\.payroll\?\.grade/);
  assert.match(api, /getPayrollInfoForRole\(u\.role\)/);
  assert.match(api, /safeGoogleRefreshUserSheets\(sql, uname\)/);
  assert.doesNotMatch(api, /pay_grade AS "payGrade"|hasPayGrade|pay_grade = CASE/);
  const payroll = require('../api/pay-grade');
  assert.deepEqual(payroll.getPayrollInfoForRole('รองผู้อำนวยการแพทย์'), {
    sourceRole: 'รองผู้อำนวยการแพทย์', grade: 'รองผู้อำนวยการ', rate: 40500, matched: true
  });
  assert.deepEqual(payroll.getPayrollInfoForRole('นักเรียนแพทย์'), {
    sourceRole: 'นักเรียนแพทย์', grade: 'นักเรียนแพทย์', rate: 27000, matched: true
  });
  assert.equal(payroll.getPayrollInfoForRole('ผู้อำนวยการแพทย์').rate, 45000);
  assert.equal(payroll.getPayrollInfoForRole('Test 7 Day').grade, 'Test 7 Day');
  assert.equal(payroll.getPayrollInfoForRole('แอดมินแพทย์').matched, false);
  assert.equal(payroll.getPayrollInfoForRole('แอดมินแพทย์').rate, null);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies['@vercel/functions']);
});
