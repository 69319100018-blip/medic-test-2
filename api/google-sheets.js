
'use strict';
const crypto = require('node:crypto');
const { PAY_GRADE_RATES, getPayrollInfoForRole } = require('./pay-grade');
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

const RANK_TAB = 'ยศ';
const RANK_PROTECTION_DESCRIPTION = 'Medic Shift Log: database-controlled rank rates';
const WEEKLY_RANK_PROTECTION_DESCRIPTION = 'Medic Shift Log: database-controlled weekly rank';
const WEEKLY_DATA_PROTECTION_DESCRIPTION = 'Medic Shift Log: database-calculated shift hours and compensation';

function addIsoDays(value, days) {
  const date = new Date(String(value) + 'T00:00:00.000Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function thaiDateLabel(value) {
  const date = new Date(String(value) + 'T00:00:00.000Z');
  return new Intl.DateTimeFormat('th-TH', {
    day: '2-digit', month: 'short', year: '2-digit', timeZone: 'UTC'
  }).format(date);
}

function thaiWeekdayLabel(value) {
  const date = new Date(String(value) + 'T00:00:00.000Z');
  return new Intl.DateTimeFormat('th-TH', {
    weekday: 'short', timeZone: 'UTC'
  }).format(date);
}

function weeklyTabName(weekStart) {
  return ('สัปดาห์ ' + thaiDateLabel(weekStart) + ' - ' + thaiDateLabel(addIsoDays(weekStart, 6)))
    .replaceAll(String.fromCharCode(92), '').replaceAll('/', '').replaceAll(':', '').replaceAll('?', '').replaceAll('*', '').replaceAll('[', '').replaceAll(']', '')
    .slice(0, 99);
}

async function spreadsheetMetadata(token, spreadsheetId) {
  return sheetsCall(token, spreadsheetId, 'GET', '?fields=sheets(properties(sheetId,title),protectedRanges(protectedRangeId,description,range))');
}

function sheetA1Range(title, cells) {
  return "'" + String(title || '').replace(/'/g, "''") + "'!" + cells;
}

async function updateSheetValues(token, spreadsheetId, range, values, inputOption = 'USER_ENTERED') {
  return sheetsCall(
    token,
    spreadsheetId,
    'PUT',
    '/values/' + encodeURIComponent(range) + '?valueInputOption=' + inputOption,
    { values }
  );
}

async function ensurePayrollTabs(token, spreadsheetId, weekStart, ownerEmail) {
  const weekTitle = weeklyTabName(weekStart);
  let metadata = await spreadsheetMetadata(token, spreadsheetId);
  let sheets = Array.isArray(metadata.sheets) ? metadata.sheets : [];
  let rankSheetEntry = sheets.find((sheet) => sheet.properties?.title === RANK_TAB) || null;
  let weekSheetEntry = sheets.find((sheet) => sheet.properties?.title === weekTitle) || null;
  let rankSheet = rankSheetEntry?.properties || null;
  let weekSheet = weekSheetEntry?.properties || null;
  const createRank = !rankSheet;
  const createWeek = !weekSheet;
  const requests = [];

  if (createRank) {
    requests.push({
      addSheet: {
        properties: {
          title: RANK_TAB,
          gridProperties: { rowCount: 30, columnCount: 3, frozenRowCount: 1 }
        }
      }
    });
  }
  if (createWeek) {
    requests.push({
      addSheet: {
        properties: {
          title: weekTitle,
          gridProperties: { rowCount: 20, columnCount: 15, frozenRowCount: 2 }
        }
      }
    });
  }

  if (requests.length) {
    try {
      await sheetsCall(token, spreadsheetId, 'POST', ':batchUpdate', { requests });
    } catch (err) {
      metadata = await spreadsheetMetadata(token, spreadsheetId);
      sheets = Array.isArray(metadata.sheets) ? metadata.sheets : [];
      const rankExists = sheets.some((sheet) => sheet.properties?.title === RANK_TAB);
      const weekExists = sheets.some((sheet) => sheet.properties?.title === weekTitle);
      if ((!createRank || rankExists) && (!createWeek || weekExists)) {
        // Another overlapping sync created the same tabs first.
      } else {
        throw err;
      }
    }
    metadata = await spreadsheetMetadata(token, spreadsheetId);
    sheets = Array.isArray(metadata.sheets) ? metadata.sheets : [];
    rankSheetEntry = sheets.find((sheet) => sheet.properties?.title === RANK_TAB) || null;
    weekSheetEntry = sheets.find((sheet) => sheet.properties?.title === weekTitle) || null;
    rankSheet = rankSheetEntry?.properties || null;
    weekSheet = weekSheetEntry?.properties || null;
  } else {
    rankSheetEntry = sheets.find((sheet) => sheet.properties?.title === RANK_TAB) || null;
    weekSheetEntry = sheets.find((sheet) => sheet.properties?.title === weekTitle) || null;
    rankSheet = rankSheetEntry?.properties || null;
    weekSheet = weekSheetEntry?.properties || null;
  }

  if (!rankSheet?.sheetId || !weekSheet?.sheetId) {
    throw new Error('Google Sheets weekly tabs could not be initialized');
  }

  const rankValues = [
    ['ยศจาก Role ในฐานข้อมูล', 'อัตราตามยศ (บาท)', 'หมายเหตุ'],
    ...PAY_GRADE_RATES.map((item) => [item.grade, item.rate, item.note])
  ];
  // Re-write canonical rates on every sync so edits in the user's spreadsheet do not become authoritative.
  await updateSheetValues(token, spreadsheetId, RANK_TAB + '!A1:C' + rankValues.length, rankValues, 'RAW');
  if (createRank) {
    await sheetsCall(token, spreadsheetId, 'POST', ':batchUpdate', {
      requests: [{
        repeatCell: {
          range: { sheetId: rankSheet.sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 3 },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0.13, green: 0.30, blue: 0.43 },
              textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true },
              horizontalAlignment: 'CENTER'
            }
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)'
        }
      }]
    });
  }

  const protectionRequests = [];
  if (!(rankSheetEntry?.protectedRanges || []).some((item) => item.description === RANK_PROTECTION_DESCRIPTION)) {
    protectionRequests.push({
      addProtectedRange: {
        protectedRange: {
          range: { sheetId: rankSheet.sheetId },
          description: RANK_PROTECTION_DESCRIPTION,
          warningOnly: false,
          editors: { users: ownerEmail ? [ownerEmail] : [], groups: [], domainUsersCanEdit: false }
        }
      }
    });
  }
  if (!(weekSheetEntry?.protectedRanges || []).some((item) => item.description === WEEKLY_RANK_PROTECTION_DESCRIPTION)) {
    protectionRequests.push({
      addProtectedRange: {
        protectedRange: {
          range: { sheetId: weekSheet.sheetId, startRowIndex: 2, startColumnIndex: 13, endColumnIndex: 15 },
          description: WEEKLY_RANK_PROTECTION_DESCRIPTION,
          warningOnly: false,
          editors: { users: ownerEmail ? [ownerEmail] : [], groups: [], domainUsersCanEdit: false }
        }
      }
    });
  }
  if (!(weekSheetEntry?.protectedRanges || []).some((item) => item.description === WEEKLY_DATA_PROTECTION_DESCRIPTION)) {
    protectionRequests.push({
      addProtectedRange: {
        protectedRange: {
          // C:L contains daily hours, total time, calculated pay and the 21-hour threshold.
          // Column M ("รับเงินแล้ว") intentionally remains editable.
          range: { sheetId: weekSheet.sheetId, startRowIndex: 2, startColumnIndex: 1, endColumnIndex: 12 },
          description: WEEKLY_DATA_PROTECTION_DESCRIPTION,
          warningOnly: false,
          editors: { users: ownerEmail ? [ownerEmail] : [], groups: [], domainUsersCanEdit: false }
        }
      }
    });
  }
  if (protectionRequests.length) {
    await sheetsCall(token, spreadsheetId, 'POST', ':batchUpdate', { requests: protectionRequests });
  }

  if (createWeek) {
    const dayHeaders = Array.from({ length: 7 }, (_unused, index) => {
      const date = addIsoDays(weekStart, index);
      return thaiWeekdayLabel(date) + ' ' + thaiDateLabel(date);
    });
    const header = [
      'ลำดับ', 'รายชื่อแพทย์', ...dayHeaders,
      'TimeTotal', 'Total Money', 'ทำงานครบ 21 ชม.', 'รับเงินแล้ว', 'ยศจากฐานข้อมูล', 'อัตราตามยศ (บาท)'
    ];
    const title = ['สรุปเวลาเข้าเวรและค่าตอบแทนประจำสัปดาห์'].concat(Array(14).fill(''));
    const initialRow = [
      1, '', '', '', '', '', '', '', '',
      '', '', false, false, '', ''
    ];
    await updateSheetValues(
      token,
      spreadsheetId,
      sheetA1Range(weekTitle, 'A1:O3'),
      [title, header, initialRow],
      'USER_ENTERED'
    );
    await sheetsCall(token, spreadsheetId, 'POST', ':batchUpdate', {
      requests: [
        {
          mergeCells: {
            range: { sheetId: weekSheet.sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 15 },
            mergeType: 'MERGE_ALL'
          }
        },
        {
          repeatCell: {
            range: { sheetId: weekSheet.sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 15 },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.13, green: 0.30, blue: 0.43 },
                textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true, fontSize: 13 },
                horizontalAlignment: 'CENTER',
                verticalAlignment: 'MIDDLE'
              }
            },
            fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)'
          }
        },
        {
          repeatCell: {
            range: { sheetId: weekSheet.sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 15 },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.88, green: 0.93, blue: 0.97 },
                textFormat: { foregroundColor: { red: 0.12, green: 0.25, blue: 0.35 }, bold: true },
                horizontalAlignment: 'CENTER',
                verticalAlignment: 'MIDDLE',
                wrapStrategy: 'WRAP'
              }
            },
            fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)'
          }
        },
        {
          repeatCell: {
            range: { sheetId: weekSheet.sheetId, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 2, endColumnIndex: 10 },
            cell: { userEnteredFormat: { numberFormat: { type: 'TIME', pattern: '[h]:mm' }, horizontalAlignment: 'CENTER' } },
            fields: 'userEnteredFormat(numberFormat,horizontalAlignment)'
          }
        },
        {
          repeatCell: {
            range: { sheetId: weekSheet.sheetId, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 10, endColumnIndex: 11 },
            cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0.00' }, horizontalAlignment: 'RIGHT' } },
            fields: 'userEnteredFormat(numberFormat,horizontalAlignment)'
          }
        },
        {
          setDataValidation: {
            range: { sheetId: weekSheet.sheetId, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 11, endColumnIndex: 12 },
            rule: { condition: { type: 'BOOLEAN' }, showCustomUi: true, strict: true }
          }
        },
        {
          setDataValidation: {
            range: { sheetId: weekSheet.sheetId, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 12, endColumnIndex: 13 },
            rule: { condition: { type: 'BOOLEAN' }, showCustomUi: true, strict: true }
          }
        }
      ]
    });
  }

  return { weekTitle, rankSheetId: rankSheet.sheetId, weekSheetId: weekSheet.sheetId };
}

