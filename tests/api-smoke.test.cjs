'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');

process.env.JWT_SECRET = 'test-only-secret-for-local-smoke-tests-32-chars';
process.env.ALLOWED_ORIGINS = '';
delete process.env.DATABASE_URL;

const app = require('../api/index.js');
const { createLocalServer } = require('../server-local/server.js');

let apiServer;
let localServer;
let apiUrl;
let localUrl;

function listen(serverFactory) {
  return new Promise((resolve, reject) => {
    const server = serverFactory();
    server.once('error', reject);
    server.once('listening', () => {
      const address = server.address();
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

function close(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

before(async () => {
  const api = await listen(() => app.listen(0, '127.0.0.1'));
  apiServer = api.server;
  apiUrl = api.url;

  const local = await listen(() => createLocalServer({ port: 0, host: '127.0.0.1' }));
  localServer = local.server;
  localUrl = local.url;
});

after(async () => {
  await Promise.all([close(apiServer), close(localServer)]);
});

test('protected API rejects requests without a bearer token', async () => {
  const response = await fetch(`${apiUrl}/api/users`);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'ต้องเข้าสู่ระบบก่อน');
});

test('health reports unavailable database without leaking connection details', async () => {
  const response = await fetch(`${apiUrl}/api/health`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).ok, false);
});

test('login fails closed when the database is not configured', async () => {
  const response = await fetch(`${apiUrl}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'test-user', password: 'not-a-real-password' })
  });
  assert.equal(response.status, 503);
});

test('CORS does not grant access to an unconfigured origin', async () => {
  const response = await fetch(`${apiUrl}/api/health`, {
    headers: { Origin: 'https://untrusted.example' }
  });
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('browser API client uses same-origin URLs when served by the local server', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'api-client.js'), 'utf8');
  assert.match(source, /const API_BASE = window\.location\.protocol === 'file:' \? 'http:\/\/localhost:3000' : '';/);
});

test('local runtime serves the frontend from the shared API app', async () => {
  const response = await fetch(`${localUrl}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/html/);
  assert.match(await response.text(), /Medic|login|เข้าสู่ระบบ/i);
});

test('local runtime does not expose source, environment, or package metadata', async () => {
  for (const pathname of ['/api/index.js', '/server-local/env.example', '/package.json', '/schema.sql']) {
    const response = await fetch(`${localUrl}${pathname}`);
    assert.equal(response.status, 404, pathname);
  }
});
