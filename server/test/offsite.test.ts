// Remote mode: LOCAL_SERVER unset means this process is the cloud backend, not the in-space one.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

process.env.JWT_SECRET ??= 'test-secret';
delete process.env.LOCAL_SERVER;

const { createApp } = await import('../src/app.js');
const { migrate, pool } = await import('../src/db.js');
const { sign } = await import('../src/auth.js');

let base = '';
let server: ReturnType<ReturnType<typeof createApp>['listen']>;
let token = '';

before(async () => {
  await migrate();
  await pool.query('TRUNCATE captures, spawns, hint_views, hints, markers, zones, creature_species, users RESTART IDENTITY CASCADE');
  const uid = (await pool.query(
    `INSERT INTO users (telegram_id, nickname, role) VALUES (2001,'remote_resident','resident') RETURNING id`,
  )).rows[0].id as number;
  token = sign({ uid, role: 'resident' });
  const zone = (await pool.query(`INSERT INTO zones (name) VALUES ('Kitchen') RETURNING id`)).rows[0].id as number;
  await pool.query(`INSERT INTO markers (id, zone_id) VALUES ('marker-kitchen', $1)`, [zone]);
  await pool.query(`INSERT INTO creature_species (id,name,rarity,onsite_only) VALUES ('bytedragon','Byte-sized Dragon',3,true)`);
  await pool.query(
    `INSERT INTO spawns (marker_id, species_id, expires_at) VALUES ('marker-kitchen','bytedragon', now() + interval '1 hour')`,
  );
  server = createApp(pool).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  await pool.end();
});

const api = async (path: string, method = 'GET', body?: unknown) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, any>) : null };
};

test('health reports offsite', async () => {
  assert.equal((await api('/health')).body!.onsite, false);
});

test('resident cannot place a hint while offsite', async () => {
  const res = await api('/markers/marker-kitchen/hints', 'POST', {
    text: 'from my couch',
    type: 'practical',
    visibility: 'public',
  });
  assert.equal(res.status, 403);
  assert.equal(res.body!.error, 'onsite_only');
});

test('creature spawns and catching are blocked offsite', async () => {
  assert.equal((await api('/markers/marker-kitchen/spawns')).status, 403);
  const spawnId = (await pool.query('SELECT id FROM spawns LIMIT 1')).rows[0].id;
  assert.equal((await api(`/spawns/${spawnId}/catch`, 'POST')).status, 403);
});

test('remote mode still allows collection, feed and leaderboard', async () => {
  for (const path of ['/collection', '/feed', '/leaderboard', '/me']) {
    assert.equal((await api(path)).status, 200, path);
  }
});
