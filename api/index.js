/**
 * Vercel Serverless entry — ใช้ logic เดียวกับ server.js
 * ตั้ง Environment Variables บน Vercel:
 *   DATABASE_URL, JWT_SECRET, ALLOWED_ORIGINS,
 *   DISCORD_WEBHOOK_URL (เข้า-ออกเวร),
 *   DISCORD_WEBHOOK_FUND (เงินกองกลาง),
 *   DISCORD_WEBHOOK_STOCK (เบิก/เติมสต็อก),
 *   DISCORD_WEBHOOK_VEHICLE (ทะเบียนรถ)
 */
require('dotenv').config();
const express = require('express');
const crypto = require('node:crypto');
const { registerGoogleSheetsRoutes, safeGoogleQueueShift, safeGoogleRefreshUserSheets, isValidPayGrade } = require('./google-sheets');
const net = require('node:net');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { neon } = require('@neondatabase/serverless');
const { canManageCalendar } = require('./calendar-permissions');
const { canApproveLeave } = require('./leave-permissions');

const app = express();
// Vercel terminates TLS/proxy traffic and forwards the client IP in X-Forwarded-For.
// Trust the immediate platform proxy so express-rate-limit can safely derive client IPs.
app.set('trust proxy', process.env.VERCEL === '1' ? 1 : false);
app.disable('x-powered-by');
const JWT_SECRET = process.env.JWT_SECRET || '';
const JWT_EXPIRES = '8h';
const JWT_ISSUER = 'medic-shift-log';
const JWT_AUDIENCE = 'medic-shift-log-web';
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('Medic Shift Log non-existent account sentinel', 12);
// Keep each Discord destination independent so one missing webhook never leaks
// an event into another channel.
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const DISCORD_WEBHOOK_FUND = process.env.DISCORD_WEBHOOK_FUND || '';
const DISCORD_WEBHOOK_STOCK = process.env.DISCORD_WEBHOOK_STOCK || process.env.DISCORD_WEBHOOK_FUND_STOCK || '';
const DISCORD_WEBHOOK_VEHICLE = process.env.DISCORD_WEBHOOK_VEHICLE || '';

if (!process.env.DATABASE_URL) {
  console.error('Missing DATABASE_URL');
}
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('Missing or weak JWT_SECRET (minimum 32 characters)');
}

const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;

app.use(helmet({
  contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], baseUri: ["'self'"], objectSrc: ["'none'"],
    frameAncestors: ["'none'"], frameSrc: ["'none'"], formAction: ["'self'"],
    scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'], scriptSrcAttr: ["'none'"],
    styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdn.jsdelivr.net'],
    imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
    fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdn.jsdelivr.net'],
    connectSrc: ["'self'"], mediaSrc: ["'self'", 'data:', 'blob:', 'https:'],
    workerSrc: ["'self'", 'blob:'],
    upgradeInsecureRequests: process.env.VERCEL === '1' ? [] : null
  } },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  frameguard: { action: 'deny' },
  referrerPolicy: { policy: 'no-referrer' },
  hsts: process.env.VERCEL === '1' ? { maxAge: 31536000, includeSubDomains: true, preload: false } : false
}));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    // Same-origin and server-to-server requests may not send Origin.
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    // Fail closed: an empty allow-list or wildcard must not open browser access.
    return cb(null, false);
  },
  credentials: false
}));

app.use(express.json({ limit: '100kb' }));

// Layered abuse throttles. Login failures are counted persistently in Neon below.
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'มีคำขอมากเกินไป กรุณารอสักครู่แล้วลองใหม่' } });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, skipSuccessfulRequests: true, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'เข้าสู่ระบบผิดหลายครั้ง กรุณารอ 15 นาที' } });
const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'สมัครบัญชีบ่อยเกินไป กรุณาลองใหม่ภายหลัง' } });
const securityCheckLimiter = rateLimit({ windowMs: 5 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'ตรวจสอบความปลอดภัยบ่อยเกินไป กรุณารอสักครู่' } });
const securityEventLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'ส่งรายงานความปลอดภัยบ่อยเกินไป' } });

app.use('/api', apiLimiter, (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Request-Id', crypto.randomUUID());
  next();
});

// รองรับ path ทั้งแบบ /api/... และกรณี rewrite
app.use((req, _res, next) => {
  // บางสภาพแวดล้อม Vercel ส่ง url มาไม่ครบ
  if (req.url && !req.url.startsWith('/api') && req.originalUrl && req.originalUrl.startsWith('/api')) {
    req.url = req.originalUrl;
  }
  next();
});

function thaiNow() {
  const now = new Date();
  const timeZone = 'Asia/Bangkok';
  return {
    now,
    date: now.toLocaleDateString('th-TH', { timeZone }),
    time: now.toLocaleTimeString('th-TH', { hour12: false, timeZone }),
    iso: now.toISOString()
  };
}

function signToken(user) {
  return jwt.sign({ sub: user.username }, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: JWT_EXPIRES,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    jwtid: crypto.randomUUID()
  });
}

async function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'ต้องเข้าสู่ระบบก่อน' });
  if (!JWT_SECRET || JWT_SECRET.length < 32 || !sql) return res.status(503).json({ error: 'ระบบยืนยันตัวตนยังไม่พร้อม' });

  let claims;
  try {
    claims = jwt.verify(token, JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      maxAge: JWT_EXPIRES
    });
    if (typeof claims.sub !== 'string' || !claims.sub ||
        typeof claims.jti !== 'string' || !/^[0-9a-f-]{36}$/i.test(claims.jti)) {
      throw new Error('invalid token claims');
    }
  } catch {
    return res.status(401).json({ error: 'โทเคนหมดอายุหรือไม่ถูกต้อง กรุณาเข้าสู่ระบบใหม่' });
  }

  try {
    const rawFingerprint = String(req.headers['x-device-fingerprint'] || '').trim();
    const fingerprint = rawFingerprint.length <= 128 ? (rawFingerprint || null) : null;
    const ip = clientIp(req);
    const sessionDetail = 'jti:' + claims.jti;
    const rows = await sql`
      SELECT u.username, u.role,
             u.is_admin AS "isAdmin",
             u.can_view_monitoring AS "canViewMonitoring",
             (EXISTS (
               SELECT 1 FROM security_events issued
               WHERE issued.event_type = 'auth_session_issued'
                 AND issued.username = u.username
                 AND issued.detail = ${sessionDetail}
                 AND issued.created_at > NOW() - INTERVAL '8 hours'
             ) AND NOT EXISTS (
               SELECT 1 FROM security_events revoked
               WHERE revoked.event_type = 'auth_session_revoked'
                 AND revoked.username = u.username
                 AND revoked.detail = ${sessionDetail}
             )) AS "sessionActive",
             EXISTS (
               SELECT 1 FROM security_bans b
               WHERE b.active = true AND (
                 b.username = u.username
                 OR (${fingerprint}::text IS NOT NULL AND b.fingerprint = ${fingerprint})
                 OR (${ip}::text IS NOT NULL AND b.ip_address = ${ip})
               )
             ) AS "isBanned"
      FROM users u
      WHERE u.username = ${claims.sub}
      LIMIT 1
    `;
    if (!rows.length) return res.status(401).json({ error: 'บัญชีนี้ไม่มีอยู่หรือถูกปิดใช้งาน' });
    const user = rows[0];
    if (user.isBanned) return res.status(403).json({ error: 'บัญชีหรืออุปกรณ์นี้ถูกระงับการใช้งาน', banned: true });
    if (!user.sessionActive) return res.status(401).json({ error: 'เซสชันนี้ถูกยกเลิกหรือหมดอายุ กรุณาเข้าสู่ระบบใหม่' });

    req.user = {
      ...claims,
      sub: user.username,
      role: user.role,
      isAdmin: !!user.isAdmin,
      canViewMonitoring: !!user.canViewMonitoring
    };
    return next();
  } catch (err) {
    console.error('Authentication session check failed:', err?.code || err?.name || 'unknown');
    return res.status(503).json({ error: 'ไม่สามารถตรวจสอบสิทธิ์ได้ในขณะนี้' });
  }
}

function monitoringRequired(req, res, next) {
  if (!req.user?.canViewMonitoring && !req.user?.isAdmin) {
    return res.status(403).json({ error: 'สิทธิ์ไม่เพียงพอ' });
  }
  next();
}

function stockManagerRequired(req, res, next) {
  const role = String(req.user?.role || '').toLowerCase();
  const director = role.includes('ผู้อำนวยการ') && !role.includes('รอง');
  if (!req.user?.isAdmin && !director) return res.status(403).json({ error: 'ไม่มีสิทธิ์จัดการสต็อก' });
  return next();
}

function calendarManagerRequired(req, res, next) {
  if (!canManageCalendar(req.user)) {
    return res.status(403).json({ error: 'เฉพาะรองผู้อำนวยการขึ้นไปเท่านั้นที่จัดการปฏิทินได้' });
  }
  return next();
}

function leaveApproverRequired(req, res, next) {
  if (!canApproveLeave(req.user)) {
    return res.status(403).json({ error: 'เฉพาะรองผู้อำนวยการขึ้นไปเท่านั้นที่อนุมัติคำขอลาได้' });
  }
  return next();
}

function safeError(res, err, status = 500) {
  console.error(err);
  res.status(status).json({ error: status === 500 ? 'เกิดข้อผิดพลาดภายใน' : (err.message || 'error') });
}


function clientIp(req) {
  return String(req.ip || req.socket?.remoteAddress || '').slice(0, 64);
}

