# วิธีติดตั้งและเชื่อมต่อ Medic Shift Log

คู่มือนี้อ้างอิงโครงสร้างและ API entry point ใน branch ที่กำลังปรับปรุง ไม่ใช่ขั้นตอน deploy แบบลากวางของเวอร์ชันเก่า

## 1. เตรียมฐานข้อมูล Neon

1. สร้างหรือเลือก PostgreSQL project ใน Neon
2. สำรองข้อมูลเดิมก่อนเปลี่ยน schema
3. เปิด SQL Editor และตรวจทานไฟล์ `schema.sql` ก่อน apply
4. Schema ปัจจุบันประกอบด้วยตาราง `users`, `shift_logs`, `central_fund`, `fund_history`, `stock_items`, `stock_withdrawals`, `vehicles`, `doctors`, `device_sessions`, `security_bans` และ `security_events`

อย่าใช้รายการตารางจากเอกสารเก่าที่อ้าง `shift_events` หรือ `fund_state` เพราะไม่ตรงกับ schema ปัจจุบัน

## 2. ตั้งค่า local environment

1. คัดลอก `server-local/env.example` เป็น `server-local/.env`
2. กำหนดค่า `DATABASE_URL` จาก Neon
3. สร้าง `JWT_SECRET` ใหม่ด้วยคำสั่ง `openssl rand -hex 32` และเก็บไว้เป็นความลับ
4. ตั้ง `ALLOWED_ORIGINS=http://localhost:3000` สำหรับ local development
5. อย่า commit `.env`, connection string หรือ JWT secret

จาก root ของ repository รัน:

```bash
npm ci
npm start
```

จากนั้นเปิด `http://localhost:3000/index.html` สำหรับ hot reload ใช้ `npm run dev`

## 3. ตั้งค่า Vercel

1. Import repository นี้เข้า Vercel โดยเลือก branch ที่ต้องการ deploy
2. ตั้ง Environment Variables สำหรับแต่ละ environment:
   - `DATABASE_URL`: Neon connection string
   - `JWT_SECRET`: ค่าสุ่มยาวอย่างน้อย 32 ตัวอักษร
   - `ALLOWED_ORIGINS`: origin ของ frontend ที่อนุญาตแบบ exact match คั่นด้วย comma
   - `DISCORD_WEBHOOK_URL` และ webhook เฉพาะโมดูล เฉพาะเมื่อเปิดใช้งานจริง
3. ห้ามใช้ wildcard origin (`*`) และห้ามใส่ secrets ใน frontend
4. ตรวจผล CI และ Preview Deployment ก่อน Promote ไป Production

Vercel API entry point ปัจจุบันคือ `api/index.js`; ไฟล์ route แยกใน `api/` เป็น legacy code ที่ต้องผ่านการตรวจและรวมให้เหลือ implementation เดียวในงาน refactor ระยะถัดไป

## 4. การเข้าสู่ระบบและบัญชีผู้ใช้

- หน้า login ใช้ API และ JWT ไม่ได้ตรวจรหัสผ่านจาก JavaScript ฝั่ง browser
- สมัครสมาชิกผ่านหน้า Register โดยรหัสผ่านใหม่ต้องยาวอย่างน้อย 12 ตัวอักษร
- สิทธิ์ role และ admin ต้องถูกกำหนดจากข้อมูลฝั่งฐานข้อมูล
- ห้ามเผยแพร่บัญชีตัวอย่างหรือรหัสผ่านเริ่มต้นในเอกสารสาธารณะ
- ก่อนใช้งานจริง ให้เปลี่ยนหรือลบบัญชี seed ที่มีอยู่ และตรวจสิทธิ์ admin ทุกบัญชี

## 5. ข้อควรทราบก่อนใช้งานจริง

ข้อมูลเดิมที่เก็บอยู่ใน `localStorage` ของแต่ละเครื่องจะไม่ถูกย้ายเข้า Neon โดยอัตโนมัติ ต้องวางแผนตรวจสอบและ migrate ข้อมูลเป็นรายระบบก่อน หากข้อมูลเดิมมีความสำคัญ

ไฟล์ environment ที่เคยอยู่ใน public repository ถูกนำออกจาก branch ใหม่แล้ว แต่การลบไฟล์ใน commit ใหม่ไม่ได้ลบ credential ออกจาก Git history โปรดทำตาม [Security Remediation](docs/SECURITY-REMEDIATION.md) และหมุนเวียน secret ก่อน merge หรือ deploy

ดูภาพรวมสถาปัตยกรรมที่ [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) และแนวทางความปลอดภัยที่ [SECURITY.md](SECURITY.md)
