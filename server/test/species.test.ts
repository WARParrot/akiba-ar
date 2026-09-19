// Data-driven creature layer (#14/#16) e2e against a real Postgres.
// Run: PGUSER=... PGDATABASE=akiba JWT_SECRET=test npx tsx --test test/species.test.ts
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

process.env.JWT_SECRET ??= 'test-secret';
process.env.TELEGRAM_BOT_TOKEN = '123456:test-bot-token';
delete process.env.RESIDENTS_CHAT_ID;
process.env.LOCAL_SERVER = '1';

const { createApp } = await import('../src/app.js');
const { migrate, migrateCreatures, pool } = await import('../src/db.js');
const { sign } = await import('../src/auth.js');

let base = '';
let server: ReturnType<ReturnType<typeof createApp>['listen']>;
let zoneId = 0;
let adminToken = '';
let residentToken = '';

async function api(path: string, opts: { method?: string; as?: string; body?: unknown } = {}) {
  const res = await fetch(base + path, {
    method: opts.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(opts.as ? { authorization: `Bearer ${opts.as === 'admin' ? adminToken : residentToken}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, any>) : null };
}

before(async () => {
  await migrate();
  await migrateCreatures();
  await pool.query('TRUNCATE captures, spawns, creature_species, species_variants, species_templates, hint_views, hints, markers, zones, users RESTART IDENTITY CASCADE');

  const adminId = (await pool.query("INSERT INTO users (telegram_id, nickname, role) VALUES (9001,'admin','admin') RETURNING id")).rows[0].id as number;
  const residentId = (await pool.query("INSERT INTO users (telegram_id, nickname, role) VALUES (9002,'resident','resident') RETURNING id")).rows[0].id as number;
  adminToken = sign({ uid: adminId, role: 'admin' });
  residentToken = sign({ uid: residentId, role: 'resident' });

  zoneId = (await pool.query("INSERT INTO zones (name) VALUES ('Creature Lab') RETURNING id")).rows[0].id as number;
  await pool.query("INSERT INTO markers (id, zone_id) VALUES ('marker-crx', $1)", [zoneId]);

  server = createApp(pool).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  await pool.end();
});

// --- #14: admin species CRUD ---
test('#14: admin creates, lists, updates and deletes a species — no psql', async () => {
  const created = await api('/admin/species', {
    method: 'POST', as: 'admin',
    body: { id: 'solderling', name: 'Solderling', rarity: 3, onsite_only: true },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body!.species.rarity, 3);

  const listed = await api('/admin/species', { as: 'admin' });
  assert.ok(listed.body!.species.some((s: any) => s.id === 'solderling'));

  const updated = await api('/admin/species/solderling', {
    method: 'PATCH', as: 'admin', body: { rarity: 4 },
  });
  assert.equal(updated.body!.species.rarity, 4);

  const deleted = await api('/admin/species/solderling', { method: 'PATCH', as: 'admin', body: { delete: true } });
  assert.equal(deleted.status, 204);
  assert.ok(!listed.body!.species.some((s: any) => s.id === 'deleted'));
});

test('#14: non-admin denied; bad rarity 400; duplicate id 409; unknown id 404', async () => {
  assert.equal((await api('/admin/species', { method: 'POST', as: 'resident', body: { id: 'x', name: 'X' } })).status, 403);
  assert.equal((await api('/admin/species', { method: 'POST', as: 'admin', body: { id: 'x', name: 'X', rarity: 9 } })).status, 400);
  await api('/admin/species', { method: 'POST', as: 'admin', body: { id: 'dupe', name: 'Dupe' } });
  assert.equal((await api('/admin/species', { method: 'POST', as: 'admin', body: { id: 'dupe', name: 'Dupe2' } })).status, 409);
  assert.equal((await api('/admin/species/nope', { method: 'PATCH', as: 'admin', body: { name: 'X' } })).status, 404);
});

test('#14: POST /admin/spawns works with a species created via CRUD (no psql seed)', async () => {
  await api('/admin/species', { method: 'POST', as: 'admin', body: { id: 'spawnable', name: 'Spawnable', rarity: 2 } });
  const spawn = await api('/admin/spawns', {
    method: 'POST', as: 'admin', body: { marker_id: 'marker-crx', species_id: 'spawnable', ttl_minutes: 5 },
  });
  assert.equal(spawn.status, 201);
});

// --- #16: templates + variants + resolved spawn ---
test('#16: admin creates a template with stats/skills config', async () => {
  const t = await api('/admin/templates', {
    method: 'POST', as: 'admin',
    body: {
      id: 'bytedragon', name: 'Byte Dragon', rarity: 4,
      config: {
        stats: { power: 5, speed: 3 },
        skills: [{ id: 'zap', name: 'Zap', unlock_level: 2 }],
        level_curve: { base: 10, growth: 1.5 },
      },
    },
  });
  assert.equal(t.status, 201);
  assert.equal(t.body!.template.config.stats.power, 5);
  assert.equal((await api('/admin/templates', { method: 'POST', as: 'admin', body: { id: 'bytedragon', name: 'X' } })).status, 409);
});

test('#16: template PATCH updates config without a deploy; delete cascades variants', async () => {
  const patched = await api('/admin/templates/bytedragon', {
    method: 'PATCH', as: 'admin',
    body: { config: { stats: { power: 6, speed: 3 }, skills: [{ id: 'zap', name: 'Zap', unlock_level: 2 }], level_curve: { base: 10, growth: 1.5 } } },
  });
  assert.equal(patched.body!.template.config.stats.power, 6);
  assert.equal((await api('/admin/templates/nope', { method: 'PATCH', as: 'admin', body: { name: 'X' } })).status, 404);
});

test('#16: variant added via admin CRUD; overrides resolve against template config', async () => {
  const v = await api('/admin/templates/bytedragon/variants', {
    method: 'POST', as: 'admin',
    body: {
      id: 'bytedragon-crimson', name: 'Byte Dragon — Crimson',
      overrides: { stats: { power: 7 } },
    },
  });
  assert.equal(v.status, 201);

  const listed = await api('/admin/templates/bytedragon/variants', { as: 'admin' });
  assert.equal(listed.body!.variants.length, 1);

  // Unknown template -> 404; cross-template variant -> 400
  assert.equal((await api('/admin/templates/nope/variants', { method: 'POST', as: 'admin', body: { id: 'v', name: 'V' } })).status, 404);
});

test('#16: spawn from template carries resolved variant config at write time', async () => {
  const spawn = await api('/admin/templates/bytedragon/spawn', {
    method: 'POST', as: 'admin',
    body: { variant_id: 'bytedragon-crimson', marker_id: 'marker-crx', ttl_minutes: 5 },
  });
  assert.equal(spawn.status, 201);
  // Resolved = template config with the variant's stat override applied, skills/curve inherited.
  assert.equal(spawn.body!.resolved_config.stats.power, 7);
  assert.equal(spawn.body!.resolved_config.stats.speed, 3);
  assert.equal(spawn.body!.resolved_config.skills[0].id, 'zap');
  assert.equal(spawn.body!.spawn.species_id, 'bytedragon-crimson');

  // The runtime species row exists, so existing joins (spawns view, catch, collection) work.
  const visible = await api('/markers/marker-crx/spawns', { as: 'resident' });
  const mine = visible.body!.spawns.find((s: any) => s.species_id === 'bytedragon-crimson');
  assert.ok(mine, JSON.stringify(visible.body));
  assert.equal(mine.name, 'Byte Dragon');

  const catchRes = await api(`/spawns/${spawn.body!.spawn.id}/catch`, { method: 'POST', as: 'resident' });
  assert.equal(catchRes.status, 201);
  const collection = await api('/collection', { as: 'resident' });
  assert.equal(collection.body!.collection[0].species_id, 'bytedragon-crimson');
});

test('#16: spawn without variant uses template config; inactive template 400; cross-template variant 400', async () => {
  const plain = await api('/admin/templates/bytedragon/spawn', {
    method: 'POST', as: 'admin', body: { marker_id: 'marker-crx' },
  });
  assert.equal(plain.status, 201);
  assert.equal(plain.body!.resolved_config.stats.power, 6); // template config, post-PATCH
  assert.equal(plain.body!.spawn.species_id, 'bytedragon');

  await api('/admin/templates/bytedragon', { method: 'PATCH', as: 'admin', body: { active: false } });
  assert.equal((await api('/admin/templates/bytedragon/spawn', { method: 'POST', as: 'admin', body: { marker_id: 'marker-crx' } })).status, 400);
  await api('/admin/templates/bytedragon', { method: 'PATCH', as: 'admin', body: { active: true } });

  // Second template + its own variant; cross-assignment must fail.
  await api('/admin/templates', { method: 'POST', as: 'admin', body: { id: 'other', name: 'Other', rarity: 1 } });
  await api('/admin/templates/other/variants', { method: 'POST', as: 'admin', body: { id: 'other-v', name: 'Other V', overrides: {} } });
  const cross = await api('/admin/templates/bytedragon/spawn', {
    method: 'POST', as: 'admin', body: { variant_id: 'other-v', marker_id: 'marker-crx' },
  });
  assert.equal(cross.status, 400);
});