async function isBanned({ username, fingerprint, ip }) {
  if (!sql) return null;
  const rows = await sql`
    SELECT id, reason, fingerprint, ip_address, username
    FROM security_bans
    WHERE active = true AND (
      (${username || null}::text IS NOT NULL AND username = ${username || null})
      OR (${fingerprint || null}::text IS NOT NULL AND fingerprint = ${fingerprint || null})
      OR (${ip || null}::text IS NOT NULL AND ip_address = ${ip || null})
    )
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return rows[0] || null;
}

async function logSecurityEvent({ eventType, username, fingerprint, ip, detail }) {
  if (!sql) return;
  try {
    await sql`
      INSERT INTO security_events (event_type, username, fingerprint, ip_address, detail)
      VALUES (${eventType}, ${username || null}, ${fingerprint || null}, ${ip || null}, ${detail || null})
    `;
  } catch (e) {
    console.error('logSecurityEvent', e);
  }
}


function formatShiftDuration(startIso, endDate = new Date()) {
  const start = new Date(startIso);
  let totalSec = Math.max(0, Math.floor((endDate - start) / 1000));
  const hours = Math.floor(totalSec / 3600);
  totalSec %= 3600;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  const parts = [];
  if (hours > 0) parts.push(`${hours} ชม.`);
  if (minutes > 0 || hours > 0) parts.push(`${minutes} นาที`);
  parts.push(`${seconds} วินาที`);
  return parts.join(' ');
}

async function postDiscordWebhook(webhookUrl, body) {
  if (!webhookUrl) return;
  try {
    const parsedUrl = new URL(webhookUrl);
    if (
      parsedUrl.protocol !== 'https:' ||
      !['discord.com', 'discordapp.com'].includes(parsedUrl.hostname) ||
      !parsedUrl.pathname.startsWith('/api/webhooks/')
    ) {
      console.error('Discord webhook skipped: invalid destination URL');
      return;
    }

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) {
      console.error('Discord webhook failed', res.status);
    }
  } catch (e) {
    console.error('Discord webhook error', e?.name || 'request_failed');
  }
}

function discordEmbed({ title, color, fields }) {
  const safeFields = (fields || [])
    .filter(Boolean)
    .slice(0, 25)
    .map((field) => ({
      name: String(field.name || 'รายละเอียด').slice(0, 256),
      value: String(field.value ?? '-').slice(0, 1024) || '-',
      inline: Boolean(field.inline)
    }));

  return {
    username: 'Medic Shift Bot',
    allowed_mentions: { parse: [] },
    embeds: [{
      title: String(title || 'Medic Shift Log').slice(0, 256),
      color,
      fields: safeFields,
      footer: { text: 'Medic Shift Log' },
      timestamp: new Date().toISOString()
    }]
  };
}

async function notifyDiscordShift({ type, username, displayName, role, date, time, duration, isForced }) {
  const isIn = type === 'เข้าเวร';
  const color = isIn ? 0x22c55e : (isForced ? 0xf59e0b : 0xef4444);
  const title = isIn ? '✅ เข้าเวร' : (isForced ? '⚠️ ถูกบังคับออกเวร' : '🚪 ออกเวร');
  const fields = [
    { name: 'ผู้ใช้', value: displayName || username || '-', inline: true },
    { name: 'ตำแหน่ง', value: role || '-', inline: true },
    { name: 'วันที่', value: date || '-', inline: true },
    { name: 'เวลา', value: time || '-', inline: true }
  ];
  if (!isIn && duration) fields.push({ name: 'ระยะเวลา', value: duration, inline: true });
  await postDiscordWebhook(DISCORD_WEBHOOK_URL, discordEmbed({ title, color, fields }));
}

/** ช่องธุรกรรมเงินกองกลาง */
async function notifyDiscordFund({ title, color, fields }) {
  await postDiscordWebhook(DISCORD_WEBHOOK_FUND, discordEmbed({ title, color, fields }));
}

/** ช่องเบิก/เติมสต็อกอุปกรณ์ */
async function notifyDiscordStock({ title, color, fields }) {
  await postDiscordWebhook(DISCORD_WEBHOOK_STOCK, discordEmbed({ title, color, fields }));
}

/** ช่องทะเบียนรถ */
async function notifyDiscordVehicle({ title, color, fields }) {
  await postDiscordWebhook(DISCORD_WEBHOOK_VEHICLE, discordEmbed({ title, color, fields }));
}

async function lookupUserProfile(username) {
  try {
    const rows = await sql`
      SELECT display_name AS name, role FROM users WHERE username = ${username} LIMIT 1
    `;
    return rows[0] || { name: username, role: '-' };
  } catch {
    return { name: username, role: '-' };
  }
}

function needDb(res) {
  if (!sql) {
    res.status(503).json({ error: 'ยังไม่ได้ตั้งค่า DATABASE_URL' });
    return false;
  }
  return true;
}

// ---------- Auth ----------

// ---------- Register / User role (admin) ----------
app.post('/api/register', registerLimiter, async (req, res) => {
  try {
    if (!needDb(res)) return;
    const { username, displayName, password } = req.body || {};
    const uname = String(username || '').trim().toLowerCase();
    const name = String(displayName || '').trim();
    const pass = String(password || '');
    if (!uname || !name || !pass) {
      return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบ' });
    }
    if (uname.length < 3 || uname.length > 64) {
      return res.status(400).json({ error: 'ชื่อผู้ใช้ต้องมีความยาว 3–64 ตัวอักษร' });
    }
    if (name.length > 120) return res.status(400).json({ error: 'ชื่อที่แสดงต้องไม่เกิน 120 ตัวอักษร' });
    if (pass.length < 12 || Buffer.byteLength(pass, 'utf8') > 72) {
      return res.status(400).json({ error: 'รหัสผ่านต้องยาวอย่างน้อย 12 ตัวอักษรและไม่เกิน 72 ไบต์' });
    }
    if (!/^[a-z0-9._\- ]+$/i.test(uname)) {
      return res.status(400).json({ error: 'ชื่อผู้ใช้ใช้ได้เฉพาะตัวอักษร ตัวเลข . _ - และเว้นวรรค' });
    }

    const exists = await sql`SELECT username FROM users WHERE username = ${uname} LIMIT 1`;
    if (exists.length) return res.status(409).json({ error: 'ชื่อผู้ใช้นี้ถูกใช้แล้ว' });

    const hash = await bcrypt.hash(pass, 12);
    await sql`
      INSERT INTO users (username, password_hash, display_name, role, avatar, is_admin, can_view_monitoring, description)
      VALUES (
        ${uname},
        ${hash},
        ${name},
        ${'นักเรียนแพทย์'},
        ${'assets/images/123.jpg'},
        ${false},
        ${false},
        ${'สมัครผ่านหน้าเว็บ — รอแอดมินปรับสิทธิ์'}
      )
    `;
    res.json({ ok: true, username: uname, message: 'สมัครสำเร็จ' });
  } catch (err) {
    safeError(res, err);
  }
});

app.post('/api/user-role', authRequired, async (req, res) => {
  try {
    if (!needDb(res)) return;
    if (!req.user.isAdmin) return res.status(403).json({ error: 'เฉพาะแอดมินเท่านั้น' });

    const { username, role, isAdmin, canViewMonitoring, description, payGrade } = req.body || {};
    const uname = String(username || '').trim().toLowerCase();
    if (!uname || uname.length > 64) return res.status(400).json({ error: 'ชื่อผู้ใช้ไม่ถูกต้อง' });

    const hasRole = role !== undefined;
    const hasAdmin = isAdmin !== undefined;
    const hasMonitoring = canViewMonitoring !== undefined;
    const hasDescription = description !== undefined;
    const hasPayGrade = payGrade !== undefined;
    if (!hasRole && !hasAdmin && !hasMonitoring && !hasDescription && !hasPayGrade) {
      return res.status(400).json({ error: 'ไม่มีข้อมูลสิทธิ์ที่ต้องการแก้ไข' });
    }

    let nextRole = null;
    let nextDescription = null;
    if (hasRole) {
      if (typeof role !== 'string' || !role.trim() || role.trim().length > 80) {
        return res.status(400).json({ error: 'ตำแหน่งต้องเป็นข้อความยาว 1–80 ตัวอักษร' });
      }
      nextRole = role.trim();
    }
    if (hasAdmin && typeof isAdmin !== 'boolean') {
      return res.status(400).json({ error: 'isAdmin ต้องเป็น boolean' });
    }
    if (hasMonitoring && typeof canViewMonitoring !== 'boolean') {
      return res.status(400).json({ error: 'canViewMonitoring ต้องเป็น boolean' });
    }
    if (hasDescription) {
      if (typeof description !== 'string' || description.length > 500) {
        return res.status(400).json({ error: 'คำอธิบายต้องเป็นข้อความไม่เกิน 500 ตัวอักษร' });
      }
      nextDescription = description;
    }
    let nextPayGrade = null;
    if (hasPayGrade) {
      if (payGrade !== null && payGrade !== '' && (typeof payGrade !== 'string' || !isValidPayGrade(payGrade))) {
        return res.status(400).json({ error: 'ยศค่าตอบแทนไม่อยู่ในรายการที่กำหนด' });
      }
      nextPayGrade = payGrade === null || payGrade === '' ? null : payGrade;
    }
    if (uname === req.user.sub && isAdmin === false) {
      return res.status(400).json({ error: 'ไม่สามารถถอดสิทธิ์แอดมินของตัวเองได้' });
    }

    // All permission fields are updated atomically; explicit false values are preserved.
    const rows = await sql`
      UPDATE users
      SET role = COALESCE(${nextRole}, role),
          is_admin = COALESCE(${hasAdmin ? isAdmin : null}, is_admin),
          can_view_monitoring = COALESCE(${hasMonitoring ? canViewMonitoring : null}, can_view_monitoring),
          description = COALESCE(${nextDescription}, description),
          pay_grade = CASE WHEN ${hasPayGrade} THEN ${nextPayGrade} ELSE pay_grade END
      WHERE username = ${uname}
      RETURNING username, display_name AS name, role, avatar,
                is_admin AS "isAdmin", can_view_monitoring AS "canViewMonitoring",
                description AS desc, pay_grade AS "payGrade"
    `;
    if (!rows.length) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
    if (hasPayGrade) {
      safeGoogleRefreshUserSheets(sql, uname).catch(() => {});
    }
    return res.json({ ok: true, user: rows[0] });
  } catch (err) {
    safeError(res, err);
  }
});


app.post('/api/login', loginLimiter, async (req, res) => {
  try {
    if (!needDb(res)) return;
    if (!JWT_SECRET || JWT_SECRET.length < 32) return res.status(503).json({ error: 'ยังไม่ได้ตั้งค่า JWT_SECRET ที่ปลอดภัย' });
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน' });
    const uname = String(username).trim().toLowerCase();
    const pass = String(password);
    if (uname.length > 64 || Buffer.byteLength(pass, 'utf8') > 1024) return res.status(400).json({ error: 'ข้อมูลเข้าสู่ระบบยาวเกินกำหนด' });
    const fpRaw = String((req.body || {}).fingerprint || '').trim();
    const fp = fpRaw.length <= 128 ? (fpRaw || null) : null;
    const ipLogin = clientIp(req);

    // Persistent failure counts are shared across serverless instances.
    const lockRows = await sql`
      SELECT
        COUNT(*) FILTER (WHERE username = ${uname} AND ip_address = ${ipLogin} AND created_at > NOW() - INTERVAL '15 minutes')::int AS "userIpFailures",
        COUNT(*) FILTER (WHERE ip_address = ${ipLogin} AND created_at > NOW() - INTERVAL '15 minutes')::int AS "ipFailures"
      FROM security_events
      WHERE event_type = 'login_failed'
        AND created_at > NOW() - INTERVAL '15 minutes'
        AND (username = ${uname} OR ip_address = ${ipLogin})
    `;
    const userIpFailures = Number(lockRows[0]?.userIpFailures || 0);
    const ipFailures = Number(lockRows[0]?.ipFailures || 0);
    if (userIpFailures >= 8 || ipFailures >= 50) {
      await logSecurityEvent({ eventType: 'login_rate_limited', username: uname, fingerprint: fp, ip: ipLogin, detail: userIpFailures >= 8 ? 'username_ip_threshold' : 'ip_threshold' });
      return res.status(429).json({ error: 'พยายามเข้าสู่ระบบไม่สำเร็จหลายครั้ง กรุณารอ 15 นาที' });
    }

    const banHit = await isBanned({ username: uname, fingerprint: fp, ip: ipLogin });
    if (banHit) {
      await logSecurityEvent({ eventType: 'blocked_login', username: uname, fingerprint: fp, ip: ipLogin, detail: banHit.reason });
      return res.status(403).json({ error: 'บัญชีหรืออุปกรณ์นี้ถูกระงับการใช้งาน', banned: true });
    }

    const rows = await sql`
      SELECT username, password_hash, display_name AS name, role, avatar,
             pay_grade AS "payGrade",
             is_admin AS "isAdmin", can_view_monitoring AS "canViewMonitoring",
             description AS desc
      FROM users WHERE username = ${uname} LIMIT 1
    `;
    if (!rows.length) {
      await bcrypt.compare(pass, DUMMY_PASSWORD_HASH);
      await sql`
        INSERT INTO security_events (event_type, username, ip_address, detail)
        VALUES ('login_failed', ${uname}, ${ipLogin}, 'invalid_credentials')
      `;
      return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    }

    const u = rows[0];
    let ok = false;
    if (u.password_hash && u.password_hash.startsWith('$2')) {
      ok = await bcrypt.compare(pass, u.password_hash);
      if (ok && bcrypt.getRounds(u.password_hash) < 12) {
        const strongerHash = await bcrypt.hash(pass, 12);
        await sql`UPDATE users SET password_hash = ${strongerHash} WHERE username = ${uname}`;
      }
    } else {
      ok = u.password_hash === pass;
      if (ok) {
        const hashed = await bcrypt.hash(pass, 12);
        await sql`UPDATE users SET password_hash = ${hashed} WHERE username = ${uname}`;
        await logSecurityEvent({ eventType: 'legacy_password_upgraded', username: uname, ip: ipLogin, detail: 'Legacy password upgraded to bcrypt cost 12' });
      }
    }

    if (!ok) {
      await sql`
        INSERT INTO security_events (event_type, username, ip_address, detail)
        VALUES ('login_failed', ${uname}, ${ipLogin}, 'invalid_credentials')
      `;
      return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    }

    const profile = {
      name: u.name, role: u.role, avatar: u.avatar, payGrade: u.payGrade,
      isAdmin: u.isAdmin, canViewMonitoring: u.canViewMonitoring, desc: u.desc
    };
    const token = signToken({ username: u.username });
    const claims = jwt.decode(token);
    await sql`
      INSERT INTO security_events (event_type, username, fingerprint, ip_address, detail)
      VALUES ('auth_session_issued', ${u.username}, ${fp}, ${ipLogin}, ${'jti:' + claims.jti})
    `;
    res.json({ username: u.username, profile, token });
  } catch (err) {
    safeError(res, err);
  }
});

app.post('/api/logout', authRequired, async (req, res) => {
  try {
    if (!needDb(res)) return;
    await sql`
      INSERT INTO security_events (event_type, username, ip_address, detail)
      VALUES ('auth_session_revoked', ${req.user.sub}, ${clientIp(req)}, ${'jti:' + req.user.jti})
    `;
    return res.json({ ok: true });
  } catch (err) {
    safeError(res, err);
  }
});

registerGoogleSheetsRoutes({ app, sql, authRequired, needDb, safeError });

app.get('/api/me', authRequired, async (req, res) => {
  try {
    if (!needDb(res)) return;
    const rows = await sql`
      SELECT username, display_name AS name, role, avatar,
             pay_grade AS "payGrade",
             is_admin AS "isAdmin", can_view_monitoring AS "canViewMonitoring",
             description AS desc
      FROM users WHERE username = ${req.user.sub}
    `;
    if (!rows.length) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
    const u = rows[0];
    res.json({
      username: u.username,
      profile: {
        name: u.name, role: u.role, avatar: u.avatar, payGrade: u.payGrade,
        isAdmin: u.isAdmin, canViewMonitoring: u.canViewMonitoring, desc: u.desc
      }
    });
  } catch (err) {
    safeError(res, err);
  }
});

app.get('/api/users', authRequired, async (_req, res) => {
  try {
    if (!needDb(res)) return;
    const rows = await sql`
      SELECT username, display_name AS name, role, avatar,
             pay_grade AS "payGrade",
             is_admin AS "isAdmin", can_view_monitoring AS "canViewMonitoring",
             description AS desc
      FROM users ORDER BY username
    `;
    const map = {};
    rows.forEach((r) => {
      map[r.username] = {
        name: r.name, role: r.role, avatar: r.avatar, payGrade: r.payGrade,
        isAdmin: r.isAdmin, canViewMonitoring: r.canViewMonitoring, desc: r.desc
      };
    });
    res.json(map);
  } catch (err) {
    safeError(res, err);
  }
});

// ---------- Current on-duty team (active shift only) ----------
app.get('/api/on-duty', authRequired, async (req, res) => {
  try {
    if (!needDb(res)) return;
    const today = thaiNow().date;
    const rows = await sql`
      SELECT DISTINCT ON (s.username)
             s.username,
             u.display_name AS name,
             u.role,
             u.avatar,
             s.time_th AS "checkInTime",
             s.datetime AS "checkInAt"
      FROM public.shift_logs s
      INNER JOIN public.users u ON u.username = s.username
      WHERE s.type = 'เข้าเวร'
        AND s.duration IS NULL
        AND s.date_th = ${today}
      ORDER BY s.username, s.created_at DESC
    `;
    rows.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'th'));
    return res.json(rows);
  } catch (err) {
    safeError(res, err);
  }
});

// ---------- Shifts ----------
app.get('/api/shifts', authRequired, async (req, res) => {
  try {
    if (!needDb(res)) return;
    const { username } = req.query;
    const canSeeAll = req.user.canViewMonitoring || req.user.isAdmin;
    let target = username;
    if (!canSeeAll) target = req.user.sub;

    let rows;
    if (target) {
      rows = await sql`
        SELECT id, username, type, datetime, date_th AS date, time_th AS time,
               duration, is_forced AS "isForced"
        FROM shift_logs WHERE username = ${target}
        ORDER BY created_at DESC LIMIT 500
      `;
    } else {
      rows = await sql`
        SELECT id, username, type, datetime, date_th AS date, time_th AS time,
               duration, is_forced AS "isForced"
        FROM shift_logs ORDER BY created_at DESC LIMIT 2000
      `;
    }
    const log = {};
    for (const r of rows) {
      if (!log[r.username]) log[r.username] = [];
      log[r.username].push({
        id: r.id, type: r.type, datetime: r.datetime,
        date: r.date, time: r.time, duration: r.duration, isForced: r.isForced
      });
    }
    res.json(log);
  } catch (err) {
    safeError(res, err);
  }
});

app.post('/api/shift-checkin', authRequired, async (req, res) => {
  try {
    if (!needDb(res)) return;
    const username = req.user.sub;
    const t = thaiNow();

    // The partial unique index is the final concurrency guard. The NOT EXISTS
    // clause provides a friendly normal-path response before the insert.
    const inserted = await sql`
      INSERT INTO shift_logs (username, type, datetime, date_th, time_th)
      SELECT ${username}, 'เข้าเวร', ${t.iso}, ${t.date}, ${t.time}
      WHERE NOT EXISTS (
        SELECT 1 FROM shift_logs
        WHERE username = ${username} AND type = 'เข้าเวร'
          AND duration IS NULL AND date_th = ${t.date}
      )
      RETURNING id, username, type, datetime, date_th AS date, time_th AS time
    `;
    if (!inserted.length) return res.status(409).json({ error: 'เข้าเวรอยู่แล้ว' });

    const profile = await lookupUserProfile(username);
    notifyDiscordShift({
      type: 'เข้าเวร',
      username,
      displayName: profile.name,
      role: profile.role,
      date: t.date,
      time: t.time
    }).catch(() => {});
    const googleSheetsSync = await safeGoogleQueueShift(sql, username, inserted[0].id);
    return res.json({ ...inserted[0], googleSheetsSync });
  } catch (err) {
    if (err?.code === '23505') return res.status(409).json({ error: 'เข้าเวรอยู่แล้ว' });
    safeError(res, err);
  }
});

app.post('/api/shift-checkout', authRequired, async (req, res) => {
  try {
    if (!needDb(res)) return;
    const { isForced = false, username: targetUser } = req.body || {};
    if (typeof isForced !== 'boolean') {
      return res.status(400).json({ error: 'isForced ต้องเป็น boolean' });
    }
    if (targetUser !== undefined && (typeof targetUser !== 'string' || targetUser.length > 64)) {
      return res.status(400).json({ error: 'ชื่อผู้ใช้ไม่ถูกต้อง' });
    }

    let username = req.user.sub;
    if (isForced && targetUser && targetUser !== req.user.sub) {
      if (!req.user.canViewMonitoring && !req.user.isAdmin) {
        return res.status(403).json({ error: 'ไม่มีสิทธิ์บังคับออกเวร' });
      }
      username = targetUser;
    }

    const t = thaiNow();
    // Lock the selected open shift, close it, and insert its checkout event
    // within one statement so concurrent checkout requests cannot duplicate it.
    const inserted = await sql`
      WITH candidate AS (
        SELECT id,
          GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (${t.iso}::timestamptz - datetime))))::bigint AS total_seconds
        FROM shift_logs
        WHERE username = ${username} AND type = 'เข้าเวร'
          AND duration IS NULL AND date_th = ${t.date}
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
      ),
      updated AS (
        UPDATE shift_logs AS shift
        SET duration =
          CASE WHEN candidate.total_seconds >= 3600
            THEN (candidate.total_seconds / 3600)::text || ' ชม. '
            ELSE '' END ||
          CASE WHEN candidate.total_seconds >= 60
            THEN ((candidate.total_seconds % 3600) / 60)::text || ' นาที '
            ELSE '' END ||
          (candidate.total_seconds % 60)::text || ' วินาที'
        FROM candidate
        WHERE shift.id = candidate.id
        RETURNING shift.id AS shift_log_id, shift.username, shift.duration
      ),
      checkout_event AS (
        INSERT INTO shift_logs (username, type, date_th, time_th, duration, is_forced)
        SELECT username, 'ออกเวร', ${t.date}, ${t.time}, duration, ${isForced}
        FROM updated
        RETURNING id, username, type, date_th AS date, time_th AS time,
                  duration, is_forced AS "isForced"
      )
      SELECT checkout_event.*, updated.shift_log_id
      FROM checkout_event CROSS JOIN updated
    `;

    if (!inserted.length) return res.status(409).json({ error: 'ไม่พบเวรที่ค้างอยู่' });
    const result = inserted[0];
    const profile = await lookupUserProfile(username);
    notifyDiscordShift({
      type: 'ออกเวร',
      username,
      displayName: profile.name,
      role: profile.role,
      date: t.date,
      time: t.time,
      duration: result.duration,
      isForced
    }).catch(() => {});
    const googleSheetsSync = await safeGoogleQueueShift(sql, username, result.shift_log_id);
    return res.json({ ...result, googleSheetsSync });
  } catch (err) {
    safeError(res, err);
  }
});

// ---------- Fund ----------
app.get('/api/fund', authRequired, async (_req, res) => {
  try {
    if (!needDb(res)) return;
    const fundRows = await sql`SELECT * FROM central_fund WHERE id = 1`;
    const hist = await sql`
      SELECT username, type, amount, note, date_th AS date, time_th AS time
      FROM fund_history ORDER BY created_at DESC LIMIT 50
    `;
    const f = fundRows[0] || {};
    res.json({
      balance: Number(f.balance) || 0,
      allocations: {
        cash: Number(f.cash) || 0,
        deposit: Number(f.deposit) || 0,
        reserve: Number(f.reserve) || 0
      },
      totals: {
        income: Number(f.total_income) || 0,
        expense: Number(f.total_expense) || 0
      },
      history: hist.map((h) => ({
        username: h.username, type: h.type, amount: Number(h.amount),
        note: h.note, date: h.date, time: h.time
      }))
    });
  } catch (err) {
    safeError(res, err);
  }
});

app.post('/api/fund-tx', authRequired, async (req, res) => {
  try {
    if (!needDb(res)) return;
    const { type, amount, note = '', target } = req.body || {};
    const rawAmount = Number(amount);
    const cents = Math.round(rawAmount * 100);
    if (!Number.isFinite(rawAmount) || rawAmount <= 0 || rawAmount > 1000000000 ||
        Math.abs(rawAmount * 100 - cents) > 1e-7) {
      return res.status(400).json({ error: 'จำนวนเงินต้องมากกว่า 0 และมีทศนิยมได้ไม่เกิน 2 ตำแหน่ง' });
    }
    if (!['deposit', 'withdraw', 'admin_add'].includes(type)) {
      return res.status(400).json({ error: 'ประเภทธุรกรรมไม่ถูกต้อง' });
    }
    if (type === 'admin_add') {
      if (!req.user.isAdmin) return res.status(403).json({ error: 'เฉพาะแอดมินเท่านั้น' });
      if (!['deposit', 'reserve'].includes(target)) {
        return res.status(400).json({ error: 'เป้าหมายเงินต้องเป็น deposit หรือ reserve' });
      }
    }
    const amt = cents / 100;
    const memo = String(note || '').trim();
    if (memo.length > 500) return res.status(400).json({ error: 'หมายเหตุต้องไม่เกิน 500 ตัวอักษร' });

    const username = req.user.sub;
    const t = thaiNow();
    const historyType = type === 'deposit' ? 'ฝาก' :
      type === 'withdraw' ? 'ถอน' : target === 'deposit' ? 'เพิ่มเงินฝาก' : 'เพิ่มเงินสำรอง';

    // The balance mutation and ledger insert commit in one SQL statement.
    // PostgreSQL row locking serializes concurrent withdrawals/deposits.
    const result = await sql`
      WITH updated AS (
        UPDATE central_fund
        SET
          balance = balance + CASE
            WHEN ${type} = 'withdraw' THEN (0::numeric - ${amt}::numeric)
            ELSE ${amt}::numeric
          END,
          cash = CASE
            WHEN ${type} = 'deposit' THEN cash + ${amt}::numeric
            WHEN ${type} = 'withdraw' THEN cash - ${amt}::numeric
            ELSE cash
          END,
          deposit = CASE WHEN ${type} = 'admin_add' AND ${target} = 'deposit'
                         THEN deposit + ${amt}::numeric ELSE deposit END,
          reserve = CASE WHEN ${type} = 'admin_add' AND ${target} = 'reserve'
                         THEN reserve + ${amt}::numeric ELSE reserve END,
          total_income = total_income + CASE
            WHEN ${type} IN ('deposit', 'admin_add') THEN ${amt}::numeric
            ELSE 0::numeric
          END,
          total_expense = total_expense + CASE
            WHEN ${type} = 'withdraw' THEN ${amt}::numeric
            ELSE 0::numeric
          END,
          updated_at = NOW()
        WHERE id = 1 AND (${type} <> 'withdraw' OR cash >= ${amt}::numeric)
        RETURNING balance
      ),
      history AS (
        INSERT INTO fund_history (username, type, amount, note, date_th, time_th)
        SELECT ${username}, ${historyType}, ${amt}, ${memo}, ${t.date}, ${t.time}
        FROM updated
        RETURNING id
      )
      SELECT updated.balance FROM updated INNER JOIN history ON TRUE
    `;

    if (!result.length) {
      const exists = await sql`SELECT id, cash, balance FROM central_fund WHERE id = 1`;
      if (!exists.length) return res.status(500).json({ error: 'ไม่พบข้อมูลกองกลาง' });
      const availableCash = Number(exists[0].cash) || 0;
      if (type === 'withdraw' && availableCash < amt) {
        return res.status(409).json({
          error: `เงินสดในกองกลางไม่เพียงพอ คงเหลือ ${availableCash.toLocaleString('th-TH')} บาท`,
          availableCash
        });
      }
      return res.status(409).json({ error: 'ไม่สามารถบันทึกรายการได้ กรุณาลองใหม่' });
    }

    const balance = Number(result[0].balance);
    const profile = await lookupUserProfile(username);
    notifyDiscordFund({
      title: type === 'withdraw' ? '💸 ถอนเงินกองกลาง' :
        type === 'admin_add' ? '🏦 เพิ่มเงินกองกลาง (แอดมิน)' : '💰 ฝากเงินกองกลาง',
      color: type === 'withdraw' ? 0xef4444 : 0x22c55e,
      fields: [
        { name: 'ผู้ทำรายการ', value: profile.name || username, inline: true },
        { name: 'ประเภท', value: historyType, inline: true },
        { name: 'จำนวน', value: `${amt.toLocaleString('th-TH')} บาท`, inline: true },
        { name: 'คงเหลือ', value: `${balance.toLocaleString('th-TH')} บาท`, inline: true },
        memo ? { name: 'หมายเหตุ', value: memo.slice(0, 200), inline: false } : null,
        { name: 'เวลา', value: `${t.date} ${t.time}`, inline: true }
      ]
    }).catch(() => {});
    return res.json({ ok: true, balance });
  } catch (err) {
    safeError(res, err);
  }
});

// ---------- Stock ----------
app.get('/api/stock', authRequired, async (_req, res) => {
  try {
    if (!needDb(res)) return;
    const rows = await sql`
      SELECT id, name, quantity, min_quantity AS "minQuantity", source,
             added_by AS "addedBy", manual_status AS "manualStatus",
             date_th AS date, time_th AS time
      FROM stock_items ORDER BY created_at DESC
    `;
    res.json(rows);
  } catch (err) {
    safeError(res, err);
  }
});

app.post('/api/stock', authRequired, stockManagerRequired, async (req, res) => {
  try {
    if (!needDb(res)) return;
    const { name, quantity = 0, minQuantity = 0, source = '' } = req.body || {};
    const itemName = String(name || '').trim();
    const qty = Number(quantity);
    const minQty = Number(minQuantity);
    const itemSource = String(source || '').trim();
    if (!itemName || itemName.length > 120) return res.status(400).json({ error: 'ชื่ออุปกรณ์ต้องมีความยาว 1–120 ตัวอักษร' });
    if (!Number.isSafeInteger(qty) || qty < 0 || qty > 2147483647) return res.status(400).json({ error: 'จำนวนคงเหลือต้องเป็นจำนวนเต็มไม่ติดลบ' });
    if (!Number.isSafeInteger(minQty) || minQty < 0 || minQty > 2147483647) return res.status(400).json({ error: 'จำนวนขั้นต่ำต้องเป็นจำนวนเต็มไม่ติดลบ' });
    if (itemSource.length > 200) return res.status(400).json({ error: 'แหล่งที่มาต้องไม่เกิน 200 ตัวอักษร' });

    const t = thaiNow();
    const rows = await sql`
      INSERT INTO stock_items (name, quantity, min_quantity, source, added_by, date_th, time_th)
      VALUES (${itemName}, ${qty}, ${minQty}, ${itemSource || 'ไม่ระบุแหล่งที่มา'},
              ${req.user.sub}, ${t.date}, ${t.time})
      RETURNING id, name, quantity, min_quantity AS "minQuantity", source,
                added_by AS "addedBy", manual_status AS "manualStatus",
                date_th AS date, time_th AS time
    `;
    const profile = await lookupUserProfile(req.user.sub);
    notifyDiscordStock({
      title: '📦 เพิ่มสต็อกอุปกรณ์', color: 0x3b82f6,
      fields: [
        { name: 'ผู้เพิ่ม', value: profile.name || req.user.sub, inline: true },
        { name: 'รายการ', value: itemName, inline: true },
        { name: 'จำนวน', value: `${qty} ชิ้น`, inline: true },
        { name: 'ขั้นต่ำ', value: `${minQty} ชิ้น`, inline: true },
        { name: 'แหล่งที่มา', value: itemSource || 'ไม่ระบุ', inline: true },
        { name: 'เวลา', value: `${t.date} ${t.time}`, inline: true }
      ]
    }).catch(() => {});
    return res.status(201).json(rows[0]);
  } catch (err) {
    safeError(res, err);
  }
});

app.patch('/api/stock-item', authRequired, async (req, res) => {
  try {
    if (!needDb(res)) return;
    const rawId = req.body?.id ?? req.query?.id;
    const id = String(rawId ?? '');
    if (!/^[1-9]\d{0,18}$/.test(id)) return res.status(400).json({ error: 'รหัสรายการไม่ถูกต้อง' });

    const { quantity, minQuantity, manualStatus, delta } = req.body || {};
    if (delta !== undefined) {
      const amount = Number(delta);
      if (!Number.isSafeInteger(amount) || amount === 0 || Math.abs(amount) > 1000000) {
        return res.status(400).json({ error: 'จำนวนที่ปรับต้องเป็นจำนวนเต็มตั้งแต่ 1 ถึง 1,000,000' });
      }
      if (amount > 0) {
        const role = String(req.user?.role || '').toLowerCase();
        if (!req.user?.isAdmin && !(role.includes('ผู้อำนวยการ') && !role.includes('รอง'))) {
          return res.status(403).json({ error: 'ไม่มีสิทธิ์เติมสต็อก' });
        }
      }

      const { requester = '', price = 0, note = '' } = req.body || {};
      const requestedBy = String(requester || '').trim();
      const memo = String(note || '').trim();
      const unitPrice = Number(price);
      if (requestedBy.length > 200) return res.status(400).json({ error: 'ชื่อผู้เบิกต้องไม่เกิน 200 ตัวอักษร' });
      if (amount < 0 && !requestedBy) return res.status(400).json({ error: 'กรุณาระบุชื่อผู้เบิก' });
      if (memo.length > 500) return res.status(400).json({ error: 'หมายเหตุต้องไม่เกิน 500 ตัวอักษร' });
      if (!Number.isFinite(unitPrice) || unitPrice < 0 || unitPrice > 9999999999.99 ||
          Math.abs(unitPrice * 100 - Math.round(unitPrice * 100)) > 1e-7) {
        return res.status(400).json({ error: 'ราคาต้องเป็นตัวเลขไม่ติดลบและมีทศนิยมได้ไม่เกิน 2 ตำแหน่ง' });
      }

      const t = thaiNow();
      const rows = await sql`
        WITH updated AS (
          UPDATE stock_items
          SET quantity = quantity + ${amount}, updated_at = NOW()
          WHERE id = ${id} AND quantity + ${amount} >= 0
          RETURNING id, name, quantity
        ),
        history AS (
          INSERT INTO stock_withdrawals
            (stock_id, stock_name, username, requester, quantity, is_add, price, note, date_th, time_th)
          SELECT id, name, ${req.user.sub}, ${requestedBy || null},
                 ${Math.abs(amount)}, ${amount > 0}, ${unitPrice}, ${memo}, ${t.date}, ${t.time}
          FROM updated
          RETURNING id
        )
        SELECT updated.id, updated.name, updated.quantity
        FROM updated INNER JOIN history ON TRUE
      `;

      if (!rows.length) {
        const exists = await sql`SELECT id, quantity FROM stock_items WHERE id = ${id}`;
        if (!exists.length) return res.status(404).json({ error: 'ไม่พบรายการสต็อก' });
        return res.status(409).json({ error: `สต็อกไม่พอ คงเหลือ ${exists[0].quantity} ชิ้น` });
      }

      const item = rows[0];
      const profile = await lookupUserProfile(req.user.sub);
      notifyDiscordStock({
        title: amount > 0 ? '📥 เติมสต็อกอุปกรณ์' : '📤 เบิกสต็อกอุปกรณ์',
        color: amount > 0 ? 0x22c55e : 0xf59e0b,
        fields: [
          { name: 'ผู้ทำรายการ', value: profile.name || req.user.sub, inline: true },
          { name: 'รายการ', value: item.name, inline: true },
          { name: 'จำนวน', value: `${Math.abs(amount)} ชิ้น`, inline: true },
          { name: 'คงเหลือ', value: `${item.quantity} ชิ้น`, inline: true },
          requestedBy ? { name: 'ผู้ขอ', value: requestedBy, inline: true } : null,
          memo ? { name: 'หมายเหตุ', value: memo.slice(0, 200), inline: false } : null,
          { name: 'เวลา', value: `${t.date} ${t.time}`, inline: true }
        ]
      }).catch(() => {});
      return res.json({ ok: true, quantity: Number(item.quantity) });
    }

    if (quantity === undefined && minQuantity === undefined && manualStatus === undefined) {
      return res.status(400).json({ error: 'ไม่มีข้อมูลที่ต้องการแก้ไข' });
    }
    const role = String(req.user?.role || '').toLowerCase();
    if (!req.user?.isAdmin && !(role.includes('ผู้อำนวยการ') && !role.includes('รอง'))) {
      return res.status(403).json({ error: 'ไม่มีสิทธิ์แก้ไขรายการสต็อก' });
    }

    const nextQuantity = quantity === undefined ? null : Number(quantity);
    const nextMinimum = minQuantity === undefined ? null : Number(minQuantity);
    const allowedStatuses = ['auto', 'ready', 'ordered', 'waiting', 'damaged'];
    if (nextQuantity !== null && (!Number.isSafeInteger(nextQuantity) || nextQuantity < 0 || nextQuantity > 2147483647)) {
      return res.status(400).json({ error: 'จำนวนคงเหลือต้องเป็นจำนวนเต็มไม่ติดลบ' });
    }
    if (nextMinimum !== null && (!Number.isSafeInteger(nextMinimum) || nextMinimum < 0 || nextMinimum > 2147483647)) {
      return res.status(400).json({ error: 'จำนวนขั้นต่ำต้องเป็นจำนวนเต็มไม่ติดลบ' });
    }
    if (manualStatus !== undefined && !allowedStatuses.includes(manualStatus)) {
      return res.status(400).json({ error: 'สถานะสต็อกไม่ถูกต้อง' });
    }

    const rows = await sql`
      UPDATE stock_items
      SET quantity = COALESCE(${nextQuantity}, quantity),
          min_quantity = COALESCE(${nextMinimum}, min_quantity),
          manual_status = COALESCE(${manualStatus ?? null}, manual_status),
          updated_at = NOW()
      WHERE id = ${id}
      RETURNING id, name, quantity, min_quantity AS "minQuantity",
                manual_status AS "manualStatus", updated_at AS "updatedAt"
    `;
    if (!rows.length) return res.status(404).json({ error: 'ไม่พบรายการสต็อก' });
    return res.json({ ok: true, item: rows[0] });
  } catch (err) {
    safeError(res, err);
  }
});

app.delete('/api/stock-item', authRequired, stockManagerRequired, async (req, res) => {
  try {
    if (!needDb(res)) return;
    if (!req.user.isAdmin && !req.user.canViewMonitoring) {
      return res.status(403).json({ error: 'ไม่มีสิทธิ์ลบสต็อก' });
    }
    const id = req.body?.id ?? req.query?.id;
    if (!id) return res.status(400).json({ error: 'ไม่มี id' });
    await sql`DELETE FROM stock_items WHERE id = ${id}`;
    res.json({ ok: true });
  } catch (err) {
    safeError(res, err);
  }
});

app.get('/api/stock-withdrawals', authRequired, monitoringRequired, async (_req, res) => {
  try {
    if (!needDb(res)) return;
    const rows = await sql`
      SELECT id, stock_id AS "stockId", stock_name AS "stockName", username, requester,
             quantity, is_add AS "isAdd", price, note, date_th AS date, time_th AS time
      FROM stock_withdrawals ORDER BY created_at DESC LIMIT 200
    `;
    res.json(rows);
  } catch (err) {
    safeError(res, err);
  }
});

// ---------- Vehicles ----------
app.get('/api/vehicles', authRequired, async (_req, res) => {
  try {
    if (!needDb(res)) return;
    const rows = await sql`
      SELECT id, plate, model, username, note, date_th AS date, time_th AS time
      FROM vehicles ORDER BY created_at DESC
    `;
    res.json(rows);
  } catch (err) {
    safeError(res, err);
  }
});

app.post('/api/vehicles', authRequired, async (req, res) => {
  try {
    if (!needDb(res)) return;
    const { plate, model = '', note = '' } = req.body || {};
    if (!plate) return res.status(400).json({ error: 'กรุณากรอกทะเบียนรถ' });
    const t = thaiNow();
    const rows = await sql`
      INSERT INTO vehicles (plate, model, username, note, date_th, time_th)
      VALUES (${String(plate).toUpperCase()}, ${model}, ${req.user.sub}, ${note}, ${t.date}, ${t.time})
      RETURNING id, plate, model, username, note, date_th AS date, time_th AS time
    `;
    const vehProfile = await lookupUserProfile(req.user.sub);
    notifyDiscordVehicle({
      title: '🚗 เพิ่มทะเบียนรถ',
      color: 0x8b5cf6,
      fields: [
        { name: 'เจ้าของ', value: vehProfile.name || req.user.sub, inline: true },
        { name: 'ทะเบียน', value: String(plate).toUpperCase(), inline: true },
        { name: 'รุ่น', value: model || '-', inline: true },
        note ? { name: 'หมายเหตุ', value: String(note).slice(0, 200), inline: false } : null,
        { name: 'เวลา', value: `${t.date} ${t.time}`, inline: true }
      ]
    }).catch(() => {});
    res.json(rows[0]);
  } catch (err) {
    safeError(res, err);
  }
});

app.delete('/api/vehicle-item', authRequired, async (req, res) => {
  try {
    if (!needDb(res)) return;
    const id = req.body?.id ?? req.query?.id;
    if (!id) return res.status(400).json({ error: 'ไม่มี id' });
    const rows = await sql`SELECT username FROM vehicles WHERE id = ${id}`;
    if (!rows.length) return res.status(404).json({ error: 'ไม่พบรายการ' });
    if (rows[0].username !== req.user.sub && !req.user.isAdmin) {
      return res.status(403).json({ error: 'ไม่มีสิทธิ์ลบ' });
    }
    await sql`DELETE FROM vehicles WHERE id = ${id}`;
    res.json({ ok: true });
  } catch (err) {
    safeError(res, err);
  }
});

// ---------- Shared calendar events ----------
function isValidCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.toISOString().slice(0, 10) === value;
}

function parseCalendarEventInput(body) {
  const date = String(body?.date || '').trim();
  const title = String(body?.title || '').trim();
  const description = String(body?.description || '').trim();
  const location = String(body?.location || '').trim();
  const startTime = String(body?.startTime || '').trim() || null;
  const endTime = String(body?.endTime || '').trim() || null;

  if (!isValidCalendarDate(date)) return { error: 'กรุณาเลือกวันที่ที่ถูกต้อง' };
  if (!title || title.length > 160) return { error: 'ชื่อกิจกรรมต้องมีความยาว 1–160 ตัวอักษร' };
  if (description.length > 3000) return { error: 'รายละเอียดกิจกรรมยาวเกิน 3,000 ตัวอักษร' };
  if (location.length > 180) return { error: 'สถานที่ยาวเกิน 180 ตัวอักษร' };
  const validTime = (value) => !value || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
  if (!validTime(startTime) || !validTime(endTime)) return { error: 'รูปแบบเวลาไม่ถูกต้อง' };
  if (endTime && !startTime) return { error: 'กรุณาระบุเวลาเริ่มก่อนเวลาเสร็จสิ้น' };
  if (startTime && endTime && endTime < startTime) return { error: 'เวลาเสร็จสิ้นต้องไม่ก่อนเวลาเริ่ม' };

  return {
    value: {
      date,
      title,
      description: description || null,
      location: location || null,
      startTime,
      endTime
    }
  };
}

app.get('/api/calendar-events', authRequired, async (req, res) => {
  try {
    if (!needDb(res)) return;
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    if (!isValidCalendarDate(from) || !isValidCalendarDate(to) || from > to) {
      return res.status(400).json({ error: 'ช่วงวันที่ปฏิทินไม่ถูกต้อง' });
    }
    const daySpan = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000;
    if (daySpan > 92) return res.status(400).json({ error: 'เลือกดูปฏิทินได้ครั้งละไม่เกิน 93 วัน' });

    const rows = await sql`
      SELECT e.id::text AS id,
             TO_CHAR(e.event_date, 'YYYY-MM-DD') AS date,
             e.title, e.description,
             CASE WHEN e.start_time IS NULL THEN NULL ELSE TO_CHAR(e.start_time, 'HH24:MI') END AS "startTime",
             CASE WHEN e.end_time IS NULL THEN NULL ELSE TO_CHAR(e.end_time, 'HH24:MI') END AS "endTime",
             e.location,
             COALESCE(u.display_name, e.created_by, 'ผู้ใช้งานเดิม') AS "createdByName",
             e.created_at AS "createdAt",
             e.updated_at AS "updatedAt"
      FROM public.calendar_events e
      LEFT JOIN public.users u ON u.username = e.created_by
      WHERE e.event_date >= ${from}::date AND e.event_date <= ${to}::date
      ORDER BY e.event_date ASC, e.start_time ASC NULLS FIRST, e.created_at ASC, e.id ASC
    `;
    return res.json(rows);
  } catch (err) {
    safeError(res, err);
  }
});

app.post('/api/calendar-events', authRequired, calendarManagerRequired, async (req, res) => {
  try {
    if (!needDb(res)) return;
    const parsed = parseCalendarEventInput(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const event = parsed.value;
    const rows = await sql`
      INSERT INTO public.calendar_events
        (event_date, title, description, start_time, end_time, location, created_by, updated_by)
      VALUES
        (${event.date}::date, ${event.title}, ${event.description},
         ${event.startTime}::time, ${event.endTime}::time, ${event.location},
         ${req.user.sub}, ${req.user.sub})
      RETURNING id::text AS id
    `;
    return res.status(201).json({ ok: true, id: rows[0].id });
  } catch (err) {
    safeError(res, err);
  }
});

app.patch('/api/calendar-event', authRequired, calendarManagerRequired, async (req, res) => {
  try {
    if (!needDb(res)) return;
    const id = String(req.body?.id || '').trim();
    if (!/^[1-9]\d{0,18}$/.test(id)) return res.status(400).json({ error: 'รหัสกิจกรรมไม่ถูกต้อง' });
    const parsed = parseCalendarEventInput(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const event = parsed.value;
    const rows = await sql`
      UPDATE public.calendar_events
      SET event_date = ${event.date}::date,
          title = ${event.title},
          description = ${event.description},
          start_time = ${event.startTime}::time,
          end_time = ${event.endTime}::time,
          location = ${event.location},
          updated_by = ${req.user.sub},
          updated_at = NOW()
      WHERE id = ${id}::bigint
      RETURNING id::text AS id
    `;
    if (!rows.length) return res.status(404).json({ error: 'ไม่พบกิจกรรมนี้' });
    return res.json({ ok: true, id: rows[0].id });
  } catch (err) {
    safeError(res, err);
  }
});

app.delete('/api/calendar-event', authRequired, calendarManagerRequired, async (req, res) => {
  try {
    if (!needDb(res)) return;
    const id = String(req.body?.id || req.query?.id || '').trim();
    if (!/^[1-9]\d{0,18}$/.test(id)) return res.status(400).json({ error: 'รหัสกิจกรรมไม่ถูกต้อง' });
    const rows = await sql`
      DELETE FROM public.calendar_events WHERE id = ${id}::bigint
      RETURNING id::text AS id
    `;
    if (!rows.length) return res.status(404).json({ error: 'ไม่พบกิจกรรมนี้' });
    return res.json({ ok: true });
  } catch (err) {
    safeError(res, err);
  }
});

// ---------- Leave requests ----------
const ALLOWED_LEAVE_TYPES = new Set(['ลาป่วย', 'ลากิจ', 'ลาพักผ่อน', 'อื่นๆ']);

function parseLeaveRequestInput(body) {
  const leaveType = String(body?.leaveType || '').trim();
  const startDate = String(body?.startDate || '').trim();
  const endDate = String(body?.endDate || '').trim();
  const reason = String(body?.reason || '').trim();

  if (!ALLOWED_LEAVE_TYPES.has(leaveType)) return { error: 'กรุณาเลือกประเภทการลาให้ถูกต้อง' };
  if (!isValidCalendarDate(startDate) || !isValidCalendarDate(endDate)) {
    return { error: 'กรุณาระบุวันที่เริ่มลาและวันสิ้นสุดให้ถูกต้อง' };
  }
  if (endDate < startDate) return { error: 'วันสิ้นสุดต้องไม่ก่อนวันเริ่มลา' };
  const days = (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000 + 1;
  if (days > 90) return { error: 'คำขอลาแต่ละครั้งต้องไม่เกิน 90 วัน' };
  if (!reason || reason.length < 3 || reason.length > 1000) {
    return { error: 'กรุณาระบุเหตุผลการลา 3–1,000 ตัวอักษร' };
  }
  return { value: { leaveType, startDate, endDate, reason } };
}

app.get('/api/leave-requests', authRequired, async (req, res) => {
  try {
    if (!needDb(res)) return;
    const approver = canApproveLeave(req.user);
    const rows = approver
      ? await sql`
          SELECT r.id::text AS id, r.username,
                 COALESCE(u.display_name, r.username) AS "requesterName",
                 u.role AS "requesterRole",
                 r.leave_type AS "leaveType",
                 TO_CHAR(r.start_date, 'YYYY-MM-DD') AS "startDate",
                 TO_CHAR(r.end_date, 'YYYY-MM-DD') AS "endDate",
                 r.reason, r.status,
                 r.review_note AS "reviewNote",
                 COALESCE(reviewer.display_name, r.reviewed_by) AS "reviewedByName",
                 r.reviewed_at AS "reviewedAt",
                 r.created_at AS "createdAt",
                 r.updated_at AS "updatedAt"
          FROM public.leave_requests r
          LEFT JOIN public.users u ON u.username = r.username
          LEFT JOIN public.users reviewer ON reviewer.username = r.reviewed_by
          ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END,
                   r.created_at DESC, r.id DESC
          LIMIT 500
        `
      : await sql`
          SELECT r.id::text AS id, r.username,
                 COALESCE(u.display_name, r.username) AS "requesterName",
                 u.role AS "requesterRole",
                 r.leave_type AS "leaveType",
                 TO_CHAR(r.start_date, 'YYYY-MM-DD') AS "startDate",
                 TO_CHAR(r.end_date, 'YYYY-MM-DD') AS "endDate",
                 r.reason, r.status,
                 r.review_note AS "reviewNote",
                 COALESCE(reviewer.display_name, r.reviewed_by) AS "reviewedByName",
                 r.reviewed_at AS "reviewedAt",
                 r.created_at AS "createdAt",
                 r.updated_at AS "updatedAt"
          FROM public.leave_requests r
          LEFT JOIN public.users u ON u.username = r.username
          LEFT JOIN public.users reviewer ON reviewer.username = r.reviewed_by
          WHERE r.username = ${req.user.sub}
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT 200
        `;
    return res.json(rows);
  } catch (err) {
    safeError(res, err);
  }
});

app.post('/api/leave-requests', authRequired, async (req, res) => {
  try {
    if (!needDb(res)) return;
    const parsed = parseLeaveRequestInput(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const request = parsed.value;
    const rows = await sql`
      INSERT INTO public.leave_requests
        (username, leave_type, start_date, end_date, reason)
      VALUES
        (${req.user.sub}, ${request.leaveType}, ${request.startDate}::date,
         ${request.endDate}::date, ${request.reason})
      RETURNING id::text AS id
    `;
    return res.status(201).json({ ok: true, id: rows[0].id });
  } catch (err) {
    safeError(res, err);
  }
});

app.patch('/api/leave-request', authRequired, leaveApproverRequired, async (req, res) => {
  try {
    if (!needDb(res)) return;
    const id = String(req.body?.id || '').trim();
    const status = String(req.body?.status || '').trim();
    const reviewNote = String(req.body?.reviewNote || '').trim();
    if (!/^[1-9]\d{0,18}$/.test(id)) return res.status(400).json({ error: 'รหัสคำขอไม่ถูกต้อง' });
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'สถานะการพิจารณาไม่ถูกต้อง' });
    }
    if (reviewNote.length > 1000) return res.status(400).json({ error: 'หมายเหตุยาวเกิน 1,000 ตัวอักษร' });
    if (status === 'rejected' && reviewNote.length < 3) {
      return res.status(400).json({ error: 'กรุณาระบุเหตุผลที่ไม่อนุมัติอย่างน้อย 3 ตัวอักษร' });
    }

    const rows = await sql`
      UPDATE public.leave_requests
      SET status = ${status},
          review_note = ${reviewNote || null},
          reviewed_by = ${req.user.sub},
          reviewed_at = NOW(),
          updated_at = NOW()
      WHERE id = ${id}::bigint AND status = 'pending'
      RETURNING id::text AS id, status
    `;
    if (!rows.length) {
      const existing = await sql`SELECT status FROM public.leave_requests WHERE id = ${id}::bigint LIMIT 1`;
      if (!existing.length) return res.status(404).json({ error: 'ไม่พบคำขอลานี้' });
      return res.status(409).json({ error: 'คำขอนี้ได้รับการพิจารณาไปแล้ว', status: existing[0].status });
    }
    return res.json({ ok: true, ...rows[0] });
  } catch (err) {
    safeError(res, err);
  }
});

// ---------- Doctors ----------
app.get('/api/doctors', authRequired, async (_req, res) => {
  try {
    if (!needDb(res)) return;
    const rows = await sql`
      SELECT id, name, role, note, added_by AS "addedBy", date_th AS date, time_th AS time
      FROM doctors ORDER BY created_at DESC
    `;
    res.json(rows);
  } catch (err) {
    safeError(res, err);
  }
});

app.post('/api/doctors', authRequired, async (req, res) => {
  try {
    if (!needDb(res)) return;
    if (!req.user.isAdmin && !req.user.canViewMonitoring) {
      return res.status(403).json({ error: 'ไม่มีสิทธิ์เพิ่มรายชื่อแพทย์' });
    }
    const { name, role = '', note = '' } = req.body || {};
    if (!name) return res.status(400).json({ error: 'กรุณากรอกชื่อแพทย์' });
    const t = thaiNow();
    const rows = await sql`
      INSERT INTO doctors (name, role, note, added_by, date_th, time_th)
      VALUES (${name}, ${role}, ${note}, ${req.user.sub}, ${t.date}, ${t.time})
      RETURNING id, name, role, note, added_by AS "addedBy", date_th AS date, time_th AS time
    `;
    res.json(rows[0]);
  } catch (err) {
    safeError(res, err);
  }
});

app.delete('/api/doctor-item', authRequired, async (req, res) => {
  try {
    if (!needDb(res)) return;
    if (!req.user.isAdmin) return res.status(403).json({ error: 'เฉพาะแอดมินเท่านั้นที่ลบได้' });
    const id = req.body?.id ?? req.query?.id;
    if (!id) return res.status(400).json({ error: 'ไม่มี id' });
    await sql`DELETE FROM doctors WHERE id = ${id}`;
    res.json({ ok: true });
  } catch (err) {
    safeError(res, err);
  }
});


// ---------- Security / device / ban ----------
app.post('/api/security-check', securityCheckLimiter, async (req, res) => {
  try {
    if (!needDb(res)) return;
    const { fingerprint } = req.body || {};
    const ip = clientIp(req);
    const ban = await isBanned({ fingerprint, ip });
    if (ban) {
      await logSecurityEvent({
        eventType: 'blocked_access',
        fingerprint,
        ip,
        detail: ban.reason || 'banned'
      });
      return res.status(403).json({
        banned: true,
        reason: ban.reason || 'บัญชีหรืออุปกรณ์นี้ถูกระงับการใช้งาน'
      });
    }
    res.json({ banned: false, ip });
  } catch (err) {
    safeError(res, err);
  }
});

app.post('/api/device-report', authRequired, async (req, res) => {
  try {
    if (!needDb(res)) return;
    const { fingerprint, userAgent, screen, platform, language } = req.body || {};
    if (typeof fingerprint !== 'string' || !fingerprint.trim() || fingerprint.length > 128) return res.status(400).json({ error: 'fingerprint ไม่ถูกต้อง' });
    if (typeof userAgent === 'string' && userAgent.length > 512) return res.status(400).json({ error: 'userAgent ยาวเกินกำหนด' });
    if (typeof screen === 'string' && screen.length > 40) return res.status(400).json({ error: 'screen ยาวเกินกำหนด' });
    if (typeof platform === 'string' && platform.length > 100) return res.status(400).json({ error: 'platform ยาวเกินกำหนด' });
    if (typeof language === 'string' && language.length > 35) return res.status(400).json({ error: 'language ยาวเกินกำหนด' });
    const ip = clientIp(req);
    const ban = await isBanned({ fingerprint, ip });
    if (ban) {
      return res.status(403).json({ banned: true, reason: ban.reason || 'ถูกระงับ' });
    }
    await sql`
      INSERT INTO device_sessions (username, fingerprint, ip_address, user_agent, screen, platform, language)
      VALUES (${req.user.sub}, ${fingerprint}, ${ip}, ${userAgent || null}, ${screen || null}, ${platform || null}, ${language || null})
    `;
    await logSecurityEvent({
      eventType: 'login_device',
      username: req.user.sub,
      fingerprint,
      ip,
      detail: userAgent || ''
    });
    res.json({ ok: true, ip });
  } catch (err) {
    safeError(res, err);
  }
});

app.get('/api/security-bans', authRequired, async (req, res) => {
  try {
    if (!needDb(res)) return;
    if (!req.user.isAdmin) return res.status(403).json({ error: 'เฉพาะแอดมิน' });
    const rows = await sql`
      SELECT id, fingerprint, ip_address AS "ipAddress", username, reason,
             banned_by AS "bannedBy", active, created_at AS "createdAt"
      FROM security_bans
      ORDER BY created_at DESC
      LIMIT 200
    `;
    res.json(rows);
  } catch (err) {
    safeError(res, err);
  }
});

app.get('/api/security-sessions', authRequired, async (req, res) => {
  try {
    if (!needDb(res)) return;
    if (!req.user.isAdmin) return res.status(403).json({ error: 'เฉพาะแอดมิน' });
    const rows = await sql`
      SELECT id, username, fingerprint, ip_address AS "ipAddress", user_agent AS "userAgent",
             screen, platform, language, last_seen_at AS "lastSeenAt", created_at AS "createdAt"
      FROM device_sessions
      ORDER BY created_at DESC
      LIMIT 300
    `;
    res.json(rows);
  } catch (err) {
    safeError(res, err);
  }
});

// ---- IP geolocation (เมนูลับ intel) — cache ในหน่วยความจำ ----
const geoCache = new Map();
const GEO_TTL_MS = 6 * 60 * 60 * 1000;

function isPrivateIp(ip) {
  if (!ip) return true;
  const s = String(ip).replace(/^::ffff:/, '');
  if (s === '::1' || s === '127.0.0.1' || s === 'localhost') return true;
  if (/^10\./.test(s)) return true;
  if (/^192\.168\./.test(s)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(s)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[0-2]\d)\./.test(s)) return true;
  return false;
}

function emptyGeo(clean, extra = {}) {
  return {
    ip: clean || null,
    private: false,
    country: null,
    region: null,
    city: null,
    zip: null,
    timezone: null,
    lat: null,
    lon: null,
    isp: null,
    org: null,
    as: null,
    sources: [],
    label: 'ไม่พบตำแหน่ง',
    ...extra
  };
}

async function fetchJsonTimeout(url, ms = 4500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** รวมหลายแหล่งเพื่อตำแหน่งละเอียดที่สุดที่ทำได้จาก IP สาธารณะ */
async function lookupIpGeo(ip, { precise = false } = {}) {
  const clean = String(ip || '').replace(/^::ffff:/, '').trim();
  if (!clean || isPrivateIp(clean)) {
    return emptyGeo(clean, {
      private: true,
      label: 'เครือข่ายภายใน / ไม่ระบุสาธารณะ'
    });
  }

  const cacheKey = precise ? `p:${clean}` : clean;
  const cached = geoCache.get(cacheKey);
  if (cached && Date.now() - cached.at < GEO_TTL_MS) return cached.data;

  const data = emptyGeo(clean);
  const sources = [];

  // แหล่ง 1: ip-api.com (รายละเอียดครบ)
  const j1 = await fetchJsonTimeout(
    `http://ip-api.com/json/${encodeURIComponent(clean)}?fields=status,message,country,regionName,city,zip,lat,lon,timezone,isp,org,as,query`
  );
  if (j1 && j1.status === 'success') {
    data.ip = j1.query || clean;
    data.country = j1.country || data.country;
    data.region = j1.regionName || data.region;
    data.city = j1.city || data.city;
    data.zip = j1.zip || data.zip;
    data.timezone = j1.timezone || data.timezone;
    if (typeof j1.lat === 'number') data.lat = j1.lat;
    if (typeof j1.lon === 'number') data.lon = j1.lon;
    data.isp = j1.isp || data.isp;
    data.org = j1.org || data.org;
    data.as = j1.as || data.as;
    sources.push('ip-api');
  }

  // แหล่ง 2: ipwho.is (HTTPS) — ยืนยัน/เติมช่องว่าง
  if (precise || !data.city || data.lat == null) {
    const j2 = await fetchJsonTimeout(`https://ipwho.is/${encodeURIComponent(clean)}`);
    if (j2 && j2.success !== false && (j2.ip || j2.latitude != null)) {
      data.ip = j2.ip || data.ip;
      data.country = data.country || j2.country || null;
      data.region = data.region || j2.region || null;
      data.city = data.city || j2.city || null;
      data.zip = data.zip || j2.postal || null;
      data.timezone = data.timezone || j2.timezone?.id || j2.timezone || null;
      if (data.lat == null && typeof j2.latitude === 'number') data.lat = j2.latitude;
      if (data.lon == null && typeof j2.longitude === 'number') data.lon = j2.longitude;
      // ถ้า precise: เฉลี่ยพิกัดถ้าทั้งสองแหล่งมีค่าใกล้กัน
      if (precise && typeof j2.latitude === 'number' && typeof data.lat === 'number') {
        const dLat = Math.abs(j2.latitude - data.lat);
        const dLon = Math.abs((j2.longitude || 0) - (data.lon || 0));
        if (dLat < 1 && dLon < 1) {
          data.lat = (data.lat + j2.latitude) / 2;
          data.lon = ((data.lon || 0) + (j2.longitude || 0)) / 2;
        }
      }
      data.isp = data.isp || j2.connection?.isp || j2.isp || null;
      data.org = data.org || j2.connection?.org || j2.org || null;
      sources.push('ipwho');
    }
  }

  const parts = [data.city, data.region, data.country].filter(Boolean);
  data.label = parts.length ? parts.join(', ') : (data.country || (sources.length ? 'ไม่ระบุเมือง' : 'lookup ไม่สำเร็จ'));
  data.sources = sources;
  data.accuracyNote = 'ตำแหน่งจาก IP สาธารณะ — โดยทั่วไปละเอียดระดับเมือง/ย่าน ไม่ใช่พิกัดบ้าน';

  geoCache.set(cacheKey, { data, at: Date.now() });
  return data;
}

