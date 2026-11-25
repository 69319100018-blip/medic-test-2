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
5. From the repository root, install and start:
```bash
npm ci
npm start
```
The server loads `server-local/.env` relative to its own directory. Open `http://localhost:3000/index.html`; use `npm run dev` for local hot reload.

Never commit `.env` or files named `env`.

## Vercel
Configure `DATABASE_URL`, `JWT_SECRET`, and exact `ALLOWED_ORIGINS` in Vercel for each environment. Never use `*`. Complete credential rotation before deploying.

### Discord notifications
Set these server-side environment variables in Vercel (Production) as encrypted secrets:

- `DISCORD_WEBHOOK_URL` — shift check-in/check-out channel
- `DISCORD_WEBHOOK_FUND` — central fund deposits, withdrawals, and admin adjustments
- `DISCORD_WEBHOOK_STOCK` — stock add/withdraw channel (the existing `DISCORD_WEBHOOK_FUND_STOCK` key remains supported as a legacy fallback)
- `DISCORD_WEBHOOK_VEHICLE` — vehicle registration channel

Each webhook URL already identifies its destination channel; a Discord server ID is not required for webhook delivery. Do not use a `NEXT_PUBLIC_` prefix. Local development can set the same keys in `server-local/.env`. Notifications are sent only after the database transaction succeeds, and Discord failures do not roll back the application action.

## Existing database migrations

The schema file is the baseline for a new database. For an existing Neon database, review and apply files under `migrations/` individually after taking a backup. In particular, `001-open-shift-uniqueness.sql` requires resolving duplicate open-shift rows before the unique index can be created.

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
