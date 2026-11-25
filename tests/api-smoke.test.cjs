'use strict';
const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
process.env.JWT_SECRET = 'test-only-secret-for-local-smoke-tests-32-chars';
process.env.ALLOWED_ORIGINS = '';
delete process.env.DATABASE_URL;
const app = require('../api/index.js');
let server;
let baseUrl;
before(async () => {
  await new Promise((resolve,reject) => {
    server = app.listen(0,'127.0.0.1',(error) => {
      if (error) return reject(error);
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});
after(async () => {
  if (!server) return;
  await new Promise((resolve,reject) => server.close((error) => error ? reject(error) : resolve()));
});
test('protected user data rejects requests without bearer token',async () => {
  const response = await fetch(`${baseUrl}/api/users`);
  assert.equal(response.status,401);
  assert.equal((await response.json()).error,'ต้องเข้าสู่ระบบก่อน');
});
test('health returns unavailable without leaking database details',async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status,503);
  assert.equal((await response.json()).ok,false);
});
test('login fails closed when the database is not configured',async () => {
  const response = await fetch(`${baseUrl}/api/login`,{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({username:'test-user',password:'not-a-real-password'})
  });
  assert.equal(response.status,503);
});
