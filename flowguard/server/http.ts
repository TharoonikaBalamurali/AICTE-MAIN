import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Db } from './db/index.ts';
import type { Role } from './workflow/stateMachine.ts';
import { TransitionError } from './workflow/stateMachine.ts';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export interface AuthUser {
  id: string;
  loginId: string;
  fullName: string;
  email: string;
  designation: string | null;
  roles: Role[];
  activeRole: Role;
  institutionIds: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      sessionTokenHash?: string;
    }
  }
}

export const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export function user(req: Request): AuthUser {
  if (!req.user) throw new HttpError(401, 'UNAUTHENTICATED', 'Please sign in.');
  return req.user;
}

export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    const u = req.user;
    if (!u) return next(new HttpError(401, 'UNAUTHENTICATED', 'Please sign in.'));
    if (!roles.includes(u.activeRole)) return next(new HttpError(403, 'FORBIDDEN', 'Your role is not permitted to perform this operation.'));
    next();
  };
}

export async function audit(
  db: Db,
  req: Request | null,
  action: string,
  entityType: string | null,
  entityId: string | null,
  details: Record<string, unknown> = {},
  institutionId: string | null = null,
) {
  await db.query(
    'INSERT INTO audit_log(actor_id, actor_role, action, entity_type, entity_id, institution_id, details, ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [req?.user?.id ?? null, req?.user?.activeRole ?? 'SYSTEM', action, entityType, entityId, institutionId, JSON.stringify(details), req?.ip ?? null],
  );
}

export function errorHandler(log: (msg: string, meta?: unknown) => void) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.code, message: err.message, details: err.details });
      return;
    }
    if (err instanceof TransitionError) {
      res.status(err.status).json({ error: 'INVALID_TRANSITION', message: err.message });
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({ error: 'INVALID_INPUT', message: 'The request contains invalid data.', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
      return;
    }
    const e = err as { code?: string; message?: string; type?: string };
    if (e?.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'FILE_TOO_LARGE', message: 'The file exceeds the maximum permitted size.' });
      return;
    }
    if (e?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'INVALID_JSON', message: 'Malformed JSON body.' });
      return;
    }
    // Exclusion-constraint violation: the database refused an overlapping EVC reservation (concurrent booking).
    if (e?.code === '23P01' || /evc_member_no_overlap/.test(e?.message ?? '')) {
      res.status(409).json({ error: 'MEMBER_SLOT_TAKEN', message: 'One or more selected officials were booked for an overlapping time in the meantime. Availability has changed — refresh and choose another official or slot.' });
      return;
    }
    log('unhandled_error', { path: req.path, method: req.method, message: e?.message, stack: (err as Error)?.stack });
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'An unexpected error occurred. It has been logged.' });
  };
}

/** Structured JSON logger. */
export function makeLogger(silent = false) {
  return (msg: string, meta?: unknown) => {
    // Silent mode (tests) still reports unexpected errors so failures are diagnosable.
    if (silent && msg !== 'unhandled_error') return;
    (silent ? process.stderr : process.stdout).write(`${JSON.stringify({ t: new Date().toISOString(), msg, ...(meta && typeof meta === 'object' ? meta : { meta }) })}\n`);
  };
}

/** Simple fixed-window in-memory rate limiter (per process). */
export function rateLimit(opts: { windowMs: number; max: number; key?: (req: Request) => string }): RequestHandler {
  const hits = new Map<string, { n: number; reset: number }>();
  return (req, res, next) => {
    const k = opts.key ? opts.key(req) : req.ip ?? 'unknown';
    const now = Date.now();
    const h = hits.get(k);
    if (!h || h.reset < now) hits.set(k, { n: 1, reset: now + opts.windowMs });
    else if (++h.n > opts.max) {
      res.setHeader('Retry-After', Math.ceil((h.reset - now) / 1000));
      res.status(429).json({ error: 'RATE_LIMITED', message: 'Too many requests. Please wait and try again.' });
      return;
    }
    next();
  };
}
