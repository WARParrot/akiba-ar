// Report auto-moderation: hints auto-hidden (visibility -> private) at report threshold,
// admin reapprove restores visibility and resets counter.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

process.env.JWT_SECRET ??= 'test-secret';
process.env.TELEGRAM_BOT_TOKEN = '123456:test-bot-token';
delete process.env.RESIDENTS_CHAT_ID;
process.env.LOCAL_SERVER = '1';
process.env.REPORT_THRESHOLD = '2'; // low threshold for testing

const { createApp } = await import('../src/app.js');
const { migrate, pool } = await import('../src/db.js');
const { sign } = await import('../src/auth.js');

let base = '';
let server: ReturnType<ReturnType<typeof createApp>['listen']>;
let adminToken = '';
let residentToken = '';
let hintId = 0;

before(async () => {
  await migrate();
  await pool.query('TRUNCATE captures, spawns, hint_views, hints, markers, zones, creature_species, users RESTART IDENTITY CASCADE');
  const adminId = (await pool.query(`INSERT INTO users (telegram_id, nickname, role) VALUES (7001,'admin_r','admin') RETURNING id`)).rows[0].id;
  const residentId = (await pool.query(`INSERT INTO users (telegram_id, nickname, role) VALUES (7002,'res_r','resident') RETURNING id`)).rows[0].id;
  adminToken = sign({ uid: adminId, role: 'admin' });
  residentToken = sign({ uid: residentId, role: 'resident' });
  await pool.query(`INSERT INTO zones (name) VALUES ('Z')`);
  await pool.query(`INSERT INTO markers (id, zone_id) VALUES ('m1', 1)`);

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
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

test('setup: resident creates a public hint', async () => {
  const r = await api('/markers/m1/hints', { method: 'POST', as: 'resident', body: { text: 'reportable', type: 'joke', visibility: 'public' } });
  assert.equal(r.status, 201);
  hintId = r.body!.hint.id;
});

test('reports below threshold do not hide the hint', async () => {
  await api(`/hints/${hintId}/report`, { method: 'POST', as: 'resident' });
  const view = await api('/markers/m1/hints', { as: 'resident' });
  assert.equal(view.body!.hints.length, 1);
});

test('hint auto-hides at threshold (visibility -> private)', async () => {
  await api(`/hints/${hintId}/report`, { method: 'POST', as: 'resident' }); // 2nd report reaches threshold 2
  // The author always sees their own hint (author_id = uid); auto-hide is verified via
  // the DB state and a non-author view.
  const db = await pool.query('SELECT visibility, reports FROM hints WHERE id = $1', [hintId]);
  assert.equal(db.rows[0].visibility, 'private');
  assert.equal(db.rows[0].reports, 0, 'counter resets on auto-hide');
  const guestId = (await pool.query(`INSERT INTO users (telegram_id, nickname, role) VALUES (7003,'guest_r','guest') RETURNING id`)).rows[0].id;
  const guestToken = sign({ uid: guestId, role: 'guest' });
  const res = await fetch(base + `/markers/m1/hints`, { headers: { 'content-type': 'application/json', authorization: `Bearer ${guestToken}` } });
  const body = JSON.parse(await res.text());
  assert.equal(body.hints.length, 0, 'auto-hidden hint must not appear for non-authors');
});

test('admin reapprove restores visibility and clears reports', async () => {
  const r = await api(`/hints/${hintId}/reapprove`, { method: 'POST', as: 'admin' });
  assert.equal(r.status, 200);
  const db = await pool.query('SELECT visibility, reports FROM hints WHERE id = $1', [hintId]);
  assert.equal(db.rows[0].visibility, 'public');
  assert.equal(db.rows[0].reports, 0);
  const view = await api('/markers/m1/hints', { as: 'resident' });
  assert.equal(view.body!.hints.length, 1);
});

test('non-admin cannot reapprove', async () => {
  const r = await api(`/hints/${hintId}/reapprove`, { method: 'POST', as: 'resident' });
  assert.equal(r.status, 403);
});