async function getPayrollProfile(sql, username) {
  const rows = await sql`
    SELECT username, display_name AS name, role,
      TO_CHAR((created_at AT TIME ZONE 'Asia/Bangkok')::date, 'YYYY-MM-DD') AS "registeredDate"
    FROM public.users
    WHERE username = ${username}
    LIMIT 1
  `;
  const profile = rows[0] || null;
  return profile ? { ...profile, payroll: getPayrollInfoForRole(profile.role) } : null;
}

async function getCurrentWeekStart(sql) {
  const rows = await sql`
    SELECT TO_CHAR(DATE_TRUNC('week', NOW() AT TIME ZONE 'Asia/Bangkok')::date, 'YYYY-MM-DD') AS "weekStart"
  `;
  return rows[0]?.weekStart || null;
}

async function getWeekStartForShift(sql, username, shiftLogId) {
  const rows = await sql`
    SELECT TO_CHAR(DATE_TRUNC('week', e.datetime AT TIME ZONE 'Asia/Bangkok')::date, 'YYYY-MM-DD') AS "weekStart"
    FROM public.shift_logs e
    WHERE e.id = ${shiftLogId} AND e.username = ${username} AND e.type = 'เข้าเวร'
    LIMIT 1
  `;
  return rows[0]?.weekStart || null;
}

