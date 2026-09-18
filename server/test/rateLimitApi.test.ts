// Rate limiter API integration: 429 after the limit on a spend endpoint; Retry-After present.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

process.env.JWT_SECRET ??= 'test-secret';
process.env.TELEGRAM_BOT_TOKEN = '123456:test-bot-token';
delete process.env.RESIDENTS_CHAT_ID;
process.env.LOCAL_SERVER = '1';
process.env.RATE_LIMIT_SPEND = '3'; // low limit for testing

const { createApp } = await import('../src/app.js');
const { migrate, pool } = await import('../src/db.js');
const { sign } = await import('../src/auth.js');

let base = '';
let server: ReturnType<ReturnType<typeof createApp>['listen']>;
let residentToken = '';
let adminToken = '';
let hintId = 0;

before(async () => {
  await migrate();
  await pool.query('TRUNCATE captures, spawns, hint_views, hints, markers, zones, creature_species, users RESTART IDENTITY CASCADE');
  const adminId = (await pool.query(`INSERT INTO users (telegram_id, nickname, role) VALUES (8001,'admin_rl','admin') RETURNING id`)).rows[0].id;
  const residentId = (await pool.query(`INSERT INTO users (telegram_id, nickname, role) VALUES (8002,'res_rl','resident') RETURNING id`)).rows[0].id;
  adminToken = sign({ uid: adminId, role: 'admin' });
  residentToken = sign({ uid: residentId, role: 'resident' });
  await pool.query(`INSERT INTO zones (name) VALUES ('Z')`);
  await pool.query(`INSERT INTO markers (id, zone_id) VALUES ('m1', 1)`);
  await pool.query(`INSERT INTO creature_species (id,name,rarity,onsite_only) VALUES ('sp1','Species1',1,true)`);

  server = createApp(pool).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  await pool.end();
});

const api = async (path: string, opts: { method?: string; as?: string; body?: unknown } = {}) => {
  const res = await fetch(base + path, {
    method: opts.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(opts.as ? { authorization: `Bearer ${opts.as === 'admin' ? adminToken : residentToken}` } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, retryAfter: res.headers.get('retry-after') };
};

test('setup: resident creates a hint (1 of 3 spend budget used)', async () => {
  const r = await api('/markers/m1/hints', { method: 'POST', as: 'resident', body: { text: 'x', type: 'joke', visibility: 'public' } });
  assert.equal(r.status, 201);
  const view = await fetch(base + '/markers/m1/hints', { headers: { authorization: `Bearer ${residentToken}` } });
  hintId = JSON.parse(await view.text()).hints[0].id;
});

test('spend endpoint returns 429 with Retry-After after the limit', async () => {
  // 2 more spend requests hit the limit of 3...
  assert.equal((await api(`/hints/${hintId}/vote`, { method: 'POST', as: 'resident', body: { delta: 1 } })).status, 200);
  assert.equal((await api(`/hints/${hintId}/vote`, { method: 'POST', as: 'resident', body: { delta: 1 } })).status, 200);
  // 4th spend -> 429
  const limited = await api(`/hints/${hintId}/vote`, { method: 'POST', as: 'resident', body: { delta: 1 } });
  assert.equal(limited.status, 429);
  assert.equal(limited.retryAfter, '60');
});

test('another user has an independent bucket', async () => {
  const r = await api(`/hints/${hintId}/vote`, { method: 'POST', as: 'admin', body: { delta: 1 } });
  assert.equal(r.status, 200, 'admin bucket is independent of the limited resident');
});

test('read endpoints are not limited by the spend bucket', async () => {
  const r = await api('/markers/m1/hints', { as: 'resident' });
  assert.equal(r.status, 200, 'view uses the view bucket, not the spend bucket');
});
