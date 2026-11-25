-- ============================================================
-- Medic Shift Log — Neon PostgreSQL Schema
-- รันไฟล์นี้ครั้งเดียวใน Neon SQL Editor
-- ============================================================

-- ผู้ใช้ระบบ (login)
CREATE TABLE IF NOT EXISTS users (
    username        TEXT PRIMARY KEY,
    password_hash   TEXT NOT NULL,          -- bcrypt password hash; never store plaintext
    display_name    TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'นักเรียนแพทย์',
    avatar          TEXT,
    is_admin        BOOLEAN NOT NULL DEFAULT false,
    can_view_monitoring BOOLEAN NOT NULL DEFAULT false,
    description     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- บันทึกเข้า-ออกเวร
CREATE TABLE IF NOT EXISTS shift_logs (
    id              BIGSERIAL PRIMARY KEY,
    username        TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
    type            TEXT NOT NULL CHECK (type IN ('เข้าเวร', 'ออกเวร')),
    datetime        TIMESTAMPTZ,            -- ใช้กับเข้าเวร
    date_th         TEXT,
    time_th         TEXT,
    duration        TEXT,                   -- ใช้กับออกเวร
    is_forced       BOOLEAN DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shift_logs_username_date ON shift_logs (username, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shift_logs_one_open_per_user_day
    ON shift_logs (username, date_th)
    WHERE type = 'เข้าเวร' AND duration IS NULL;

-- เงินกองกลาง (เก็บสถานะล่าสุดเป็นแถวเดียว)
CREATE TABLE IF NOT EXISTS central_fund (
    id              INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    balance         NUMERIC(14,2) NOT NULL DEFAULT 70000,
    cash            NUMERIC(14,2) NOT NULL DEFAULT 40000,
    deposit         NUMERIC(14,2) NOT NULL DEFAULT 20000,
    reserve         NUMERIC(14,2) NOT NULL DEFAULT 10000,
    total_income    NUMERIC(14,2) NOT NULL DEFAULT 0,
    total_expense   NUMERIC(14,2) NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ประวัติฝาก/ถอน/เพิ่มเงิน
CREATE TABLE IF NOT EXISTS fund_history (
    id              BIGSERIAL PRIMARY KEY,
    username        TEXT,
    type            TEXT NOT NULL,          -- ฝาก, ถอน, เพิ่มเงินฝาก, เพิ่มเงินสำรอง
    amount          NUMERIC(14,2) NOT NULL,
    note            TEXT,
    date_th         TEXT,
    time_th         TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- สต็อกอุปกรณ์
CREATE TABLE IF NOT EXISTS stock_items (
    id              BIGSERIAL PRIMARY KEY,
    name            TEXT NOT NULL,
    quantity        INT NOT NULL DEFAULT 0,
    min_quantity    INT NOT NULL DEFAULT 0,
    source          TEXT,
    added_by        TEXT,
    manual_status   TEXT DEFAULT 'auto',
    date_th         TEXT,
    time_th         TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ประวัติการเบิก/เติมสต็อก
CREATE TABLE IF NOT EXISTS stock_withdrawals (
    id              BIGSERIAL PRIMARY KEY,
    stock_id        BIGINT REFERENCES stock_items(id) ON DELETE SET NULL,
    stock_name      TEXT,
    username        TEXT,                   -- คนที่ทำรายการ
    requester       TEXT,                   -- ผู้เบิก (ถ้าเบิก)
    quantity        INT NOT NULL,
    is_add          BOOLEAN NOT NULL DEFAULT false,
    price           NUMERIC(12,2) DEFAULT 0,
    note            TEXT,
    date_th         TEXT,
    time_th         TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ทะเบียนรถ
CREATE TABLE IF NOT EXISTS vehicles (
    id              BIGSERIAL PRIMARY KEY,
    plate           TEXT NOT NULL,
    model           TEXT,
    username        TEXT,                   -- เจ้าของ
    note            TEXT,
    date_th         TEXT,
    time_th         TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- รายชื่อแพทย์
CREATE TABLE IF NOT EXISTS doctors (
    id              BIGSERIAL PRIMARY KEY,
    name            TEXT NOT NULL,
    role            TEXT,
    note            TEXT,
    added_by        TEXT,
    date_th         TEXT,
    time_th         TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ข้อมูลเริ่มต้น
INSERT INTO central_fund (id, balance, cash, deposit, reserve)
VALUES (1, 70000, 40000, 20000, 10000)
ON CONFLICT (id) DO NOTHING;

INSERT INTO users (username, password_hash, display_name, role, avatar, is_admin, can_view_monitoring, description)
VALUES
    ('talos blackagency', '$2b$10$b14My6yUItAL/vZZTonZA.GNqvWA13bQDa65QcJWo4cN66orSMoGu', 'Talos Blackagency', 'ผู้อำนวยการแพทย์', 'assets/images/talos.jpg', true,  true,  'ควบคุมและตรวจสอบทีมเวร'),
    ('noelle blackagency', '$2b$10$NN3DqBFZuViWUDuG8UXh6uKn.xPPqo6ke089NVOBLhhWUTG3Wc9rO', 'Noelle Blackagency', 'รองผู้อำนวยการแพทย์', 'assets/images/noeele.jpg', false, false, 'สนับสนุนงานประสานงาน'),
    ('jane doe', '$2b$10$h/UOy9QcG/qn29OZD0/gEOWRqleDGEkBGX9U2iXzYbxqwLTKvo7Se', 'Jane Doe', 'นักเรียนแพทย์', 'assets/images/jane.jpg', false, false, 'ดูแลผู้ป่วย')
ON CONFLICT (username) DO NOTHING;

-- อัปเดตชื่อตำแหน่งเก่าให้ตรงกับหน้าเว็บรายชื่อแพทย์ (รันได้ซ้ำ)
UPDATE users SET role = 'รองผู้อำนวยการแพทย์' WHERE role IN ('รอง.ผู้อำนวยการ', 'รอง. ผู้อำนวยการ', 'รองผู้อำนวยการ');
UPDATE users SET role = 'นักเรียนแพทย์' WHERE role IN ('พยาบาล', 'แพทย์ (รอปรับ role)', 'เจ้าหน้าที่');
UPDATE users SET role = 'แอดมินแพทย์' WHERE role IN ('แอดมิน', 'Admin', 'admin');

-- ถ้าเคยรัน schema เก่าที่มี plain password ให้อัปเดตเป็น bcrypt:
-- UPDATE users SET password_hash = '$2b$10$b14My6yUItAL/vZZTonZA.GNqvWA13bQDa65QcJWo4cN66orSMoGu' WHERE username = 'talos blackagency';
-- UPDATE users SET password_hash = '$2b$10$NN3DqBFZuViWUDuG8UXh6uKn.xPPqo6ke089NVOBLhhWUTG3Wc9rO' WHERE username = 'noelle blackagency';
-- UPDATE users SET password_hash = '$2b$10$h/UOy9QcG/qn29OZD0/gEOWRqleDGEkBGX9U2iXzYbxqwLTKvo7Se' WHERE username = 'jane doe';

-- ============================================================
-- Security: เก็บ fingerprint / IP และรายการบล็อก
-- (ดูได้เฉพาะแอดมินผ่านหน้าเว็บ / ฐานข้อมูล)
-- ============================================================

CREATE TABLE IF NOT EXISTS device_sessions (
    id              BIGSERIAL PRIMARY KEY,
    username        TEXT,
    fingerprint     TEXT NOT NULL,
    ip_address      TEXT,
    user_agent      TEXT,
    screen          TEXT,
    platform        TEXT,
    language        TEXT,
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_device_sessions_fp ON device_sessions (fingerprint);
CREATE INDEX IF NOT EXISTS idx_device_sessions_ip ON device_sessions (ip_address);
CREATE INDEX IF NOT EXISTS idx_device_sessions_user ON device_sessions (username);

CREATE TABLE IF NOT EXISTS security_bans (
    id              BIGSERIAL PRIMARY KEY,
    fingerprint     TEXT,
    ip_address      TEXT,
    username        TEXT,
    reason          TEXT,
    banned_by       TEXT,
    active          BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_security_bans_active ON security_bans (active);
CREATE INDEX IF NOT EXISTS idx_security_bans_fp ON security_bans (fingerprint) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_security_bans_ip ON security_bans (ip_address) WHERE active = true;

CREATE TABLE IF NOT EXISTS security_events (
    id              BIGSERIAL PRIMARY KEY,
    event_type      TEXT NOT NULL,
    username        TEXT,
    fingerprint     TEXT,
    ip_address      TEXT,
    detail          TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
