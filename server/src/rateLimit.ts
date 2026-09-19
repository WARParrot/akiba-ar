import type { NextFunction, Request, Response } from 'express';
import type { AuthedRequest } from './auth.js';

export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
}

export interface RateLimiter {
  /** Returns true when allowed, false when the window is exhausted. */
  check(key: string): boolean;
  /** Internal buckets, exposed for tests verifying bounded growth. */
  buckets: Map<string, { count: number; windowStart: number }>;
}

/**
 * Per-key fixed-window counter (not a token bucket: no partial refill, the whole
 * window resets at once). Keyed by user id when authenticated, IP otherwise.
 *
 * In-memory: resets on restart and is per-instance — sized for a single Coolify
 * instance, not a multi-replica deployment.
 *
 * Bounded memory: expired buckets are pruned lazily on check, and every
 * `pruneEvery` checks a full sweep drops all expired entries; a hard
 * `maxEntries` cap guards against unbounded growth between sweeps (rotating
 * IPs). At the cap, expired entries are evicted first; if everything is live,
 * the oldest entries are dropped (those keys re-enter with a fresh window).
 */
export function createFixedWindowLimiter({ limit, windowMs }: RateLimiterOptions): RateLimiter {
  const buckets = new Map<string, { count: number; windowStart: number }>();
  const maxEntries = 10_000;
  const pruneEvery = 1_000;
  let checks = 0;

  function prune(now: number): void {
    for (const [k, b] of buckets) {
      if (now - b.windowStart >= windowMs) buckets.delete(k);
    }
  }

  function evict(now: number): void {
    prune(now);
    while (buckets.size >= maxEntries) {
      // Map iteration is insertion-ordered: the first entry is the oldest.
      const oldest = buckets.keys().next();
      if (oldest.done) break;
      buckets.delete(oldest.value);
    }
  }

  return {
    /** Internal buckets, exposed for tests verifying bounded growth. */
    buckets,
    check(key: string): boolean {
      const now = Date.now();
      checks += 1;
      if (checks % pruneEvery === 0) prune(now);
      const bucket = buckets.get(key);
      if (!bucket || now - bucket.windowStart >= windowMs) {
        if (buckets.size >= maxEntries) evict(now);
        buckets.set(key, { count: 1, windowStart: now });
        return true;
      }
      if (bucket.count < limit) {
        bucket.count += 1;
        return true;
      }
      return false;
    },
  };
}

/** Express middleware: 429 with Retry-After when the window is exhausted. No body in the response. */
export function rateLimit(limiter: RateLimiter) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const uid = req.claims?.uid;
    const key = uid !== undefined ? `user:${uid}` : `ip:${req.ip ?? 'unknown'}`;
    if (!limiter.check(key)) {
      res.set('Retry-After', '60');
      res.status(429).end();
      return;
    }
    next();
  };
}
