# Medic Shift Log + Neon (Secure)

## สิ่งที่ทำด้านความปลอดภัยแล้ว

- JWT Authentication ทุก API (ยกเว้น `/api/login`, `/api/health`)
- รหัสผ่านเก็บด้วย **bcrypt** (อัปเกรดอัตโนมัติถ้ายังเป็น plain)
- Rate limit กัน brute-force login
- Helmet + จำกัด CORS
- **ไม่เสิร์ฟ** `.env`, `server.js`, `schema.sql`, `node_modules`
- ตรวจสิทธิ์ admin / monitoring ก่อนลบหรือบังคับออกเวร
- Session ใช้ Bearer token (ไม่พึ่งแค่ username ใน sessionStorage)
- กัน Inspect / F12 ระดับพื้นฐาน (`js/anti-devtools.js`)

> หมายเหตุ: การกัน DevTools ฝั่ง browser **ข้ามได้** ถ้าตั้งใจ — ใช้เป็นชั้นเสริมเท่านั้น ความปลอดภัยจริงอยู่ที่ API + JWT

---

## ติดตั้ง

### 1) รัน SQL
Neon Console → SQL Editor → วาง `schema.sql` ทั้งหมด → Run

ถ้าเคยรัน schema เก่า ให้รันคำสั่ง UPDATE รหัสผ่านที่อยู่ในท้าย `schema.sql` ด้วย

### 2) ตั้งค่า `.env`
```bash
cd api
cp .env.example .env
```

ตัวอย่าง:
```env
DATABASE_URL=postgresql://...@...-pooler.../neondb?sslmode=require
JWT_SECRET=ใส่ค่าสุ่มยาวอย่างน้อย-32-ตัวอักษร
PORT=3000
ALLOWED_ORIGINS=http://localhost:3000
```

สร้าง JWT_SECRET:
```bash
openssl rand -hex 32
```

### 3) รัน API
```bash
cd api
npm install
npm start
```

เปิด: http://localhost:3000/index.html

### บัญชีผู้ใช้

ไฟล์ schema รุ่นเดิมมีบัญชีตัวอย่างสำหรับการพัฒนาเท่านั้น ห้ามใช้บัญชีตัวอย่างหรือรหัสผ่านเริ่มต้นใน production ให้ผู้ดูแลกำหนดรหัสผ่านใหม่ที่ไม่ซ้ำและยาวอย่างน้อย 12 ตัวอักษรก่อนเปิดใช้งานจริง

----------|----------|
| talos blackagency | 001 |
| noelle blackagency | 002 |
| jane doe | 003 |

---

## หลัง deploy production

1. เปลี่ยน `JWT_SECRET` ทันที
2. รีเซ็ตรหัสผ่าน Neon ที่เคยแชร์
3. ตั้ง `ALLOWED_ORIGINS` เป็นโดเมนจริงเท่านั้น
4. ใช้ HTTPS
5. อย่า commit ไฟล์ `.env` (มีใน `.gitignore` แล้ว)

---

## โครงสร้าง
```
kimi/
├── schema.sql
├── .gitignore
├── index.html / dashboard.html
├── js/
│   ├── anti-devtools.js
│   ├── api-client.js      ← JWT
│   ├── app.js
│   └── neon-bridge.js
└── api/
    ├── server.js          ← Secure API
    ├── package.json
    ├── .env               ← ลับ
    └── .env.example
```