async function getWeeklyDayTotals(sql, username, weekStart) {
  const weekEnd = addIsoDays(weekStart, 7);
  return sql`
    WITH sessions AS (
      SELECT
        (e.datetime AT TIME ZONE 'Asia/Bangkok')::date AS local_date,
        e.datetime AS check_in_at,
        x.check_out_at
      FROM public.shift_logs e
      LEFT JOIN LATERAL (
        SELECT o.created_at AS check_out_at
        FROM public.shift_logs o
        WHERE o.username = e.username
          AND o.type = 'ออกเวร'
          AND o.date_th = e.date_th
          AND o.created_at >= e.created_at
          AND o.created_at < COALESCE((
            SELECT MIN(n.created_at)
            FROM public.shift_logs n
            WHERE n.username = e.username
              AND n.type = 'เข้าเวร'
              AND n.created_at > e.created_at
          ), 'infinity'::timestamptz)
        ORDER BY o.created_at ASC
        LIMIT 1
      ) x ON true
      WHERE e.username = ${username}
        AND e.type = 'เข้าเวร'
        AND e.datetime IS NOT NULL
        AND (e.datetime AT TIME ZONE 'Asia/Bangkok')::date >= ${weekStart}::date
        AND (e.datetime AT TIME ZONE 'Asia/Bangkok')::date < ${weekEnd}::date
    )
    SELECT TO_CHAR(local_date, 'YYYY-MM-DD') AS date,
      COALESCE(SUM(CASE
        WHEN check_out_at IS NULL THEN 0
        ELSE GREATEST(0, EXTRACT(EPOCH FROM (check_out_at - check_in_at)))
      END), 0)::bigint AS seconds
    FROM sessions
    GROUP BY local_date
  `;
}

