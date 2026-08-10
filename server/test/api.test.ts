// End-to-end against a real Postgres. Run: DATABASE_URL=... npx tsx --test test/api.test.ts
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

process.env.JWT_SECRET ??= 'test-secret';
process.env.TELEGRAM_BOT_TOKEN = '123456:test-bot-token';
delete process.env.RESIDENTS_CHAT_ID; // no chat configured -> isChannelMember() short-circuits, no network
process.env.LOCAL_SERVER = '1'; // pretend this process is the in-space local server

const { createApp } = await import('../src/app.js');
const { migrate, pool } = await import('../src/db.js');
const { sign } = await import('../src/auth.js');

let base = '';
let server: ReturnType<ReturnType<typeof createApp>['listen']>;
let zoneId = 0;
let residentId = 0;
let guestId = 0;
let adminId = 0;
const tokens: Record<string, string> = {};

async function api(path: string, opts: { method?: string; as?: string; body?: unknown } = {}) {
  const res = await fetch(base + path, {
    method: opts.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(opts.as ? { authorization: `Bearer ${tokens[opts.as]}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, any>) : null };
}

before(async () => {
  await migrate();
  await pool.query('TRUNCATE captures, spawns, hint_views, hints, markers, zones, creature_species, users RESTART IDENTITY CASCADE');

  const mk = async (tgId: number, nick: string, role: string) =>
    (await pool.query('INSERT INTO users (telegram_id, nickname, role) VALUES ($1,$2,$3) RETURNING id', [tgId, nick, role]))
      .rows[0].id as number;
  residentId = await mk(1001, 'resident_ivan', 'resident');
  guestId = await mk(1002, 'guest_bob', 'guest');
  adminId = await mk(1003, 'admin_root', 'admin');
  tokens.resident = sign({ uid: residentId, role: 'resident' });
  tokens.guest = sign({ uid: guestId, role: 'guest' });
  tokens.admin = sign({ uid: adminId, role: 'admin' });

  await pool.query(`INSERT INTO creature_species (id,name,rarity,onsite_only) VALUES
    ('transistorat','Transistorat',2,true), ('quantumduck','Quantum Duck',5,true)`);

  server = createApp(pool).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  await pool.end();
});

test('health reports onsite', async () => {
  const { status, body } = await api('/health');
  assert.equal(status, 200);
  assert.equal(body!.onsite, true);
});

test('no token -> 401', async () => {
  assert.equal((await api('/me')).status, 401);
});

test('scenario 1: telegram login creates a guest (not in residents channel)', async () => {
  const fields = { id: 5555, first_name: 'Newcomer', auth_date: Math.floor(Date.now() / 1000) };
  const checkString = Object.keys(fields).sort().map((k) => `${k}=${(fields as any)[k]}`).join('\n');
  const secret = createHash('sha256').update(process.env.TELEGRAM_BOT_TOKEN!).digest();
  const hash = createHmac('sha256', secret).update(checkString).digest('hex');

  const { status, body } = await api('/auth/telegram', { method: 'POST', body: { ...fields, hash } });
  assert.equal(status, 200);
  assert.equal(body!.user.role, 'guest');
  assert.ok(body!.token);

  const bad = await api('/auth/telegram', { method: 'POST', body: { ...fields, hash: 'deadbeef' } });
  assert.equal(bad.status, 401);
});

test('admin creates zone + marker; non-admin cannot', async () => {
  const zone = await api('/admin/zones', { method: 'POST', as: 'admin', body: { name: 'Soldering Lab' } });
  assert.equal(zone.status, 201);
  zoneId = zone.body!.zone.id;
  const marker = await api('/admin/markers', { method: 'POST', as: 'admin', body: { id: 'marker-3dprint', zone_id: zoneId } });
  assert.equal(marker.status, 201);

  const denied = await api('/admin/zones', { method: 'POST', as: 'resident', body: { name: 'Rogue Zone' } });
  assert.equal(denied.status, 403);
});

test('scenario 2: resident posts a styled HTML hint, server sanitises it', async () => {
  const res = await api('/markers/marker-3dprint/hints', {
    method: 'POST',
    as: 'resident',
    body: {
      text: 'Bed level screw is the front-left one',
      html: '<div style="border:2px solid #0ff;animation:pulse 2s infinite">NEON<script>steal()</script></div>',
      type: 'practical',
      visibility: 'public',
      theme: 'cyberpunk',
    },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body!.sanitized, true);
  assert.ok(!/script/i.test(res.body!.hint.html), res.body!.hint.html);
  assert.match(res.body!.hint.html, /animation:pulse 2s infinite/);
});

test('guests cannot create hints', async () => {
  const res = await api('/markers/marker-3dprint/hints', {
    method: 'POST',
    as: 'guest',
    body: { text: 'nope', type: 'joke', visibility: 'public' },
  });
  assert.equal(res.status, 403);
});

test('unknown marker -> 404, bad type -> 400', async () => {
  assert.equal(
    (await api('/markers/nope/hints', { method: 'POST', as: 'resident', body: { text: 'x', type: 'lore', visibility: 'public' } })).status,
    404,
  );
  assert.equal(
    (await api('/markers/marker-3dprint/hints', { method: 'POST', as: 'resident', body: { text: 'x', type: 'gossip', visibility: 'public' } })).status,
    400,
  );
});

test('scenario 3: visibility is enforced server-side and guests earn insight points', async () => {
  for (const [type, visibility] of [['lore', 'residents'], ['joke', 'private']] as const) {
    const r = await api('/markers/marker-3dprint/hints', {
      method: 'POST', as: 'resident',
      body: { text: `${visibility} hint`, type, visibility },
    });
    assert.equal(r.status, 201);
  }

  const guestView = await api('/markers/marker-3dprint/hints', { as: 'guest' });
  assert.deepEqual(guestView.body!.hints.map((h: any) => h.visibility), ['public']);

  const residentView = await api('/markers/marker-3dprint/hints', { as: 'resident' });
  assert.equal(residentView.body!.hints.length, 3); // public + residents + own private

  const points = (await api('/me', { as: 'guest' })).body!.user.insight_points;
  assert.equal(points, 1);
  await api('/markers/marker-3dprint/hints', { as: 'guest' }); // re-view must not double-count
  assert.equal((await api('/me', { as: 'guest' })).body!.user.insight_points, 1);

  const feed = await api('/feed', { as: 'guest' });
  assert.equal(feed.body!.hints.length, 0); // lore is residents-only, joke is private
});

test('hint edit/delete restricted to author or admin', async () => {
  const { body } = await api('/markers/marker-3dprint/hints', { as: 'resident' });
  const hintId = body!.hints[0].id;
  assert.equal((await api(`/hints/${hintId}`, { method: 'PATCH', as: 'guest', body: { text: 'hijacked' } })).status, 404);
  const ok = await api(`/hints/${hintId}`, { method: 'PATCH', as: 'resident', body: { text: 'updated by author' } });
  assert.equal(ok.body!.hint.text, 'updated by author');
  assert.equal((await api(`/hints/${hintId}`, { method: 'PATCH', as: 'admin', body: { html: '<b onclick="x()">bold</b>' } })).status, 200);
  const after = await api('/markers/marker-3dprint/hints', { as: 'resident' });
  assert.ok(!/onclick/i.test(JSON.stringify(after.body!.hints)));
});

test('vote and report change moderation state', async () => {
  const { body } = await api('/markers/marker-3dprint/hints', { as: 'resident' });
  const id = body!.hints[0].id;
  assert.equal((await api(`/hints/${id}/vote`, { method: 'POST', as: 'guest', body: { delta: 1 } })).body!.score, 1);
  assert.equal((await api(`/hints/${id}/vote`, { method: 'POST', as: 'guest', body: { delta: -1 } })).body!.score, 0);
  await api(`/hints/${id}/report`, { method: 'POST', as: 'guest' });
  const reported = await api('/admin/reported', { as: 'admin' });
  assert.equal(reported.body!.hints[0].reports, 1);
});

test('scenario 4: spawn is catchable exactly once', async () => {
  const spawn = await api('/admin/spawns', {
    method: 'POST', as: 'admin',
    body: { marker_id: 'marker-3dprint', species_id: 'transistorat', ttl_minutes: 10 },
  });
  assert.equal(spawn.status, 201);
  const spawnId = spawn.body!.spawn.id;

  const visible = await api('/markers/marker-3dprint/spawns', { as: 'guest' });
  assert.equal(visible.body!.spawns.length, 1);

  const [a, b] = await Promise.all([
    api(`/spawns/${spawnId}/catch`, { method: 'POST', as: 'guest' }),
    api(`/spawns/${spawnId}/catch`, { method: 'POST', as: 'resident' }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);

  const winner = a.status === 201 ? 'guest' : 'resident';
  const collection = await api('/collection', { as: winner });
  assert.equal(collection.body!.collection[0].species_id, 'transistorat');
  assert.equal((await api('/collection', { as: winner === 'guest' ? 'resident' : 'guest' })).body!.collection.length, 0);

  const board = await api('/leaderboard', { as: 'guest' });
  assert.equal(board.body!.leaderboard[0].catches, 1);
});

test('expired spawn cannot be caught', async () => {
  const { rows } = await pool.query(
    `INSERT INTO spawns (marker_id, species_id, expires_at) VALUES ('marker-3dprint','quantumduck', now() - interval '1 minute') RETURNING id`,
  );
  assert.equal((await api(`/markers/marker-3dprint/spawns`, { as: 'guest' })).body!.spawns.length, 0);
  assert.equal((await api(`/spawns/${rows[0].id}/catch`, { method: 'POST', as: 'resident' })).status, 409);
});