/** เมนูลับ: เซสชัน + ถอดตำแหน่งจาก IP */
app.get('/api/security-intel', authRequired, async (req, res) => {
  try {
    if (!needDb(res)) return;
    if (!req.user.isAdmin) return res.status(403).json({ error: 'เฉพาะแอดมิน' });
    const rows = await sql`
      SELECT id, username, fingerprint, ip_address AS "ipAddress", user_agent AS "userAgent",
             screen, platform, language, last_seen_at AS "lastSeenAt", created_at AS "createdAt"
      FROM device_sessions
      ORDER BY created_at DESC
      LIMIT 120
    `;
    const uniqueIps = [...new Set(rows.map((r) => r.ipAddress).filter(Boolean))];
    const geoMap = {};
    for (let i = 0; i < uniqueIps.length; i += 5) {
      const chunk = uniqueIps.slice(i, i + 5);
      const results = await Promise.all(chunk.map((ip) => lookupIpGeo(ip)));
      chunk.forEach((ip, idx) => {
        geoMap[ip] = results[idx];
      });
    }
    // รายการ IP ให้เลือกใน UI
    const ipOptions = [];
    const seen = new Set();
    for (const r of rows) {
      if (!r.ipAddress || seen.has(r.ipAddress)) continue;
      seen.add(r.ipAddress);
      ipOptions.push({
        ip: r.ipAddress,
        username: r.username,
        lastSeenAt: r.lastSeenAt || r.createdAt,
        geo: geoMap[r.ipAddress] || null
      });
    }
    const items = rows.map((r) => ({
      ...r,
      geo: r.ipAddress ? (geoMap[r.ipAddress] || null) : null
    }));
    res.json({
      items,
      ipOptions,
      uniqueIpCount: uniqueIps.length,
      generatedAt: new Date().toISOString()
    });
  } catch (err) {
    safeError(res, err);
  }
});

