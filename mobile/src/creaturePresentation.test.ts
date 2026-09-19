import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { creatureAppearance, creatureLabel } from './creaturePresentation';

test('variant label and appearance are data-driven and legacy-safe', () => {
  assert.equal(creatureLabel({ name: 'Byte Dragon', variant_name: 'Crimson' }), 'Byte Dragon — Crimson');
  assert.equal(creatureLabel({ name: 'Byte Dragon', variant_name: 'Byte Dragon — Crimson' }), 'Byte Dragon — Crimson');
  assert.equal(creatureLabel({ name: 'Byte Dragon', variant_name: null }), 'Byte Dragon');
  assert.deepEqual(creatureAppearance({ appearance: { emoji: 'fire' } }), { emoji: 'fire' });
  assert.deepEqual(creatureAppearance({}), {});
});
