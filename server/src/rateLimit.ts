import type { NextFunction, Request, Response } from 'express';
import type { AuthedRequest } from './auth.js';

export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
}

export interface RateLimiter {
  /** Returns true when allowed, false when the bucket is empty. */
  check(key: string): boolean;
}

/** Per-key token bucket. Keyed by user id when authenticated, IP otherwise. */
export function createRateLimiter({ limit, windowMs }: RateLimiterOptions): RateLimiter {
  const buckets = new Map<string, { count: number; windowStart: number }>();
  return {
    check(key: string): boolean {
      const now = Date.now();
      const bucket = buckets.get(key);
      if (!bucket || now - bucket.windowStart >= windowMs) {
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

/** Express middleware: 429 with Retry-After when the bucket is empty. No body in the response. */
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
