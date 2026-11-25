# Medic Shift Log
ระบบบันทึกเวรและจัดการงานปฏิบัติการของทีมแพทย์ พัฒนาด้วย JavaScript, Express และ Neon PostgreSQL ครอบคลุมการเข้า/ออกเวร เงินกองกลาง สต็อกอุปกรณ์ ทะเบียนรถ และรายชื่อบุคลากร

> **สถานะ:** อยู่ระหว่างยกระดับความปลอดภัยและโครงสร้างระบบ การมี CI และ JWT ไม่ได้หมายความว่าผ่านการรับรองหรือพร้อม production โปรดทำรายการใน [Security Remediation](docs/SECURITY-REMEDIATION.md) ให้ครบก่อนเปิดใช้งานจริง

## Technology
Node.js 20+, Express 4, Neon serverless PostgreSQL, bcryptjs, JWT bearer authentication and vanilla JavaScript.

## Repository layout
```text
.
├── api/                 # Vercel API entry and legacy route files
├── server-local/        # Local Express runtime
├── js/                  # Browser API client, bridge and UI behavior
├── css/                 # Application styles
├── assets/              # Images and video
├── schema.sql           # PostgreSQL schema
├── tests/               # API smoke tests
├── scripts/             # Source validation
└── docs/                # Architecture and security
```

## Local setup
1. Install Node.js 20+.
2. Create a Neon database and review/apply `schema.sql` after taking an appropriate backup.
3. Copy `server-local/env.example` to `server-local/.env`.
4. Set `DATABASE_URL`, a random `JWT_SECRET` (32+ characters), exact `ALLOWED_ORIGINS`, and `PORT`.
5. Run:
```bash
cd server-local
npm ci
npm start
```
Open `http://localhost:3000/index.html`. Never commit `.env` or files named `env`.

## Vercel
Configure `DATABASE_URL`, `JWT_SECRET`, and exact `ALLOWED_ORIGINS` in Vercel for each environment. Never use `*`. Complete credential rotation before deploying.

## Quality checks
```bash
npm ci
npm run verify
```
Current tests cover syntax and database-independent API smoke behavior only. They do not replace PostgreSQL integration, authorization, concurrency, accessibility, or penetration testing.

## Roadmap
1. Consolidate duplicate API runtimes and retire legacy handlers.
2. Add validation, consistent errors, database transactions and audit-safe logs.
3. Add PostgreSQL and authorization regression tests.
4. Modularize the frontend.
5. Add shared rate limiting, observability, backup/restore drills and production deployment gates.

Read [SECURITY.md](SECURITY.md) and complete [Security Remediation](docs/SECURITY-REMEDIATION.md) before production use.