/** ถอดตำแหน่ง IP เดี่ยวแบบละเอียด (เลือก IP ใครก็ได้) */
app.post('/api/security-geo', authRequired, async (req, res) => {
  try {
    if (!needDb(res)) return;
    if (!req.user.isAdmin) return res.status(403).json({ error: 'เฉพาะแอดมิน' });
    const raw = String(req.body?.ip || '').trim();
    if (!raw) return res.status(400).json({ error: 'กรุณาระบุ IP' });
    // อนุญาต IPv4 / IPv6 เบื้องต้น
    if (!/^[0-9a-fA-F:.]+$/.test(raw) || raw.length > 45) {
      return res.status(400).json({ error: 'รูปแบบ IP ไม่ถูกต้อง' });
    }
    const geo = await lookupIpGeo(raw, { precise: true });
    // หา username ที่เคยใช้ IP นี้ (ถ้ามี)
    let users = [];
    try {
      const rows = await sql`
        SELECT DISTINCT username FROM device_sessions
        WHERE ip_address = ${raw}
        ORDER BY username
        LIMIT 20
      `;
      users = rows.map((r) => r.username).filter(Boolean);
    } catch (_e) { /* ignore */ }
    res.json({ ok: true, geo, users, lookedUpAt: new Date().toISOString() });
  } catch (err) {
    safeError(res, err);
  }
});

