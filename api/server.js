/**
 * Medic Shift Log API (Secure)
 * JWT + bcrypt + Helmet + rate-limit + restricted CORS
 * ไม่เสิร์ฟโฟลเดอร์ api/ และไฟล์ลับ
 */
require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { neon } = require('@neondatabase/serverless');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES = '12h';

if (!process.env.DATABASE_URL) {
  console.error('❌ ไม่พบ DATABASE_URL ใน .env');
  process.exit(1);
}
if (!JWT_SECRET || JWT_SECRET.length < 16) {
  console.error('❌ ตั้ง JWT_SECRET ใน .env ให้ยาวอย่างน้อย 16 ตัวอักษร');
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);

// ---------- Security middleware ----------
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
  .split(',').map((s) => s.trim()).filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

app.use(express.json({ limit: '100kb' }));

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'คำขอมากเกินไป ลองใหม่ภายหลัง' }
});
app.use('/api/', generalLimiter);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'ลองเข้าสู่ระบบบ่อยเกินไป รอ 15 นาที' }
});

// ---------- Static (บล็อก api/, .env, source) ----------
const publicRoot = path.join(__dirname, '..');

app.use((req, res, next) => {
  const p = req.path.toLowerCase();
  if (
    !p.startsWith('/api/') && (
      p.includes('/api/') ||
      p.endsWith('.env') ||
      p.includes('.env.') ||
      p.endsWith('server.js') ||
      p.endsWith('package.json') ||
      p.endsWith('package-lock.json') ||
      p.includes('node_modules') ||
      p.endsWith('schema.sql') ||
      p.includes('.git')
    )
  ) {
    return res.status(403).send('Forbidden');
  }
  next();
});

app.use(express.static(publicRoot, {
  dotfiles: 'deny',
  index: false,
  setHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  }
}));

// ---------- Helpers ----------
function thaiNow() {
  const now = new Date();
  return {
    now,
    date: now.toLocaleDateString('th-TH'),
    time: now.toLocaleTimeString('th-TH', { hour12: false }),
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

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'ต้องเข้าสู่ระบบก่อน' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'โทเคนหมดอายุหรือไม่ถูกต้อง' });
  }
}

function adminRequired(req, res, next) {
  if (!req.user?.isAdmin) return res.status(403).json({ error: 'สิทธิ์ไม่เพียงพอ' });
  next();
}

function monitoringRequired(req, res, next) {
  if (!req.user?.canViewMonitoring && !req.user?.isAdmin) {
    return res.status(403).json({ error: 'สิทธิ์ไม่เพียงพอ' });
  }
  next();
}

function safeError(res, err, status = 500) {
  console.error(err);
  res.status(status).json({ error: status === 500 ? 'เกิดข้อผิดพลาดภายใน' : err.message });
}

// ---------- Auth ----------
app.post('/api/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน' });
    }
    const uname = String(username).trim().toLowerCase();
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
      ok = await bcrypt.compare(password, u.password_hash);
    } else {
      ok = u.password_hash === password;
      if (ok) {
        const hashed = await bcrypt.hash(password, 10);
        await sql`UPDATE users SET password_hash = ${hashed} WHERE username = ${uname}`;
      }
    }
    if (!ok) {
      return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    }

    const profile = {
      name: u.name,
      role: u.role,
      avatar: u.avatar,
      isAdmin: u.isAdmin,
      canViewMonitoring: u.canViewMonitoring,
      desc: u.desc
    };
    const token = signToken({
      username: u.username,
      role: u.role,
      isAdmin: u.isAdmin,
      canViewMonitoring: u.canViewMonitoring
    });
    res.json({ username: u.username, profile, token });
  } catch (err) {
    safeError(res, err);
  }
});

app.get('/api/me', authRequired, async (req, res) => {
  try {
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
        name: u.name,
        role: u.role,
        avatar: u.avatar,
        isAdmin: u.isAdmin,
        canViewMonitoring: u.canViewMonitoring,
        desc: u.desc
      }
    });
  } catch (err) {
    safeError(res, err);
  }
});

