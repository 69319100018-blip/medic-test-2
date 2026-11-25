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
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { neon } = require('@neondatabase/serverless');

const app = express();
// Vercel terminates TLS/proxy traffic and forwards the client IP in X-Forwarded-For.
// Trust the immediate platform proxy so express-rate-limit can safely derive client IPs.
app.set('trust proxy', 1);
app.disable('x-powered-by');
const JWT_SECRET = process.env.JWT_SECRET || '';
const JWT_EXPIRES = '12h';
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

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

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

// รองรับ path ทั้งแบบ /api/... และกรณี rewrite
app.use((req, _res, next) => {
  // บางสภาพแวดล้อม Vercel ส่ง url มาไม่ครบ
  if (req.url && !req.url.startsWith('/api') && req.originalUrl && req.originalUrl.startsWith('/api')) {
    req.url = req.originalUrl;
  }
  next();
});

// Vercel: rate-limit ใช้ memory ต่อ instance (พอใช้)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'ลองเข้าสู่ระบบบ่อยเกินไป รอ 15 นาที' }
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
  return jwt.sign(
    {
      sub: user.username,
      role: user.role,
      isAdmin: !!user.isAdmin,
      canViewMonitoring: !!user.canViewMonitoring
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

async function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'ต้องเข้าสู่ระบบก่อน' });
  if (!JWT_SECRET || JWT_SECRET.length < 32 || !sql) {
    return res.status(503).json({ error: 'ระบบยืนยันตัวตนยังไม่พร้อม' });
  }

  let claims;
  try {
    claims = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ error: 'โทเคนหมดอายุหรือไม่ถูกต้อง' });
  }

  // Permissions are reloaded for every request so role changes take effect immediately.
  try {
    const rows = await sql`
      SELECT username, role, is_admin AS "isAdmin",
             can_view_monitoring AS "canViewMonitoring"
      FROM users WHERE username = ${claims.sub} LIMIT 1
    `;
    if (!rows.length) return res.status(401).json({ error: 'บัญชีนี้ไม่มีอยู่หรือถูกปิดใช้งาน' });
    const user = rows[0];
    req.user = { ...claims, sub: user.username, role: user.role,
      isAdmin: !!user.isAdmin, canViewMonitoring: !!user.canViewMonitoring };
    return next();
  } catch (err) {
    console.error('Authentication user lookup failed:', err);
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

function safeError(res, err, status = 500) {
  console.error(err);
  res.status(status).json({ error: status === 500 ? 'เกิดข้อผิดพลาดภายใน' : (err.message || 'error') });
}


function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || '';
}