async function syncWeeklyWeek(sql, token, connection, profile, weekStart) {
  const totals = await getWeeklyDayTotals(sql, connection.username, weekStart);
  const byDate = new Map(totals.map((row) => [row.date, Number(row.seconds) || 0]));
  const dailyValues = Array.from({ length: 7 }, (_unused, index) => {
    const date = addIsoDays(weekStart, index);
    if (date < profile.registeredDate) return '';
    const seconds = byDate.get(date) || 0;
    return seconds > 0 ? seconds / 86400 : '';
  });
  const totalSeconds = totals.reduce((sum, row) => sum + (Number(row.seconds) || 0), 0);
  const totalHours = totalSeconds / 3600;
  const totalTimeDays = totalSeconds / 86400;
  const totalMoney = profile.payroll?.matched
    ? Math.round(totalHours * profile.payroll.rate * 100) / 100
    : '';
  const tabs = await ensurePayrollTabs(token, connection.spreadsheet_id, weekStart, connection.google_email);
  const title = tabs.weekTitle;
  await updateSheetValues(token, connection.spreadsheet_id, sheetA1Range(title, 'C3:I3'), [dailyValues], 'RAW');
  await updateSheetValues(token, connection.spreadsheet_id, sheetA1Range(title, 'B3:B3'), [[profile.name || connection.username]], 'RAW');
  // Weekly totals and compensation are calculated on the server from Neon.
  // Column M ("รับเงินแล้ว") remains editable; calculated columns are protected.
  await updateSheetValues(token, connection.spreadsheet_id, sheetA1Range(title, 'J3:L3'), [[
    totalTimeDays,
    totalMoney,
    totalHours >= 21
  ]], 'RAW');
  await updateSheetValues(token, connection.spreadsheet_id, sheetA1Range(title, 'N3:O3'), [[
    profile.payroll?.grade || ('ไม่พบยศตาม Role: ' + (profile.role || 'ไม่ระบุ')),
    profile.payroll?.rate ?? ''
  ]], 'RAW');
}

