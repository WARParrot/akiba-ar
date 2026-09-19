// Rate limiter: per-user fixed-window counter on value-moving endpoints (auth, catch, hint view, vote/report).
// Unit tests — no DB needed for the limiter itself.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { createFixedWindowLimiter } = await import('../src/rateLimit.js');

test('allows requests up to the limit, then 429', () => {
  const limiter = createFixedWindowLimiter({ limit: 3, windowMs: 60_000 });
  const key = 'user:1';
  assert.equal(limiter.check(key), true);
  assert.equal(limiter.check(key), true);
  assert.equal(limiter.check(key), true);
  assert.equal(limiter.check(key), false, '4th request in window must be rejected');
});

test('different keys have independent buckets', () => {
  const limiter = createFixedWindowLimiter({ limit: 1, windowMs: 60_000 });
  assert.equal(limiter.check('user:1'), true);
  assert.equal(limiter.check('user:2'), true);
  assert.equal(limiter.check('user:1'), false);
  assert.equal(limiter.check('user:2'), false);
});

test('bucket refills after the window', async () => {
  const limiter = createFixedWindowLimiter({ limit: 1, windowMs: 20 });
  assert.equal(limiter.check('user:1'), true);
  assert.equal(limiter.check('user:1'), false);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(limiter.check('user:1'), true, 'after window the bucket refills');
});

test('expired buckets are pruned, keeping the Map bounded', async () => {
  const { createFixedWindowLimiter } = await import('../src/rateLimit.js');
  // Drive the internal sweep via many distinct keys with a short window.
  const limiter = createFixedWindowLimiter({ limit: 1, windowMs: 10 });
  for (let i = 0; i < 500; i++) limiter.check(`ip:${i}`);
  await new Promise((r) => setTimeout(r, 20));
  // Fill the same limiter past pruneEvery so the sweep runs on expired entries.
  for (let i = 500; i < 1500; i++) limiter.check(`ip:${i}`);
  assert.ok(limiter.buckets.size < 1500, 'expired entries must be pruned');
});

test('hard entry cap prevents unbounded growth under IP rotation', () => {
  const limiter = createFixedWindowLimiter({ limit: 1, windowMs: 60_000 });
  for (let i = 0; i < 12_000; i++) limiter.check(`ip:${i}`);
  assert.ok(limiter.buckets.size <= 10_000, 'Map size must stay capped');
  // Fresh keys are still allowed at the cap.
  assert.equal(limiter.check('ip:new'), true);
});
