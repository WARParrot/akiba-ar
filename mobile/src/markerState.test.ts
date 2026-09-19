import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { addMarker, updateMarker } from './markerState';

test('marker results are additive and deduplicate repeated scans', () => {
  const marker = { markerId: 'a', hints: [], spawns: [] };
  assert.equal(addMarker([], 'a').length, 1);
  assert.deepEqual(addMarker([marker], 'a'), [marker]);
});

test('one marker can update without replacing other marker results', () => {
  const first = { markerId: 'a', hints: [], spawns: [] };
  const second = { markerId: 'b', hints: [], spawns: [] };
  assert.deepEqual(updateMarker([first, second], { ...first, hints: [{ id: 1 } as never] }), [{ ...first, hints: [{ id: 1 } as never] }, second]);
});