app.post('/api/security-ban', authRequired, async (req, res) => {
  try {
    if (!needDb(res)) return;
    if (!req.user.isAdmin) return res.status(403).json({ error: 'เฉพาะแอดมิน' });
    const { fingerprint, ipAddress, username, reason } = req.body || {};
    const cleanFingerprint = typeof fingerprint === 'string' ? fingerprint.trim() : '';
    const cleanUsername = typeof username === 'string' ? username.trim().toLowerCase() : '';
    const cleanIp = typeof ipAddress === 'string' ? ipAddress.trim() : '';
    const cleanReason = typeof reason === 'string' ? reason.trim() : 'ละเมิดกฎ';
    if (!cleanFingerprint && !cleanIp && !cleanUsername) return res.status(400).json({ error: 'ระบุ fingerprint หรือ IP หรือ username' });
    if (cleanFingerprint.length > 128 || cleanUsername.length > 64 || cleanIp.length > 45 || cleanReason.length > 240) return res.status(400).json({ error: 'ข้อมูลการระงับยาวเกินกำหนด' });
    if (cleanIp && !net.isIP(cleanIp)) return res.status(400).json({ error: 'รูปแบบ IP ไม่ถูกต้อง' });
    const rows = await sql`
      INSERT INTO security_bans (fingerprint, ip_address, username, reason, banned_by, active)
      VALUES (${cleanFingerprint || null}, ${cleanIp || null}, ${cleanUsername || null}, ${cleanReason || 'ละเมิดกฎ'}, ${req.user.sub}, true)
      RETURNING id
    `;
    await logSecurityEvent({
      eventType: 'ban_created',
      username: req.user.sub,
      fingerprint: cleanFingerprint,
      ip: cleanIp,
      detail: cleanReason
    });
    res.json({ ok: true, id: rows[0].id });
  } catch (err) {
    safeError(res, err);
  }
});

