// Rate limiter: per-user token bucket on value-moving endpoints (auth, catch, hint view, vote/report).
// Unit tests — no DB needed for the limiter itself.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { createRateLimiter } = await import('../src/rateLimit.js');

test('allows requests up to the limit, then 429', () => {
  const limiter = createRateLimiter({ limit: 3, windowMs: 60_000 });
  const key = 'user:1';
  assert.equal(limiter.check(key), true);
  assert.equal(limiter.check(key), true);
  assert.equal(limiter.check(key), true);
  assert.equal(limiter.check(key), false, '4th request in window must be rejected');
});

test('different keys have independent buckets', () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
  assert.equal(limiter.check('user:1'), true);
  assert.equal(limiter.check('user:2'), true);
  assert.equal(limiter.check('user:1'), false);
  assert.equal(limiter.check('user:2'), false);
});

test('bucket refills after the window', async () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 20 });
  assert.equal(limiter.check('user:1'), true);
  assert.equal(limiter.check('user:1'), false);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(limiter.check('user:1'), true, 'after window the bucket refills');
});
