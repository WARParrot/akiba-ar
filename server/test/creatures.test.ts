// Unit tests for variant resolution (#16). Run: npx tsx --test test/creatures.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { resolveVariant } = await import('../src/creatures.js');

const templateConfig = {
  stats: { power: 5, speed: 3 },
  skills: [{ id: 'zap', name: 'Zap', unlock_level: 2 }],
  level_curve: { base: 10, growth: 1.5 },
};

test('no overrides -> template config unchanged', () => {
  assert.deepEqual(resolveVariant(templateConfig, {}), templateConfig);
});

test('stat override replaces the key, keeps sibling stats', () => {
  const r = resolveVariant(templateConfig, { stats: { power: 7 } });
  assert.equal(r.stats!.power, 7);
  assert.equal(r.stats!.speed, 3);
  assert.deepEqual(r.skills, templateConfig.skills);
  assert.deepEqual(r.level_curve, templateConfig.level_curve);
});

test('skills override replaces the whole section', () => {
  const skills = [{ id: 'frost', name: 'Frost', unlock_level: 3 }];
  const r = resolveVariant(templateConfig, { skills });
  assert.deepEqual(r.skills, skills);
});

test('level_curve override replaces the section', () => {
  const curve = { base: 20, growth: 2 };
  const r = resolveVariant(templateConfig, { level_curve: curve });
  assert.deepEqual(r.level_curve, curve);
  assert.deepEqual(r.stats, templateConfig.stats);
});

test('override stats merge into empty template stats', () => {
  const r = resolveVariant({}, { stats: { power: 1 } });
  assert.deepEqual(r.stats, { power: 1 });
});

test('unknown top-level object sections merge key-by-key', () => {
  const r = resolveVariant({ looks: { color: 'red', size: 2 } } as any, { looks: { color: 'blue' } } as any);
  assert.deepEqual(r.looks, { color: 'blue', size: 2 });
});

test('template config is never mutated', () => {
  const snapshot = JSON.parse(JSON.stringify(templateConfig));
  resolveVariant(templateConfig, { stats: { power: 99 } });
  assert.deepEqual(templateConfig, snapshot);
});
