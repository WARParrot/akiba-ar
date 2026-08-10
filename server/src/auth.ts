import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { JwtClaims, Role } from './types.js';

const SECRET = process.env.JWT_SECRET ?? '';
if (!SECRET) throw new Error('JWT_SECRET is required');

export function sign(claims: JwtClaims): string {
  return jwt.sign(claims, SECRET, { expiresIn: '30d' });
}

export interface AuthedRequest extends Request {
  claims?: JwtClaims;
  onsite?: boolean;
}

/**
 * Onsite = request arrived at the in-space local server. The client can lie about SSID,
 * so trust only the server it reached: LOCAL_SERVER=1 is set on the box inside Akiba-Net.
 * ponytail: single env flag; per-AP/subnet checks if the space ever runs more than one segment.
 */
export function onsite(): boolean {
  return process.env.LOCAL_SERVER === '1';
}

export function authenticate(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  try {
    req.claims = jwt.verify(token, SECRET) as JwtClaims;
    req.onsite = onsite();
    next();
  } catch {
    res.status(401).json({ error: 'invalid token' });
  }
}

export function requireRole(...roles: Role[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.claims || !roles.includes(req.claims.role)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    next();
  };
}

export function requireOnsite(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!onsite()) {
    res.status(403).json({ error: 'onsite_only', message: 'Come to the Hackerspace to unlock this.' });
    return;
  }
  next();
}