async function syncCurrentWeekForConnection(sql, connection) {
  if (!connection || connection.status !== 'connected' || !connection.refresh_token_encrypted) return;
  const profile = await getPayrollProfile(sql, connection.username);
  const weekStart = await getCurrentWeekStart(sql);
  if (!profile || !weekStart) return;
  const token = await googleRefresh(connection);
  await syncWeeklyWeek(sql, token, connection, profile, weekStart);
}

async function syncAllWeeklyTabsForConnection(sql, connection) {
  if (!connection || connection.status !== 'connected' || !connection.refresh_token_encrypted) return;
  const profile = await getPayrollProfile(sql, connection.username);
  if (!profile) return;
  const rows = await sql`
    SELECT DISTINCT TO_CHAR(DATE_TRUNC('week', datetime AT TIME ZONE 'Asia/Bangkok')::date, 'YYYY-MM-DD') AS "weekStart"
    FROM public.shift_logs
    WHERE username = ${connection.username} AND type = 'เข้าเวร' AND datetime IS NOT NULL
    ORDER BY "weekStart"
  `;
  const weekStarts = new Set(rows.map((row) => row.weekStart).filter(Boolean));
  const currentWeek = await getCurrentWeekStart(sql);
  if (currentWeek) weekStarts.add(currentWeek);
  const token = await googleRefresh(connection);
  for (const weekStart of Array.from(weekStarts).sort()) {
    await syncWeeklyWeek(sql, token, connection, profile, weekStart);
  }
}

async function safeGoogleEnsureCurrentWeek(sql, username) {
  try {
    const rows = await sql`
      SELECT username, google_email, refresh_token_encrypted, spreadsheet_id, status
      FROM public.google_sheets_connections
      WHERE username = ${username} AND status = 'connected'
      LIMIT 1
    `;
    if (!rows.length) return { status: 'not_connected' };
    // Reconcile every existing week tab so old spreadsheets also receive the database-backed rank.
    await scheduleBackground(() => syncAllWeeklyTabsForConnection(sql, rows[0]));
    return { status: 'scheduled' };
  } catch (err) {
    console.error('Google Sheets weekly payroll reconciliation could not be scheduled:', err.code || err.name || 'unknown');
    return { status: 'pending' };
  }
}

async function safeGoogleRefreshUserSheets(sql, username) {
  try {
    const rows = await sql`
      SELECT username, google_email, refresh_token_encrypted, spreadsheet_id, status
      FROM public.google_sheets_connections
      WHERE username = ${username} AND status = 'connected'
      LIMIT 1
    `;
    if (!rows.length) return { status: 'not_connected' };
    await scheduleBackground(() => syncAllWeeklyTabsForConnection(sql, rows[0]));
    return { status: 'scheduled' };
  } catch (err) {
    console.error('Google Sheets payroll refresh could not be scheduled:', err.code || err.name || 'unknown');
    return { status: 'pending' };
  }
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
  const profile = await getPayrollProfile(sql, connection.username);
  const weekStart = await getWeekStartForShift(sql, connection.username, id);
  if (profile && weekStart) await syncWeeklyWeek(sql, token, connection, profile, weekStart);
}

async function scheduleBackground(task) {
  if (process.env.VERCEL) {
    try {
      const { waitUntil } = await import('@vercel/functions');
      const work = Promise.resolve().then(task).catch((err) => {
        console.error('Google Sheets background task failed:', err.code || err.name || 'unknown');
      });
      waitUntil(work);
      return 'scheduled';
    } catch (err) {
      console.error('Google Sheets background scheduling unavailable:', err.code || err.name || 'unknown');
    }
  }
  await task();
  return 'completed';
}

