// Notification triggers: sendBotMessage fired on rare-species spawns (rarity >= threshold).
// Unit test with a stubbed fetch — no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET ??= 'test-secret';
process.env.TELEGRAM_BOT_TOKEN = '123456:test-bot-token';
delete process.env.RESIDENTS_CHAT_ID;
process.env.LOCAL_SERVER = '1';
process.env.RESIDENTS_CHAT_ID = '-100200'; // numeric chat id so the rare-spawn push fires

const sent: { chatId: number; text: string }[] = [];
// Stub global fetch BEFORE importing app/telegram so sendBotMessage calls our recorder.
const realFetch = globalThis.fetch;
(globalThis as any).fetch = async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  if (u.includes('/sendMessage')) {
    const body = JSON.parse(String(init?.body ?? '{}'));
    sent.push({ chatId: body.chat_id, text: body.text });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  return realFetch(url as any, init as any);
};

const { createApp } = await import('../src/app.js');
const { migrate, pool } = await import('../src/db.js');
const { sign } = await import('../src/auth.js');

let adminToken = '';

test('setup: migrate and seed', async () => {
  await migrate();
  await pool.query('TRUNCATE captures, spawns, hint_views, hints, markers, zones, creature_species, users RESTART IDENTITY CASCADE');
  await pool.query(`INSERT INTO creature_species (id,name,rarity,onsite_only) VALUES ('rarebird','Rare Bird',4,true), ('commonrat','Common Rat',1,true)`);
  await pool.query(`INSERT INTO zones (name) VALUES ('Zone1')`);
  await pool.query(`INSERT INTO markers (id, zone_id) VALUES ('m1', 1)`);
  await pool.query(`INSERT INTO users (telegram_id, nickname, role) VALUES (9001, 'admin_t', 'admin')`);
  const uid = (await pool.query(`SELECT id FROM users WHERE telegram_id = 9001`)).rows[0].id;
  adminToken = sign({ uid, role: 'admin' });
});

test('rare spawn (rarity >= 4) triggers sendBotMessage', async () => {
  sent.length = 0;
  const app = createApp(pool);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;

  const rare = await fetch(`${base}/admin/spawns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ marker_id: 'm1', species_id: 'rarebird', ttl_minutes: 10 }),
  });
  assert.equal(rare.status, 201);
  assert.equal(sent.length, 1, `expected 1 message, sent=${JSON.stringify(sent)}`);
  assert.ok(sent[0]!.text.includes('Rare Bird'));

  // Common species (rarity 1 < 4): no message.
  sent.length = 0;
  const common = await fetch(`${base}/admin/spawns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ marker_id: 'm1', species_id: 'commonrat', ttl_minutes: 10 }),
  });
  assert.equal(common.status, 201);
  assert.equal(sent.length, 0, `expected no message for common spawn, sent=${JSON.stringify(sent)}`);

  server.close();
});

test('cleanup: pool end', async () => {
  await pool.end();
});
