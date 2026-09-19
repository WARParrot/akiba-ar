// #9: POST /auth/telegram rate limit — 429 with Retry-After after RATE_LIMIT_AUTH bad-signature
// attempts, proving a deployment without a fronting nginx still has an HMAC brute-force guard.
// Note: rejected (401) attempts consume budget too — that is the point for brute-force.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

process.env.JWT_SECRET ??= 'test-secret';
process.env.TELEGRAM_BOT_TOKEN = '123456:test-bot-token';
delete process.env.RESIDENTS_CHAT_ID;
process.env.LOCAL_SERVER = '1';
process.env.RATE_LIMIT_AUTH = '5'; // low limit for testing

const { createApp } = await import('../src/app.js');
const { migrate, pool } = await import('../src/db.js');

let base = '';
let server: ReturnType<ReturnType<typeof createApp>['listen']>;

before(async () => {
  await migrate();
  await pool.query('TRUNCATE captures, spawns, hint_views, hints, markers, zones, creature_species, users RESTART IDENTITY CASCADE');
  server = createApp(pool).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  await pool.end();
});

const badLogin = async () => {
  const res = await fetch(base + '/auth/telegram', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 9999, first_name: 'Bruter', auth_date: Math.floor(Date.now() / 1000), hash: 'deadbeef' }),
  });
  return { status: res.status, retryAfter: res.headers.get('retry-after') };
};

test('auth endpoint returns 401 up to the limit, then 429 with Retry-After', async () => {
  for (let i = 0; i < 5; i++) {
    const r = await badLogin();
    assert.equal(r.status, 401, `attempt ${i + 1} must still be a signature rejection`);
  }
  const limited = await badLogin();
  assert.equal(limited.status, 429, '6th pre-auth attempt must be rate limited');
  assert.equal(limited.retryAfter, '60');
});

test('a valid login is also blocked once the auth bucket is exhausted', async () => {
  // The bucket above is still live: even a correctly signed login cannot pass this window.
  const res = await fetch(base + '/auth/telegram', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 8888, first_name: 'Honest', auth_date: Math.floor(Date.now() / 1000), hash: 'deadbeef' }),
  });
  assert.equal(res.status, 429);
});