async function isBanned({ fingerprint, ip }) {
  if (!sql) return null;
  const rows = await sql`
    SELECT id, reason, fingerprint, ip_address, username
    FROM security_bans
    WHERE active = true
      AND (
        (${fingerprint || null}::text IS NOT NULL AND fingerprint = ${fingerprint || null})
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
app.post('/api/register', loginLimiter, async (req, res) => {
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

    const { username, role, isAdmin, canViewMonitoring, description } = req.body || {};
    const uname = String(username || '').trim().toLowerCase();
    if (!uname || uname.length > 64) return res.status(400).json({ error: 'ชื่อผู้ใช้ไม่ถูกต้อง' });

    const hasRole = role !== undefined;
    const hasAdmin = isAdmin !== undefined;
    const hasMonitoring = canViewMonitoring !== undefined;
    const hasDescription = description !== undefined;
    if (!hasRole && !hasAdmin && !hasMonitoring && !hasDescription) {
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
    if (uname === req.user.sub && isAdmin === false) {
      return res.status(400).json({ error: 'ไม่สามารถถอดสิทธิ์แอดมินของตัวเองได้' });
    }

    // All permission fields are updated atomically; explicit false values are preserved.
    const rows = await sql`
      UPDATE users
      SET role = COALESCE(${nextRole}, role),
          is_admin = COALESCE(${hasAdmin ? isAdmin : null}, is_admin),
          can_view_monitoring = COALESCE(${hasMonitoring ? canViewMonitoring : null}, can_view_monitoring),
          description = COALESCE(${nextDescription}, description)
      WHERE username = ${uname}
      RETURNING username, display_name AS name, role, avatar,
                is_admin AS "isAdmin", can_view_monitoring AS "canViewMonitoring",
                description AS desc
    `;
    if (!rows.length) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
    return res.json({ ok: true, user: rows[0] });
  } catch (err) {
    safeError(res, err);
  }
});


app.post('/api/login', loginLimiter, async (req, res) => {
  try {
    if (!needDb(res)) return;
    if (!JWT_SECRET || JWT_SECRET.length < 32) {
      return res.status(503).json({ error: 'ยังไม่ได้ตั้งค่า JWT_SECRET ที่ปลอดภัย (อย่างน้อย 32 ตัวอักษร)' });
    }
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน' });
    }
    const uname = String(username).trim().toLowerCase();
    const pass = String(password);
    if (uname.length > 64 || Buffer.byteLength(pass, 'utf8') > 1024) {
      return res.status(400).json({ error: 'ข้อมูลเข้าสู่ระบบยาวเกินกำหนด' });
    }
    const rows = await sql`
      SELECT username, password_hash, display_name AS name, role, avatar,
             is_admin AS "isAdmin", can_view_monitoring AS "canViewMonitoring",
             description AS desc
      FROM users WHERE username = ${uname}
    `;
    if (!rows.length) {
      return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    }
    const u = rows[0];
    let ok = false;
    if (u.password_hash && u.password_hash.startsWith('$2')) {
      ok = await bcrypt.compare(pass, u.password_hash);
      // Gradually upgrade legacy bcrypt cost without forcing a mass password reset.
      if (ok && bcrypt.getRounds(u.password_hash) < 12) {
        const strongerHash = await bcrypt.hash(pass, 12);
        await sql`UPDATE users SET password_hash = ${strongerHash} WHERE username = ${uname}`;
      }
    } else {
      // One-time migration for legacy plaintext rows, removed after a successful login.
      ok = u.password_hash === pass;
      if (ok) {
        const hashed = await bcrypt.hash(pass, 12);
        await sql`UPDATE users SET password_hash = ${hashed} WHERE username = ${uname}`;
      }
    }
    if (!ok) return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });

    const fp = (req.body || {}).fingerprint || null;
    const ipLogin = clientIp(req);
    const banHit = await isBanned({ fingerprint: fp, ip: ipLogin });
    if (banHit) {
      await logSecurityEvent({ eventType: 'blocked_login', username: uname, fingerprint: fp, ip: ipLogin, detail: banHit.reason });
      return res.status(403).json({ error: banHit.reason || 'บัญชีหรืออุปกรณ์นี้ถูกระงับการใช้งาน', banned: true });
    }

    const profile = {
      name: u.name, role: u.role, avatar: u.avatar,
      isAdmin: u.isAdmin, canViewMonitoring: u.canViewMonitoring, desc: u.desc
    };
    const token = signToken({
      username: u.username, role: u.role,
      isAdmin: u.isAdmin, canViewMonitoring: u.canViewMonitoring
    });
    res.json({ username: u.username, profile, token });
  } catch (err) {
    safeError(res, err);
  }
});

app.get('/api/me', authRequired, async (req, res) => {
  try {
    if (!needDb(res)) return;
    const rows = await sql`
      SELECT username, display_name AS name, role, avatar,
             is_admin AS "isAdmin", can_view_monitoring AS "canViewMonitoring",
             description AS desc
      FROM users WHERE username = ${req.user.sub}
    `;
    if (!rows.length) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
    const u = rows[0];
    res.json({
      username: u.username,
      profile: {
        name: u.name, role: u.role, avatar: u.avatar,
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
             is_admin AS "isAdmin", can_view_monitoring AS "canViewMonitoring",
             description AS desc
      FROM users ORDER BY username
    `;
    const map = {};
    rows.forEach((r) => {
      map[r.username] = {
        name: r.name, role: r.role, avatar: r.avatar,
        isAdmin: r.isAdmin, canViewMonitoring: r.canViewMonitoring, desc: r.desc
      };
    });
    res.json(map);
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
    return res.json(inserted[0]);
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
        RETURNING shift.username, shift.duration
      ),
      checkout_event AS (
        INSERT INTO shift_logs (username, type, date_th, time_th, duration, is_forced)
        SELECT username, 'ออกเวร', ${t.date}, ${t.time}, duration, ${isForced}
        FROM updated
        RETURNING id, username, type, date_th AS date, time_th AS time,
                  duration, is_forced AS "isForced"
      )
      SELECT * FROM checkout_event
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
    return res.json(result);
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
          balance = balance + CASE WHEN ${type} = 'withdraw' THEN -${amt} ELSE ${amt} END,
          cash = CASE
            WHEN ${type} = 'deposit' THEN cash + ${amt}
            WHEN ${type} = 'withdraw' THEN GREATEST(0, cash - ${amt})
            ELSE cash
          END,
          deposit = CASE WHEN ${type} = 'admin_add' AND ${target} = 'deposit'
                         THEN deposit + ${amt} ELSE deposit END,
          reserve = CASE WHEN ${type} = 'admin_add' AND ${target} = 'reserve'
                         THEN reserve + ${amt} ELSE reserve END,
          total_income = CASE WHEN ${type} = 'deposit' THEN total_income + ${amt} ELSE total_income END,
          total_expense = CASE WHEN ${type} = 'withdraw' THEN total_expense + ${amt} ELSE total_expense END,
          updated_at = NOW()
        WHERE id = 1 AND (${type} <> 'withdraw' OR balance >= ${amt})
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
      const exists = await sql`SELECT id FROM central_fund WHERE id = 1`;
      if (!exists.length) return res.status(500).json({ error: 'ไม่พบข้อมูลกองกลาง' });
      return res.status(409).json({ error: 'ยอดเงินไม่เพียงพอสำหรับรายการนี้' });
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
    if (!/^[1-9]\\d{0,18}$/.test(id)) return res.status(400).json({ error: 'รหัสรายการไม่ถูกต้อง' });

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
app.post('/api/security-check', async (req, res) => {
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
    if (!fingerprint) return res.status(400).json({ error: 'ไม่มี fingerprint' });
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
    if (!fingerprint && !ipAddress && !username) {
      return res.status(400).json({ error: 'ระบุ fingerprint หรือ IP หรือ username' });
    }
    const rows = await sql`
      INSERT INTO security_bans (fingerprint, ip_address, username, reason, banned_by, active)
      VALUES (${fingerprint || null}, ${ipAddress || null}, ${username || null}, ${reason || 'ละเมิดกฎ'}, ${req.user.sub}, true)
      RETURNING id
    `;
    await logSecurityEvent({
      eventType: 'ban_created',
      username: req.user.sub,
      fingerprint,
      ip: ipAddress,
      detail: reason || ''
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

app.post('/api/security-event', authRequired, async (req, res) => {
  try {
    if (!needDb(res)) return;
    const { eventType, fingerprint, detail } = req.body || {};
    const ip = clientIp(req);
    await logSecurityEvent({
      eventType: eventType || 'client_event',
      username: req.user.sub,
      fingerprint,
      ip,
      detail
    });
    // ถ้าเป็นเหตุร้ายแรง บล็อกทันที (admin เท่านั้นที่กำหนดจากฝั่ง server policy)
    const severe = ['devtools_detected', 'tamper_detected', 'rule_violation'];
    if (severe.includes(eventType) && fingerprint) {
      // บันทึกเหตุการณ์ — การแบนจริงให้แอดมินกด หรือ auto-ban ถ้าต้องการ
      // auto-ban เมื่อตรวจพบ devtools ซ้ำ
      if (eventType === 'rule_violation') {
        await sql`
          INSERT INTO security_bans (fingerprint, ip_address, username, reason, banned_by, active)
          VALUES (${fingerprint}, ${ip}, ${req.user.sub}, ${detail || 'ละเมิดกฎระบบ'}, 'system', true)
        `;
        return res.json({ ok: true, banned: true });
      }
    }
    res.json({ ok: true });
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