app.post('/api/security-unban', authRequired, async (req, res) => {
  try {
    if (!needDb(res)) return;
    if (!req.user.isAdmin) return res.status(403).json({ error: 'เฉพาะแอดมิน' });
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'ไม่มี id' });
    await sql`UPDATE security_bans SET active = false WHERE id = ${id}`;
    res.json({ ok: true });
  } catch (err) {
    safeError(res, err);
  }
});

app.post('/api/security-event', authRequired, securityEventLimiter, async (req, res) => {
  try {
    if (!needDb(res)) return;
    const { eventType, fingerprint, detail } = req.body || {};
    const allowedEventTypes = new Set(['devtools_detected', 'tamper_detected', 'rule_violation', 'client_warning', 'client_event']);
    if (typeof eventType !== 'string' || !allowedEventTypes.has(eventType)) return res.status(400).json({ error: 'ประเภทเหตุการณ์ไม่ถูกต้อง' });
    if (fingerprint !== undefined && (typeof fingerprint !== 'string' || fingerprint.length > 128)) return res.status(400).json({ error: 'fingerprint ไม่ถูกต้อง' });
    if (detail !== undefined && (typeof detail !== 'string' || detail.length > 500)) return res.status(400).json({ error: 'รายละเอียดเหตุการณ์ยาวเกินกำหนด' });
    await logSecurityEvent({
      eventType,
      username: req.user.sub,
      fingerprint: fingerprint || null,
      ip: clientIp(req),
      detail: detail || ''
    });
    // Browser telemetry is untrusted and audit-only; only server/admin policy may ban.
    return res.json({ ok: true, banned: false });
  } catch (err) {
    safeError(res, err);
  }
});

app.get('/api/health', async (_req, res) => {
  try {
    if (!sql) return res.status(503).json({ ok: false, error: 'no DATABASE_URL' });
    await sql`SELECT 1`;
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ ok: false, error: 'db error' });
  }
});


module.exports = app;