app.get('/api/users', authRequired, async (_req, res) => {
  try {
    const rows = await sql`
      SELECT username, display_name AS name, role, avatar,
             is_admin AS "isAdmin", can_view_monitoring AS "canViewMonitoring",
             description AS desc
      FROM users ORDER BY username
    `;
    const map = {};
    rows.forEach((r) => {
      map[r.username] = {
        name: r.name,
        role: r.role,
        avatar: r.avatar,
        isAdmin: r.isAdmin,
        canViewMonitoring: r.canViewMonitoring,
        desc: r.desc
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

app.post('/api/shifts/checkin', authRequired, async (req, res) => {
  try {
    const username = req.user.sub;
    const t = thaiNow();
    const open = await sql`
      SELECT id FROM shift_logs
      WHERE username = ${username} AND type = 'เข้าเวร'
        AND duration IS NULL AND date_th = ${t.date}
      LIMIT 1
    `;
    if (open.length) return res.status(400).json({ error: 'เข้าเวรอยู่แล้ว' });

    const inserted = await sql`
      INSERT INTO shift_logs (username, type, datetime, date_th, time_th)
      VALUES (${username}, 'เข้าเวร', ${t.iso}, ${t.date}, ${t.time})
      RETURNING id, username, type, datetime, date_th AS date, time_th AS time
    `;
    res.json(inserted[0]);
  } catch (err) {
    safeError(res, err);
  }
});

app.post('/api/shifts/checkout', authRequired, async (req, res) => {
  try {
    const { isForced = false, username: targetUser } = req.body || {};
    let username = req.user.sub;
    if (isForced && targetUser && targetUser !== req.user.sub) {
      if (!req.user.canViewMonitoring && !req.user.isAdmin) {
        return res.status(403).json({ error: 'ไม่มีสิทธิ์บังคับออกเวร' });
      }
      username = targetUser;
    }

    const t = thaiNow();
    const openRows = await sql`
      SELECT id, datetime FROM shift_logs
      WHERE username = ${username} AND type = 'เข้าเวร'
        AND duration IS NULL AND date_th = ${t.date}
      ORDER BY created_at DESC LIMIT 1
    `;
    if (!openRows.length) return res.status(400).json({ error: 'ไม่พบเวรที่ค้างอยู่' });

    const open = openRows[0];
    const diffMin = Math.max(0, Math.floor((t.now - new Date(open.datetime)) / 60000));
    const hours = Math.floor(diffMin / 60);
    const minutes = diffMin % 60;
    const duration = hours > 0 ? `${hours} ชม. ${minutes} นาที` : `${minutes} นาที`;

    await sql`UPDATE shift_logs SET duration = ${duration} WHERE id = ${open.id}`;
    const inserted = await sql`
      INSERT INTO shift_logs (username, type, date_th, time_th, duration, is_forced)
      VALUES (${username}, 'ออกเวร', ${t.date}, ${t.time}, ${duration}, ${!!isForced})
      RETURNING id, username, type, date_th AS date, time_th AS time, duration, is_forced AS "isForced"
    `;
    res.json({ ...inserted[0], duration });
  } catch (err) {
    safeError(res, err);
  }
});

// ---------- Fund ----------
app.get('/api/fund', authRequired, async (_req, res) => {
  try {
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

app.post('/api/fund/transaction', authRequired, async (req, res) => {
  try {
    const { type, amount, note = '', target } = req.body || {};
    const username = req.user.sub;
    const amt = Number(amount);
    if (!type || !Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ error: 'ข้อมูลไม่ครบหรือจำนวนเงินไม่ถูกต้อง' });
    }
    if (type === 'admin_add' && !req.user.isAdmin) {
      return res.status(403).json({ error: 'เฉพาะแอดมินเท่านั้น' });
    }

    const t = thaiNow();
    const fundRows = await sql`SELECT * FROM central_fund WHERE id = 1`;
    const f = fundRows[0];
    if (!f) return res.status(500).json({ error: 'ไม่พบข้อมูลกองกลาง' });

    let balance = Number(f.balance);
    let cash = Number(f.cash);
    let deposit = Number(f.deposit);
    let reserve = Number(f.reserve);
    let income = Number(f.total_income);
    let expense = Number(f.total_expense);
    let histType = '';

    if (type === 'deposit') {
      balance += amt; cash += amt; income += amt; histType = 'ฝาก';
    } else if (type === 'withdraw') {
      if (amt > balance) return res.status(400).json({ error: 'ยอดเงินไม่เพียงพอ' });
      balance -= amt; cash = Math.max(0, cash - amt); expense += amt; histType = 'ถอน';
    } else if (type === 'admin_add') {
      if (target === 'deposit') {
        deposit += amt; balance += amt; histType = 'เพิ่มเงินฝาก';
      } else {
        reserve += amt; balance += amt; histType = 'เพิ่มเงินสำรอง';
      }
    } else {
      return res.status(400).json({ error: 'ประเภทธุรกรรมไม่ถูกต้อง' });
    }

    await sql`
      UPDATE central_fund SET
        balance = ${balance}, cash = ${cash}, deposit = ${deposit}, reserve = ${reserve},
        total_income = ${income}, total_expense = ${expense}, updated_at = NOW()
      WHERE id = 1
    `;
    await sql`
      INSERT INTO fund_history (username, type, amount, note, date_th, time_th)
      VALUES (${username}, ${histType}, ${amt}, ${note}, ${t.date}, ${t.time})
    `;
    res.json({ ok: true, balance });
  } catch (err) {
    safeError(res, err);
  }
});

// ---------- Stock ----------
app.get('/api/stock', authRequired, async (_req, res) => {
  try {
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

app.post('/api/stock', authRequired, async (req, res) => {
  try {
    const { name, quantity = 0, minQuantity = 0, source = '' } = req.body || {};
    if (!name) return res.status(400).json({ error: 'กรุณากรอกชื่ออุปกรณ์' });
    const t = thaiNow();
    const rows = await sql`
      INSERT INTO stock_items (name, quantity, min_quantity, source, added_by, date_th, time_th)
      VALUES (${name}, ${Math.floor(quantity)}, ${Math.floor(minQuantity)},
              ${source || 'ไม่ระบุแหล่งที่มา'}, ${req.user.sub}, ${t.date}, ${t.time})
      RETURNING id, name, quantity, min_quantity AS "minQuantity", source,
                added_by AS "addedBy", manual_status AS "manualStatus",
                date_th AS date, time_th AS time
    `;
    res.json(rows[0]);
  } catch (err) {
    safeError(res, err);
  }
});

app.patch('/api/stock/:id', authRequired, async (req, res) => {
  try {
    const id = req.params.id;
    const { quantity, minQuantity, manualStatus, delta, requester, price = 0, note = '' } = req.body || {};

    if (delta !== undefined) {
      const amt = Math.floor(Number(delta));
      const current = await sql`SELECT id, name, quantity FROM stock_items WHERE id = ${id}`;
      if (!current.length) return res.status(404).json({ error: 'ไม่พบรายการ' });
      const item = current[0];
      const newQty = Math.max(0, Number(item.quantity) + amt);
      if (amt < 0 && Math.abs(amt) > Number(item.quantity)) {
        return res.status(400).json({ error: `สต็อกไม่พอ คงเหลือ ${item.quantity} ชิ้น` });
      }
      await sql`UPDATE stock_items SET quantity = ${newQty}, updated_at = NOW() WHERE id = ${id}`;
      const t = thaiNow();
      await sql`
        INSERT INTO stock_withdrawals (stock_id, stock_name, username, requester, quantity, is_add, price, note, date_th, time_th)
        VALUES (${id}, ${item.name}, ${req.user.sub}, ${requester || null}, ${Math.abs(amt)}, ${amt > 0}, ${price}, ${note}, ${t.date}, ${t.time})
      `;
      return res.json({ ok: true, quantity: newQty });
    }

    if (quantity !== undefined) {
      await sql`UPDATE stock_items SET quantity = ${Math.floor(quantity)}, updated_at = NOW() WHERE id = ${id}`;
    }
    if (minQuantity !== undefined) {
      await sql`UPDATE stock_items SET min_quantity = ${Math.floor(minQuantity)}, updated_at = NOW() WHERE id = ${id}`;
    }
    if (manualStatus !== undefined) {
      await sql`UPDATE stock_items SET manual_status = ${manualStatus}, updated_at = NOW() WHERE id = ${id}`;
    }
    res.json({ ok: true });
  } catch (err) {
    safeError(res, err);
  }
});

app.delete('/api/stock/:id', authRequired, async (req, res) => {
  try {
    if (!req.user.isAdmin && !req.user.canViewMonitoring) {
      return res.status(403).json({ error: 'ไม่มีสิทธิ์ลบสต็อก' });
    }
    await sql`DELETE FROM stock_items WHERE id = ${req.params.id}`;
    res.json({ ok: true });
  } catch (err) {
    safeError(res, err);
  }
});

app.get('/api/stock/withdrawals', authRequired, monitoringRequired, async (_req, res) => {
  try {
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
    const { plate, model = '', note = '' } = req.body || {};
    if (!plate) return res.status(400).json({ error: 'กรุณากรอกทะเบียนรถ' });
    const t = thaiNow();
    const rows = await sql`
      INSERT INTO vehicles (plate, model, username, note, date_th, time_th)
      VALUES (${String(plate).toUpperCase()}, ${model}, ${req.user.sub}, ${note}, ${t.date}, ${t.time})
      RETURNING id, plate, model, username, note, date_th AS date, time_th AS time
    `;
    res.json(rows[0]);
  } catch (err) {
    safeError(res, err);
  }
});

app.delete('/api/vehicles/:id', authRequired, async (req, res) => {
  try {
    const rows = await sql`SELECT username FROM vehicles WHERE id = ${req.params.id}`;
    if (!rows.length) return res.status(404).json({ error: 'ไม่พบรายการ' });
    if (rows[0].username !== req.user.sub && !req.user.isAdmin) {
      return res.status(403).json({ error: 'ไม่มีสิทธิ์ลบ' });
    }
    await sql`DELETE FROM vehicles WHERE id = ${req.params.id}`;
    res.json({ ok: true });
  } catch (err) {
    safeError(res, err);
  }
});

// ---------- Doctors ----------
app.get('/api/doctors', authRequired, async (_req, res) => {
  try {
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

app.delete('/api/doctors/:id', authRequired, async (req, res) => {
  try {
    if (!req.user.isAdmin) {
      return res.status(403).json({ error: 'เฉพาะแอดมินเท่านั้นที่ลบได้' });
    }
    await sql`DELETE FROM doctors WHERE id = ${req.params.id}`;
    res.json({ ok: true });
  } catch (err) {
    safeError(res, err);
  }
});

app.get('/api/health', async (_req, res) => {
  try {
    await sql`SELECT 1`;
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(publicRoot, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Secure Medic Shift API → http://localhost:${PORT}`);
  console.log(`   เปิดเว็บ: http://localhost:${PORT}/index.html`);
});