async function drainQueuedJob(sql, id, maxPasses = 3) {
  let result = { status: 'skipped' };
  for (let pass = 0; pass < maxPasses; pass += 1) {
    result = await processJob(sql, id);
    if (result.status !== 'rerun') return result;
  }
  return { status: 'pending' };
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
      SELECT username, google_email, refresh_token_encrypted, spreadsheet_id, status
      FROM public.google_sheets_connections WHERE username = ${job.username} LIMIT 1
    `;
    await syncShift(sql, connections[0], job.shiftLogId);
    const completed = await sql`
      UPDATE public.google_sheets_sync_jobs
      SET status = CASE WHEN rerun_requested THEN 'pending' ELSE 'synced' END,
          attempts = CASE WHEN rerun_requested THEN 0 ELSE attempts END,
          next_attempt_at = CASE WHEN rerun_requested THEN NOW() ELSE next_attempt_at END,
          last_error = NULL,
          synced_at = CASE WHEN rerun_requested THEN NULL ELSE NOW() END,
          rerun_requested = FALSE,
          updated_at = NOW()
      WHERE id = ${job.id} AND status = 'running'
      RETURNING status
    `;
    if (!completed.length) return { status: 'skipped' };
    await sql`
      UPDATE public.google_sheets_connections
      SET last_synced_at = NOW(), last_error = NULL, updated_at = NOW()
      WHERE username = ${job.username}
    `;
    return { status: completed[0].status === 'pending' ? 'rerun' : 'synced' };
  } catch (err) {
    const attempts = Number(job.attempts || 0) + 1;
    const reconnect = !!err.requiresReconnect || err.code === 'invalid_grant';
    const terminal = reconnect || !!err.terminal || attempts >= MAX_ATTEMPTS;
    const message = String(err.message || 'Google Sheets sync failed').slice(0, 400);
    const failed = await sql`
      UPDATE public.google_sheets_sync_jobs
      SET status = CASE
            WHEN rerun_requested AND NOT ${terminal} THEN 'pending'
            WHEN ${terminal} THEN 'failed'
            ELSE 'pending'
          END,
          attempts = CASE WHEN rerun_requested AND NOT ${terminal} THEN 0 ELSE ${attempts} END,
          next_attempt_at = CASE
            WHEN rerun_requested AND NOT ${terminal} THEN NOW()
            ELSE NOW() + (${Math.min(60, 2 ** attempts)} * INTERVAL '1 minute')
          END,
          rerun_requested = FALSE,
          last_error = ${message}, updated_at = NOW()
      WHERE id = ${job.id} AND status = 'running'
      RETURNING status, attempts
    `;
    await sql`
      UPDATE public.google_sheets_connections
      SET status = CASE WHEN ${reconnect} THEN 'reauth_required' ELSE status END,
          last_error = ${message}, updated_at = NOW()
      WHERE username = ${job.username}
    `;
    console.error('Google Sheets sync failed:', job.username, err.code || err.status || 'unknown');
    if (!failed.length) return { status: 'skipped' };
    return { status: failed[0].status === 'pending' && Number(failed[0].attempts) === 0 ? 'rerun' : failed[0].status };
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
        SET status = CASE WHEN public.google_sheets_sync_jobs.status = 'running' THEN 'running' ELSE 'pending' END,
            rerun_requested = public.google_sheets_sync_jobs.status = 'running',
            attempts = CASE WHEN public.google_sheets_sync_jobs.status = 'running' THEN public.google_sheets_sync_jobs.attempts ELSE 0 END,
            next_attempt_at = CASE WHEN public.google_sheets_sync_jobs.status = 'running' THEN public.google_sheets_sync_jobs.next_attempt_at ELSE NOW() END,
            last_error = CASE WHEN public.google_sheets_sync_jobs.status = 'running' THEN public.google_sheets_sync_jobs.last_error ELSE NULL END,
            synced_at = CASE WHEN public.google_sheets_sync_jobs.status = 'running' THEN public.google_sheets_sync_jobs.synced_at ELSE NULL END,
            updated_at = NOW()
      RETURNING id, status
    `;
    const job = jobs[0];
    if (job?.status === 'pending') {
      // Vercel waitUntil keeps the sync alive after the attendance response is returned.
      await scheduleBackground(() => drainQueuedJob(sql, job.id));
    }
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
      if (c?.status === 'connected') {
        await safeGoogleEnsureCurrentWeek(sql, req.user.sub);
      }
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
        VALUES (${sha(state)}, ${req.user.sub}, ${verifier}, NOW() + INTERVAL '10 minutes')
      `;
      const params = new URLSearchParams({
        client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: 'code',
        scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent',
        include_granted_scopes: 'true', state, code_challenge: sha(verifier),
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
        WHERE state_hash = ${sha(state)} AND expires_at > NOW()
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
          status = CASE WHEN public.google_sheets_sync_jobs.status = 'running' THEN 'running' ELSE 'pending' END,
          rerun_requested = public.google_sheets_sync_jobs.status = 'running',
          attempts = CASE WHEN public.google_sheets_sync_jobs.status = 'running' THEN public.google_sheets_sync_jobs.attempts ELSE 0 END,
          next_attempt_at = CASE WHEN public.google_sheets_sync_jobs.status = 'running' THEN public.google_sheets_sync_jobs.next_attempt_at ELSE NOW() END,
          last_error = CASE WHEN public.google_sheets_sync_jobs.status = 'running' THEN public.google_sheets_sync_jobs.last_error ELSE NULL END,
          synced_at = CASE WHEN public.google_sheets_sync_jobs.status = 'running' THEN public.google_sheets_sync_jobs.synced_at ELSE NULL END,
          updated_at = NOW()
      `;
      const firstBatch = await sql`
        SELECT id FROM public.google_sheets_sync_jobs
        WHERE username = ${s.username} AND status = 'pending'
        ORDER BY created_at ASC LIMIT 10
      `;
      const connections = await sql`
        SELECT username, google_email, refresh_token_encrypted, spreadsheet_id, status
        FROM public.google_sheets_connections
        WHERE username = ${s.username} AND status = 'connected'
        LIMIT 1
      `;
      if (firstBatch.length || connections.length) {
        await scheduleBackground(async () => {
          for (const job of firstBatch) await drainQueuedJob(sql, job.id);
          if (connections.length) await syncCurrentWeekForConnection(sql, connections[0]);
        });
      }
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
        SET status = 'pending', attempts = 0, next_attempt_at = NOW(),
            last_error = NULL, rerun_requested = FALSE, updated_at = NOW()
        WHERE username = ${req.user.sub} AND status IN ('failed', 'pending')
        RETURNING id
      `;
      const batch = jobs.slice(0, 25);
      if (batch.length) {
        await scheduleBackground(async () => {
          for (const job of batch) await drainQueuedJob(sql, job.id);
        });
      }
      return res.json({ ok: true, queued: jobs.length, scheduled: batch.length });
    } catch (err) { safeError(res, err); }
  });

  app.get('/api/cron/google-sheets-sync', async (req, res) => {
    const secret = config().cronSecret;
    if (!secret || String(req.headers.authorization || '') !== 'Bearer ' + secret) return res.status(401).json({ error: 'Unauthorized' });
    try {
      if (!needDb(res)) return;
      await sql`
        UPDATE public.google_sheets_sync_jobs
        SET status = 'pending', rerun_requested = FALSE, attempts = 0,
            next_attempt_at = NOW(), updated_at = NOW()
        WHERE status = 'running' AND updated_at < NOW() - INTERVAL '10 minutes'
      `;
      const jobs = await sql`
        SELECT id FROM public.google_sheets_sync_jobs
        WHERE status = 'pending' AND next_attempt_at <= NOW() AND attempts < ${MAX_ATTEMPTS}
        ORDER BY created_at ASC LIMIT 25
      `;
      let processed = 0;
      for (const job of jobs) {
        const result = await drainQueuedJob(sql, job.id);
        if (result.status !== 'skipped') processed += 1;
      }
      const connections = await sql`
        SELECT username, google_email, refresh_token_encrypted, spreadsheet_id, status
        FROM public.google_sheets_connections
        WHERE status = 'connected' AND refresh_token_encrypted IS NOT NULL
        ORDER BY username
        LIMIT 100
      `;
      if (connections.length) {
        await scheduleBackground(async () => {
          for (const connection of connections) {
            try {
              await syncCurrentWeekForConnection(sql, connection);
            } catch (err) {
              console.error('Weekly Google Sheets rollover failed:', connection.username, err.code || err.status || err.name || 'unknown');
            }
          }
        });
      }
      return res.json({ ok: true, processed, weeklyScheduled: connections.length });
    } catch (err) { safeError(res, err); }
  });
}

module.exports = { registerGoogleSheetsRoutes, safeGoogleQueueShift, safeGoogleRefreshUserSheets };
