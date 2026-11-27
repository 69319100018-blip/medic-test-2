# Medic Shift Log — FiveM Bridge Foundation

> สถานะ: เตรียมโครงสร้างเท่านั้น ยังไม่เปิดใช้งาน และยังไม่เชื่อมกับ Production

## ขอบเขตและการแยกจากเว็บปัจจุบัน

งานชุดนี้อยู่บน Git branch `enterprise/fivem-bridge-foundation` แยกจาก `main` ทั้งหมด โดยตั้งใจ **ไม่แก้** ไฟล์ต่อไปนี้ใน branch นี้:

- `api/index.js` — API entry ที่ Production ใช้อยู่
- `dashboard.html`, `js/app.js`, `css/*` — หน้าเว็บปัจจุบัน
- `vercel.json` — rewrite, header และ cron ของ Production
- `package.json` — dependencies และ scripts ของเว็บ
- Neon Production — ยังไม่ได้รัน migration ใด ๆ

ไฟล์ `api/fivem-bridge.js` เป็น route module แยกที่ยังไม่ได้ import/register ใน API entry ดังนั้น Endpoint `/api/fivem/*` ยังไม่เปิดให้เรียกใช้งานจาก Production ส่วน Resource ใน `fivem/medic_bridge` ปิดโดยค่าเริ่มต้น (`medic_bridge_enabled=0`) และ Adapter ยัง fail-closed

## ส่วนประกอบ

| Path | หน้าที่ |
|---|---|
| `api/fivem-bridge.js` | API module สำหรับ heartbeat, events, command polling/acknowledgement, player links และ admin overview/commands |
| `migrations/20261127-fivem-bridge-foundation.sql` | ตารางแยกสำหรับเซิร์ฟเวอร์, identifier links, events, state mirror, commands และ anti-replay nonce |
| `fivem/medic_bridge` | FiveM Resource skeleton พร้อม server-only convars, event queue, heartbeat, command polling และ client helper ให้ออกจากรถ |
| `tests/fivem-bridge-foundation.test.cjs` | ตรวจเงื่อนไข isolation, security helpers และการปิดใช้งานโดยค่าเริ่มต้น |

## Security model

1. ใช้ HTTPS และ Bearer token แบบสุ่มยาว 256-bit ขึ้นไป ระหว่าง Resource กับ API
2. เก็บเฉพาะ SHA-256 token hash ในฐานข้อมูล ส่วน token จริงอยู่ใน server-only convar ของ FiveM เท่านั้น
3. ทุก server request ต้องมี timestamp และ nonce; API ตรวจเวลาคลาดเคลื่อนและปฏิเสธ nonce ที่ใช้ซ้ำ
4. ไม่รับ username หรือ role จาก Client เป็นแหล่งยืนยันตัวตน ใช้ identifier ที่ Resource อ่านจากฝั่ง Server และ mapping ที่แอดมินอนุมัติ
5. คำสั่งจากเว็บไซต์ใช้ JWT และตรวจ `req.user.isAdmin` ฝั่ง API อีกครั้ง
6. คำสั่งมี UUID, idempotency key, expiry, claim แบบ `FOR UPDATE SKIP LOCKED` และผลตอบกลับที่ผูกกับ server เดิม
7. คำสั่ง `force_off_duty` จะถือว่าสำเร็จต่อเมื่อ Adapter ยืนยันทั้ง `dutyCleared=true` และ `vehicleSecured=true`
8. Adapter ตัวอย่างยังไม่ implement framework-specific logic และคืนค่าไม่สำเร็จเสมอ จึงไม่มีคำสั่งใดเปลี่ยนยศ/สถานะหรือแตะรถจริงในสภาพปัจจุบัน

## Framework adapter ยังต้องเติม

ก่อนเชื่อมกับเซิร์ฟเวอร์จริง ต้องได้รับข้อมูลและอนุมัติจากเจ้าของเซิร์ฟเวอร์:

- Framework และเวอร์ชัน: ESX, QBCore, Qbox หรือ Custom
- ชื่อ job/grade ของแพทย์ และ server-side event/export ที่ใช้เข้าเวร/ออกเวร
- Resource ที่จัดการรถหน่วยงาน, garage, keys/ล็อก, spawn/despawn และ fleet ownership
- Identifier ที่เลือกใช้ เช่น `license` หรือ `citizenid` และวิธีตรวจบัญชี Medic ที่เป็นเจ้าของ Identifier
- Dedicated test server, test account และ test vehicle สำหรับทดสอบก่อนเปิดจริง

ไม่ควรเดาชื่อ Event หรือชื่อ Resource ของเซิร์ฟเวอร์ เพราะแต่ละเซิร์ฟเวอร์ปรับแต่งไม่เหมือนกัน

## API contract ที่เตรียมไว้

### FiveM server authentication

Headers ทุกคำขอจาก Resource:

- `Authorization: Bearer <server-token>`
- `X-Medic-Server-ID: <server-id>`
- `X-Medic-Timestamp: <unix-seconds>`
- `X-Medic-Nonce: <unique-random-value>`

API routes (ยังไม่ mount):

- `POST /api/fivem/heartbeat`
- `POST /api/fivem/events`
- `POST /api/fivem/commands/poll`
- `POST /api/fivem/commands/:commandId/ack`
- `GET /api/fivem/admin/overview`
- `POST /api/fivem/admin/player-links`
- `POST /api/fivem/admin/commands`

Supported server events: `player_connected`, `player_disconnected`, `duty_started`, `duty_ended`, `vehicle_entered`, `vehicle_exited`.

Supported admin command in this foundation: `force_off_duty`. It is designed to clear EMS duty state and secure the current duty vehicle through the future framework adapter. It does **not** demote or delete the player's permanent job/grade.

## Provisioning outline (do not do yet on Production)

After framework review, migration approval and controlled testing:

1. Back up the Neon database and review the standalone migration.
2. Apply `migrations/20261127-fivem-bridge-foundation.sql` manually.
3. Generate a server-only token using `openssl rand -hex 32`.
4. Calculate its hash using `printf '%s' "$TOKEN" | sha256sum` and insert that SHA-256 value into `fivem_bridge_servers.token_hash`. Never store the plaintext token in Neon or Git.
5. Store the plaintext token in FiveM `server.cfg` using `set medic_bridge_token <secret>` (not `setr`); do not expose it to clients or logs.
6. Add a reviewed, explicit route registration in `api/index.js` and configure a server record with `enabled=false` first. This route registration is deliberately not done in this foundation branch.
7. Complete the framework adapter and test on a private/staging server. Only then enable bridge traffic.

Example server.cfg values (placeholders only):

```cfg
set medic_bridge_enabled 0
set medic_bridge_api_base "https://medic-test-2-tea-8d38.vercel.app"
set medic_bridge_server_id "medic-main"
set medic_bridge_token "REPLACE_WITH_RANDOM_64_HEX_SECRET"
set medic_bridge_framework "unknown"
set medic_bridge_identifier_type "license"
ensure medic_bridge
```

Keeping `medic_bridge_enabled 0` means the Resource makes no API calls and performs no game-side action. Do not switch it to 1 until the API route, migration, server record and framework adapter are ready.

## Activation and rollback

Activation must be a separate reviewed release: run the migration, provision the token, mount API routes, install Resource on a staging server, verify duty events and vehicle ownership, then deploy/enable.

Rollback: set `medic_bridge_enabled 0`, stop the Resource, revoke/rotate the server token, and leave the tables untouched until event/command records have been reviewed. The website's existing shift and Google Sheets features should remain independent of this optional bridge.
